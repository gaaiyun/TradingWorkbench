import { json, proxyRaw } from "./_util.js";

const MARKETS = new Set(["CN", "HK", "US"]);
const SYMBOL = /^[A-Z0-9][A-Z0-9.^_-]{0,31}$/;

function fail(message) {
  return json({ status: "unavailable", error: message, data: [], sources: [] }, 400);
}

export async function onRequestGet({ request } = {}) {
  const params = new URL(request?.url || "https://workbench.invalid/api/universe").searchParams;
  for (const key of params.keys()) {
    if (!["summary", "market", "symbol", "limit"].includes(key) || params.getAll(key).length !== 1) {
      return fail(`无效的 ${key} 参数`);
    }
  }
  const summary = params.get("summary") === "1";
  if (params.has("summary") && !summary) return fail("无效的 summary 参数");
  const market = params.get("market")?.toUpperCase() || null;
  if (market && !MARKETS.has(market)) return fail("无效的 market 参数");
  const symbol = params.get("symbol")?.trim().toUpperCase() || null;
  if (symbol && !SYMBOL.test(symbol)) return fail("无效的 symbol 参数");
  const rawLimit = params.get("limit") || "100";
  if (!/^\d+$/.test(rawLimit)) return fail("无效的 limit 参数");
  const limit = Math.min(500, Math.max(1, Number(rawLimit)));

  const response = await proxyRaw("data/universe.json", { cacheSeconds: 300 });
  if (!response.ok) return response;
  let snapshot;
  try {
    snapshot = await response.json();
  } catch {
    return json({ status: "unavailable", error: "股票宇宙快照无效", data: [], sources: [] }, 502);
  }
  if (!snapshot || !Array.isArray(snapshot.instruments)) {
    return json({ status: "unavailable", error: "股票宇宙快照无效", data: [], sources: [] }, 502);
  }
  const matched = snapshot.instruments
    .filter((item) => !market || item.market === market)
    .filter((item) => !symbol || item.symbol === symbol);
  const data = summary ? [] : matched.slice(0, limit);
  return json({
    status: snapshot.status || "degraded",
    asOf: snapshot.generatedAt || null,
    data,
    sources: snapshot.sources || [],
    coverage: snapshot.coverage || {},
    totalMatched: matched.length,
  }, 200, { "cache-control": "public, max-age=300" });
}
