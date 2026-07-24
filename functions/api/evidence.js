import { queryEvidencePacket, d1Binding } from "./_d1_repository.mjs";
import { json } from "./_util.js";
import { normalizeWorkbenchTicker } from "./_workbench_settings.mjs";

function authorized(request, env) {
  const expected = String(env?.EVIDENCE_READ_TOKEN || "");
  if (!expected) return true;
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim()
    || request.headers.get("x-evidence-token") || "";
  return token === expected;
}

function parseQuery(request) {
  const params = new URL(request.url).searchParams;
  let symbol;
  try {
    symbol = normalizeWorkbenchTicker(params.get("symbol") || "");
  } catch {
    throw new Error("无效的 symbol 参数");
  }
  const rawAsOf = params.get("asOf");
  const asOf = rawAsOf ? new Date(rawAsOf) : null;
  if (asOf && Number.isNaN(asOf.valueOf())) throw new Error("无效的 asOf 参数");
  const depth = (params.get("depth") || "summary").toLowerCase();
  if (!["summary", "full"].includes(depth)) throw new Error("无效的 depth 参数");
  return { symbol, asOf: asOf?.toISOString() || null, depth };
}

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) return json({ status: "unavailable", error: "UNAUTHORIZED" }, 401);
  let query;
  try {
    query = parseQuery(request);
  } catch (error) {
    return json({ status: "unavailable", error: error.message }, 400);
  }
  const db = d1Binding(env);
  if (!db) return json({ status: "unavailable", asOf: null, data: null, sources: [] });
  try {
    const row = await queryEvidencePacket(db, query);
    if (!row) return json({ status: "unavailable", asOf: null, data: null, sources: [] });
    const packet = JSON.parse(row.packet_json);
    const data = query.depth === "full"
      ? packet
      : {
        ...packet,
        bars: [],
        news: [],
      };
    return json({
      status: packet.status || row.status || "degraded",
      asOf: packet.asOf || row.as_of,
      data,
      sources: Array.isArray(packet.sources) ? packet.sources : [],
    }, 200, { "cache-control": "no-store" });
  } catch {
    return json({ status: "unavailable", asOf: null, data: null, sources: [] });
  }
}
