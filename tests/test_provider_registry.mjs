import assert from "node:assert/strict";
import test from "node:test";

const registryUrl = new URL(
  "../workers/monitor/src/providers/registry.mjs",
  import.meta.url,
);

function response(body, status = 200) {
  return new Response(body, { status });
}

function jsonResponse(value, status = 200) {
  return response(JSON.stringify(value), status);
}

function tencentFixture() {
  return {
    data: {
      sh515880: {
        m5: [
          ["202607231000", "10", "11", "12", "9", "1000"],
        ],
      },
    },
  };
}

function eastmoneyFixture() {
  return {
    data: {
      klines: ["2026-07-23 10:00,10,11,12,9,1000"],
    },
  };
}

function yahooFixture() {
  return {
    chart: {
      result: [{
        timestamp: [1784772000],
        indicators: {
          quote: [{
            open: [10],
            high: [12],
            low: [9],
            close: [11],
            volume: [1000],
          }],
        },
      }],
      error: null,
    },
  };
}

function alphaVantageFixture() {
  return {
    "Time Series (5min)": {
      "2026-07-22 22:00:00": {
        "1. open": "10",
        "2. high": "12",
        "3. low": "9",
        "4. close": "11",
        "5. volume": "1000",
      },
    },
  };
}

test("routes CN symbols through Tencent first and returns normalized bars and quote", async () => {
  const { createProviderRegistry } = await import(registryUrl);
  const urls = [];
  const registry = createProviderRegistry({
    fetch: async (url) => {
      urls.push(String(url));
      return jsonResponse(tencentFixture());
    },
    now: () => new Date("2026-07-23T02:05:00.000Z"),
  });

  const result = await registry.fetchMarketData({
    symbol: "515880.SS",
    market: "CN",
    timeframe: "5m",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.source, "tencent");
  assert.equal(result.bars.length, 1);
  assert.equal(result.quote.price, 11);
  for (const record of [...result.bars, result.quote]) {
    assert.equal(record.source, "tencent");
    assert.equal(record.asOf, "2026-07-23T02:00:00.000Z");
    assert.equal(record.fetchedAt, "2026-07-23T02:05:00.000Z");
    assert.equal(record.freshness, "fresh");
    assert.equal(record.adjustment, "none");
    assert.equal(record.quality, "good");
  }
  assert.equal(urls.length, 1);
  assert.match(urls[0], /ifzq\.gtimg\.cn/);
  assert.match(urls[0], /sh515880/);
  assert.doesNotMatch(urls[0], /qfq|hfq/);
  assert.deepEqual(result.sources, [
    { source: "tencent", status: "success", reason: null },
  ]);
});

test("falls back from Tencent to Eastmoney with a degraded status and stable reason", async () => {
  const { createProviderRegistry } = await import(registryUrl);
  const urls = [];
  const registry = createProviderRegistry({
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes("gtimg")) return response("private upstream body", 503);
      return jsonResponse(eastmoneyFixture());
    },
    now: () => new Date("2026-07-23T02:05:00.000Z"),
  });

  const result = await registry.fetchMarketData({
    symbol: "515880.SS",
    market: "CN",
    timeframe: "5m",
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.source, "eastmoney");
  assert.deepEqual(result.sources, [
    { source: "tencent", status: "failed", reason: "HTTP_ERROR" },
    { source: "eastmoney", status: "success", reason: null },
  ]);
  assert.match(urls[1], /eastmoney\.com/);
  assert.match(urls[1], /secid=1\.515880/);
  assert.doesNotMatch(JSON.stringify(result), /private upstream body/);
});

test("omits Alpha Vantage without a key and uses Stooq only as a US daily fallback", async () => {
  const { createProviderRegistry } = await import(registryUrl);
  const urls = [];
  const registry = createProviderRegistry({
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes("yahoo")) return response("", 500);
      return response([
        "Date,Open,High,Low,Close,Volume",
        "2026-07-23,10,12,9,11,1000",
      ].join("\n"));
    },
    env: {},
    now: () => new Date("2026-07-23T02:05:00.000Z"),
    dailyFreshnessMs: 24 * 60 * 60 * 1000,
  });

  const result = await registry.fetchMarketData({
    symbol: "NVDA",
    market: "US",
    timeframe: "1d",
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.source, "stooq");
  assert.deepEqual(result.sources.map(({ source }) => source), ["yahoo", "stooq"]);
  assert.equal(urls.some((url) => /alphavantage/i.test(url)), false);
  assert.match(urls[1], /stooq\.com/);
  assert.match(urls[1], /nvda\.us/);
});

test("includes Alpha Vantage between Yahoo and Stooq only when a key is configured", async () => {
  const { createProviderRegistry } = await import(registryUrl);
  const urls = [];
  const registry = createProviderRegistry({
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes("yahoo")) return response("", 500);
      return jsonResponse(alphaVantageFixture());
    },
    env: { ALPHA_VANTAGE_API_KEY: "test-secret-key" },
    now: () => new Date("2026-07-23T02:05:00.000Z"),
  });

  const result = await registry.fetchMarketData({
    symbol: "NVDA",
    market: "US",
    timeframe: "5m",
  });

  assert.equal(result.source, "alphavantage");
  assert.equal(result.bars[0].timestamp, "2026-07-23T02:00:00.000Z");
  assert.deepEqual(result.sources.map(({ source }) => source), ["yahoo", "alphavantage"]);
  assert.match(urls[1], /alphavantage\.co/);
  assert.doesNotMatch(JSON.stringify(result), /test-secret-key/);
});

test("returns unavailable for malformed, HTTP, and timeout failures without response details", async () => {
  const { createProviderRegistry } = await import(registryUrl);
  const registry = createProviderRegistry({
    fetch: async (url, init) => {
      const value = String(url);
      if (value.includes("gtimg")) return jsonResponse({ data: {} });
      if (value.includes("eastmoney")) return response("do-not-leak", 429);
      if (value.includes("yahoo")) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        });
      }
      throw new Error("unexpected provider");
    },
    now: () => new Date("2026-07-23T02:05:00.000Z"),
    timeoutMs: 5,
  });

  const result = await registry.fetchMarketData({
    symbol: "515880.SS",
    market: "CN",
    timeframe: "5m",
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.source, null);
  assert.deepEqual(result.bars, []);
  assert.equal(result.quote, null);
  assert.deepEqual(result.sources, [
    { source: "tencent", status: "failed", reason: "MALFORMED_DATA" },
    { source: "eastmoney", status: "failed", reason: "HTTP_ERROR" },
    { source: "yahoo", status: "failed", reason: "TIMEOUT" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak|AbortError|unexpected provider/);
});

test("marks successfully fetched old data stale instead of fresh", async () => {
  const { createProviderRegistry } = await import(registryUrl);
  const registry = createProviderRegistry({
    fetch: async () => jsonResponse(yahooFixture()),
    now: () => new Date("2026-07-23T03:00:00.000Z"),
    intradayFreshnessMs: 10 * 60 * 1000,
  });

  const result = await registry.fetchMarketData({
    symbol: "NVDA",
    market: "US",
    timeframe: "5m",
  });

  assert.equal(result.status, "stale");
  assert.equal(result.bars[0].freshness, "stale");
  assert.equal(result.quote.freshness, "stale");
});
