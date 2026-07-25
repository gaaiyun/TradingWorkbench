import {
  d1Binding,
  queryEvidencePacket,
  upsertEvidenceBundle,
} from "./_d1_repository.mjs";
import {
  json,
  readJsonBody,
  RequestBodyTooLargeError,
} from "./_util.js";
import { normalizeWorkbenchTicker } from "./_workbench_settings.mjs";

const PACKET_STATUSES = new Set(["ok", "degraded", "unavailable", "data_validation_failed"]);
const ANALYSIS_STATUSES = new Set(["rated", "not_rated", "insufficient_evidence", "data_validation_failed"]);
const AUDIT_STATUSES = new Set(["verified", "legacy_unverified", "invalidated"]);
const MAX_EVIDENCE_BYTES = 1024 * 1024;

function readAuthorized(request, env) {
  const expected = String(env?.EVIDENCE_READ_TOKEN || "");
  if (!expected) return true;
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim()
    || request.headers.get("x-evidence-token") || "";
  return token === expected;
}

function writeAuthorized(request, env) {
  const expected = String(env?.EVIDENCE_WRITE_TOKEN || "");
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  return header.replace(/^Bearer\s+/i, "").trim() === expected;
}

function validIso(value) {
  if (typeof value !== "string" || !value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf());
}

function validateBundle(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("请求体无效");
  }
  const packet = body.packet;
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new Error("Evidence Packet 缺失");
  }
  if (packet.schemaVersion !== "EvidencePacketV1") {
    throw new Error("Evidence Packet 版本无效");
  }
  if (!PACKET_STATUSES.has(packet.status) || typeof packet.canRate !== "boolean") {
    throw new Error("Evidence Packet 状态无效");
  }
  if (!validIso(packet.asOf) || !validIso(packet.generatedAt)) {
    throw new Error("Evidence Packet 时间无效");
  }
  if (new Date(packet.asOf).valueOf() > Date.now() + 10 * 60 * 1000) {
    throw new Error("Evidence Packet 截止时间不能位于未来");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(packet.contentHash || ""))) {
    throw new Error("Evidence Packet 哈希无效");
  }
  if (!packet.instrument || typeof packet.instrument !== "object") {
    throw new Error("Evidence Packet 标的身份缺失");
  }
  let symbol;
  try {
    symbol = normalizeWorkbenchTicker(packet.instrument.symbol || "");
  } catch {
    throw new Error("Evidence Packet 标的无效");
  }
  if (symbol !== packet.instrument.symbol) {
    throw new Error("Evidence Packet 标的未规范化");
  }
  for (const field of ["bars", "corporateActions", "news", "sources"]) {
    if (!Array.isArray(packet[field])) throw new Error(`Evidence Packet ${field} 无效`);
  }
  if (!packet.integrity || !Array.isArray(packet.integrity.errors) || !Array.isArray(packet.integrity.warnings)) {
    throw new Error("Evidence Packet 完整性状态无效");
  }
  if (packet.status === "data_validation_failed" && packet.canRate) {
    throw new Error("验证失败的 Evidence Packet 不能评级");
  }

  const manifest = body.manifest ?? null;
  const report = body.report ?? null;
  if ((manifest && !report) || (report && !manifest)) {
    throw new Error("报告路径与 Manifest 必须同时提供");
  }
  if (manifest) {
    if (
      typeof manifest !== "object"
      || manifest.schemaVersion !== 1
      || normalizeWorkbenchTicker(manifest.ticker || "") !== symbol
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(manifest.tradeDate || ""))
      || packet.asOf.slice(0, 10) !== manifest.tradeDate
      || !validIso(manifest.generatedAt)
      || !ANALYSIS_STATUSES.has(manifest.analysisStatus)
      || !AUDIT_STATUSES.has(manifest.auditStatus)
      || manifest.evidence?.contentHash !== packet.contentHash
    ) {
      throw new Error("Report Manifest 无效");
    }
    const escaped = symbol.replaceAll(".", "\\.");
    const reportPattern = new RegExp(
      `^reports/${escaped}/${manifest.tradeDate}(?:-v(?:[2-9]|[1-9]\\d+))?/complete_report\\.md$`,
    );
    if (typeof report !== "string" || !reportPattern.test(report)) {
      throw new Error("报告路径无效");
    }
  }
  return { packet, manifest, report };
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
  if (!readAuthorized(request, env)) return json({ status: "unavailable", error: "UNAUTHORIZED" }, 401);
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

export async function onRequestPost({ request, env }) {
  if (!env?.EVIDENCE_WRITE_TOKEN) {
    return json({ status: "unavailable", error: "WRITE_NOT_CONFIGURED" }, 503);
  }
  if (!writeAuthorized(request, env)) {
    return json({ status: "unavailable", error: "UNAUTHORIZED" }, 401);
  }
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: MAX_EVIDENCE_BYTES });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ status: "unavailable", error: "REQUEST_TOO_LARGE" }, 413);
    }
    throw error;
  }
  let bundle;
  try {
    bundle = validateBundle(body);
  } catch (error) {
    return json({ status: "unavailable", error: error.message }, 400);
  }
  const db = d1Binding(env);
  if (!db) return json({ status: "unavailable", error: "D1_UNAVAILABLE" }, 503);
  const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await upsertEvidenceBundle(db, { ...bundle, expiresAt });
    return json({
      status: "ok",
      asOf: bundle.packet.asOf,
      data: {
        symbol: bundle.packet.instrument.symbol,
        contentHash: bundle.packet.contentHash,
        report: bundle.report,
      },
      sources: [],
    }, 201, { "cache-control": "no-store" });
  } catch {
    return json({ status: "unavailable", error: "D1_WRITE_FAILED" }, 503);
  }
}
