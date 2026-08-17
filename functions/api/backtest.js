import { runBacktest } from "./_backtest.mjs";
import { d1Binding, queryMarketBars } from "./_d1_repository.mjs";
import { json } from "./_util.js";

const SYMBOL = /^[A-Z0-9][A-Z0-9.^_-]{0,31}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STRATEGIES = new Set(["momentum20", "ma5x20"]);

function integer(params, name, fallback, min, max) {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`无效的 ${name} 参数`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`无效的 ${name} 参数`);
  return value;
}

function parse(request) {
  const params = new URL(request.url).searchParams;
  const allowed = new Set(["symbol", "profile", "strategy", "holdingDays", "costBps", "slippageBps", "limit"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error(`无效的 ${key} 参数`);
  }
  const symbol = params.get("symbol")?.trim().toUpperCase();
  const profile = params.get("profile")?.trim();
  const strategy = params.get("strategy") || "momentum20";
  if (!symbol || !SYMBOL.test(symbol)) throw new Error("无效的 symbol 参数");
  if (!profile || !PROFILE.test(profile)) throw new Error("无效的 profile 参数");
  if (!STRATEGIES.has(strategy)) throw new Error("无效的 strategy 参数");
  return {
    symbol,
    profile,
    strategy,
    holdingDays: integer(params, "holdingDays", 5, 1, 20),
    costBps: integer(params, "costBps", 3, 0, 100),
    slippageBps: integer(params, "slippageBps", 5, 0, 100),
    limit: integer(params, "limit", 650, 60, 1260),
  };
}

export async function onRequestGet({ request, env }) {
  let query;
  try {
    query = parse(request);
  } catch (error) {
    return json({ status: "unavailable", reason: error.message, data: [], sources: [] }, 400);
  }
  const db = d1Binding(env);
  if (!db) return json({ status: "unavailable", reason: "no_binding", data: [], sources: [] });
  try {
    const rows = await queryMarketBars(db, {
      symbol: query.symbol,
      profile: query.profile,
      timeframe: "1d",
      from: null,
      to: null,
      after: null,
      limit: query.limit * 6,
    });
    const result = runBacktest(rows, query);
    return json({ ...result, data: result.trades, sources: result.sources || [] }, 200, {
      "cache-control": "no-store",
    });
  } catch {
    return json({ status: "unavailable", reason: "query_error", data: [], sources: [] });
  }
}
