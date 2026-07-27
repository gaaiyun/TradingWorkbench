import { createAdapters } from "./adapters.mjs";
import { normalizeMarketRequest, ProviderError } from "./contracts.mjs";
import {
  circuitIsOpen,
  readSourceHealth,
  recordSourceFailure,
  recordSourceSuccess,
} from "./health.mjs";

function providerMetadata({
  authorityTier = "discovery",
  transportTier = "best-effort-http",
  usageScope = "market-data",
  limits = {},
} = {}) {
  return Object.freeze({
    authorityTier,
    transportTier,
    usageScope,
    limits: Object.freeze({ timeoutMs: 8_000, ...limits }),
  });
}

export const PROVIDER_METADATA = Object.freeze({
  tencent: providerMetadata(),
  eastmoney: providerMetadata(),
  "eastmoney-us": providerMetadata(),
  "tencent-us": providerMetadata(),
  yahoo: providerMetadata(),
  alphavantage: providerMetadata({
    transportTier: "licensed-api",
    usageScope: "market-data-by-api-key",
  }),
  stooq: providerMetadata(),
  "gov-policy-library": providerMetadata({
    authorityTier: "evidence",
    transportTier: "official-json",
    usageScope: "cn-government-policy-library",
    limits: { maxResponseBytes: 262_144, maxItems: 8 },
  }),
  "sse-fund-announcements": providerMetadata({
    authorityTier: "evidence",
    transportTier: "official-jsonp",
    usageScope: "cn-etf-announcements",
    limits: { maxResponseBytes: 262_144, maxItems: 8 },
  }),
  "hashkey-ir": providerMetadata({
    authorityTier: "evidence",
    transportTier: "official-web",
    usageScope: "issuer-announcements",
    limits: { maxResponseBytes: 262_144, maxItems: 8 },
  }),
  "sec-edgar-submissions": providerMetadata({
    authorityTier: "evidence",
    transportTier: "official-json",
    usageScope: "issuer-filings",
    limits: {
      maxResponseBytes: 524_288,
      maxItems: 8,
      maxScannedItems: 200,
    },
  }),
  "federal-reserve-rss": providerMetadata({
    authorityTier: "evidence",
    transportTier: "official-rss",
    usageScope: "us-monetary-policy",
    limits: { maxResponseBytes: 131_072, maxItems: 8 },
  }),
});

export function getProviderMetadata(source) {
  return PROVIDER_METADATA[String(source || "")] ?? null;
}

function providerOrder(request, apiKey) {
  if (request.market === "CN") {
    return request.timeframe === "1d"
      ? ["eastmoney", "tencent", "yahoo"]
      : ["tencent", "eastmoney", "yahoo"];
  }
  if (request.market === "HK") return ["yahoo"];
  const providers = request.timeframe === "1d"
    ? ["yahoo", "eastmoney-us", "tencent-us"]
    : ["yahoo"];
  if (apiKey) providers.push("alphavantage");
  if (request.timeframe === "1d") providers.push("stooq");
  return providers;
}

function quoteFromBar(bar) {
  return {
    symbol: bar.symbol,
    timestamp: bar.timestamp,
    price: bar.close,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    volume: bar.volume,
    source: bar.source,
    asOf: bar.asOf,
    fetchedAt: bar.fetchedAt,
    freshness: bar.freshness,
    adjustment: bar.adjustment,
    quality: bar.quality,
  };
}

function errorCode(error) {
  return error instanceof ProviderError ? error.code : "PROVIDER_ERROR";
}

export function createProviderRegistry(options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiKey = options.env?.ALPHA_VANTAGE_API_KEY;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const now = options.now ?? (() => new Date());
  const adapters = createAdapters({ fetch: fetcher, apiKey, timeoutMs });

  return {
    providerMetadata: PROVIDER_METADATA,
    getProviderMetadata,
    async fetchMarketData(rawRequest) {
      const marketRequest = normalizeMarketRequest(rawRequest);
      const requestedAt = now();
      const fetchedAt = requestedAt.toISOString();
      const freshnessThresholdMs = marketRequest.timeframe === "5m"
        ? (options.intradayFreshnessMs ?? 10 * 60 * 1000)
        : (options.dailyFreshnessMs ?? 36 * 60 * 60 * 1000);
      const sources = [];
      const order = providerOrder(marketRequest, apiKey);

      for (let index = 0; index < order.length; index += 1) {
        const source = order[index];
        const health = await readSourceHealth(options.db, source, requestedAt).catch(() => null);
        if (!options.ignoreCircuitBreaker && circuitIsOpen(health, requestedAt)) {
          sources.push({ source, status: "skipped", reason: "CIRCUIT_OPEN" });
          continue;
        }
        try {
          const bars = await adapters[source](marketRequest, {
            fetchedAt,
            now: requestedAt,
            freshnessThresholdMs,
          });
          bars.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
          const quote = quoteFromBar(bars.at(-1));
          const status = quote.freshness === "stale"
            ? "stale"
            : index === 0 ? "ok" : "degraded";
          await recordSourceSuccess(options.db, source, {
            status,
            asOf: quote.asOf,
            fetchedAt: quote.fetchedAt,
            freshness: quote.freshness,
            adjustment: quote.adjustment,
            quality: quote.quality,
          }, requestedAt).catch(() => {});
          sources.push({ source, status: "success", reason: null });
          return {
            status,
            symbol: marketRequest.symbol,
            market: marketRequest.market,
            timeframe: marketRequest.timeframe,
            source,
            bars,
            quote,
            sources,
            fetchedAt,
          };
        } catch (error) {
          const reason = errorCode(error);
          await recordSourceFailure(
            options.db,
            source,
            reason,
            requestedAt,
            {
              failureThreshold: options.failureThreshold,
              pauseMs: options.pauseMs,
            },
          ).catch(() => {});
          sources.push({ source, status: "failed", reason });
        }
      }

      return {
        status: "unavailable",
        symbol: marketRequest.symbol,
        market: marketRequest.market,
        timeframe: marketRequest.timeframe,
        source: null,
        bars: [],
        quote: null,
        sources,
        fetchedAt,
      };
    },
  };
}
