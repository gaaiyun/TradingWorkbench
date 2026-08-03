import { pathToFileURL } from "node:url";

const SYMBOLS = Object.freeze(["515880.SS", "512480.SS", "159995.SZ"]);
const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function verifyTradeDates(rows, marketRows) {
  const dates = rows.map(({ trade_date: tradeDate }) => String(tradeDate || ""));
  if (dates.length < 60 || dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error("FUND_FLOW_TRADE_DATE_MISSING");
  }
  const weekend = dates.filter((date) => [0, 6].includes(weekday(date)));
  if (weekend.length) throw new Error(`FUND_FLOW_WEEKEND_DATE:${weekend.slice(0, 3).join(",")}`);
  const fridayCount = dates.filter((date) => weekday(date) === 5).length;
  if (fridayCount === 0) throw new Error("FUND_FLOW_FRIDAY_MISSING");

  const marketDates = new Set(marketRows.map(({ ts, as_of: asOf }) => (
    SHANGHAI_DATE.format(new Date(ts || asOf))
  )));
  const marketRange = [...marketDates].sort();
  if (marketRange.length < 60) throw new Error("MARKET_DAILY_HISTORY_INSUFFICIENT");
  const [marketStart] = marketRange;
  const marketEnd = marketRange.at(-1);
  const comparable = dates.filter((date) => date >= marketStart && date <= marketEnd);
  const missing = comparable.filter((date) => !marketDates.has(date));
  if (missing.length) throw new Error(`FUND_FLOW_NOT_MARKET_DAY:${missing.slice(0, 3).join(",")}`);
  return {
    rows: dates.length,
    first: [...dates].sort()[0],
    last: [...dates].sort().at(-1),
    fridayCount,
    weekendCount: weekend.length,
    comparableCount: comparable.length,
    missingMarketDays: missing.length,
  };
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}:${url.pathname}`);
  return response.json();
}

export async function verifyProduction(baseUrl) {
  const base = new URL(baseUrl);
  const summaries = [];
  for (const symbol of SYMBOLS) {
    const flowUrl = new URL("/api/flows", base);
    flowUrl.search = new URLSearchParams({
      symbol,
      type: "margin_net_buy",
      period: "1d",
      from: "2024-01-01",
      limit: "2000",
    });
    const marketUrl = new URL("/api/market", base);
    marketUrl.search = new URLSearchParams({ symbol, timeframe: "1d", limit: "1500" });
    const [flows, market] = await Promise.all([getJson(flowUrl), getJson(marketUrl)]);
    if (
      !["ok", "stale", "degraded"].includes(flows.status)
      || !["ok", "stale", "degraded"].includes(market.status)
    ) {
      throw new Error(`PRODUCTION_DATA_UNAVAILABLE:${symbol}:${flows.status}:${market.status}`);
    }
    summaries.push({ symbol, ...verifyTradeDates(flows.data || [], market.data || []) });
  }
  return summaries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = process.env.WORKBENCH_BASE_URL || "https://tradingagents-board.pages.dev";
  const result = await verifyProduction(baseUrl);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
