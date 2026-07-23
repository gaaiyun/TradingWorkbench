import { normalizeWorkbenchTicker } from "../../../../functions/api/_workbench_settings.mjs";

const TIMEFRAMES = new Set(["5m", "1d"]);
const CN_SUFFIXES = [".SS", ".SZ"];
const EASTMONEY_US_MARKETS = {
  SOXX: "105",
  SMH: "105",
  NVDA: "105",
  TSM: "106",
  AVGO: "105",
  AMD: "105",
  ASML: "105",
  ORCL: "106",
};

export class ProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProviderError";
    this.code = code;
  }
}

function invalidRequest() {
  throw new ProviderError("INVALID_REQUEST");
}

export function normalizeMarketRequest(request) {
  if (!request || typeof request !== "object") invalidRequest();
  let symbol;
  try {
    symbol = normalizeWorkbenchTicker(request.symbol);
  } catch {
    invalidRequest();
  }
  const inferredMarket = CN_SUFFIXES.some((suffix) => symbol.endsWith(suffix)) ? "CN" : "US";
  const market = typeof request.market === "string" ? request.market.toUpperCase() : inferredMarket;
  const limit = request.limit === undefined ? 320 : Number(request.limit);
  if (
    market !== inferredMarket
    || !TIMEFRAMES.has(request.timeframe)
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 2000
  ) invalidRequest();
  return { symbol, market, timeframe: request.timeframe, limit };
}

export function mapProviderSymbol(provider, rawSymbol) {
  let symbol;
  try {
    symbol = normalizeWorkbenchTicker(rawSymbol);
  } catch {
    invalidRequest();
  }
  const match = /^(\d{6})\.(SS|SZ)$/.exec(symbol);
  if (provider === "yahoo" || provider === "alphavantage") return symbol;
  if (provider === "tencent" && match) {
    return `${match[2] === "SS" ? "sh" : "sz"}${match[1]}`;
  }
  if (provider === "tencent-us" && !match) return `us${symbol}`;
  if (provider === "eastmoney-us" && EASTMONEY_US_MARKETS[symbol]) {
    return `${EASTMONEY_US_MARKETS[symbol]}.${symbol}`;
  }
  if (provider === "eastmoney" && match) {
    return `${match[2] === "SS" ? "1" : "0"}.${match[1]}`;
  }
  if (provider === "stooq" && !match) return `${symbol.toLowerCase()}.us`;
  invalidRequest();
}

function isoTimestamp(value) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) ? timestamp.toISOString() : null;
}

function finiteNumber(value) {
  if (value === null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function calculateFreshness(asOf, now = new Date(), thresholdMs = 10 * 60 * 1000) {
  const timestamp = new Date(asOf);
  const age = now.valueOf() - timestamp.valueOf();
  return Number.isFinite(age) && age >= 0 && age <= thresholdMs ? "fresh" : "stale";
}

export function normalizeBar(input, context) {
  const timestamp = isoTimestamp(input?.timestamp);
  const fetchedAt = isoTimestamp(context?.fetchedAt);
  const open = finiteNumber(input?.open);
  const high = finiteNumber(input?.high);
  const low = finiteNumber(input?.low);
  const close = finiteNumber(input?.close);
  const volume = finiteNumber(input?.volume);
  if (
    !timestamp ||
    !fetchedAt ||
    [open, high, low, close, volume].some((value) => value === null) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    volume < 0 ||
    high < Math.max(open, close, low) ||
    low > Math.min(open, close, high)
  ) {
    throw new ProviderError("MALFORMED_DATA");
  }
  return {
    symbol: context.symbol,
    timeframe: context.timeframe,
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    source: context.source,
    asOf: timestamp,
    fetchedAt,
    freshness: calculateFreshness(
      timestamp,
      context.now,
      context.freshnessThresholdMs,
    ),
    adjustment: context.adjustment ?? "none",
    quality: "good",
  };
}
