import assert from "node:assert/strict";
import test from "node:test";

const contractsUrl = new URL(
  "../workers/monitor/src/providers/contracts.mjs",
  import.meta.url,
);

test("maps supported Workbench symbols for every provider", async () => {
  const { mapProviderSymbol, normalizeMarketRequest } = await import(contractsUrl);

  assert.deepEqual(normalizeMarketRequest({
    symbol: "515880.sh",
    market: "CN",
    timeframe: "5m",
  }), {
    symbol: "515880.SS",
    market: "CN",
    timeframe: "5m",
    limit: 320,
  });
  assert.deepEqual(normalizeMarketRequest({
    symbol: "ORCL",
    market: "US",
    timeframe: "1d",
    limit: 1500,
  }), {
    symbol: "ORCL",
    market: "US",
    timeframe: "1d",
    limit: 1500,
  });
  assert.deepEqual(normalizeMarketRequest({
    symbol: "03887",
    market: "HK",
    timeframe: "1d",
    limit: 1500,
  }), {
    symbol: "3887.HK",
    market: "HK",
    timeframe: "1d",
    limit: 1500,
  });
  assert.equal(mapProviderSymbol("tencent", "515880.SS"), "sh515880");
  assert.equal(mapProviderSymbol("eastmoney", "515880.SS"), "1.515880");
  assert.equal(mapProviderSymbol("tencent", "512480.SS"), "sh512480");
  assert.equal(mapProviderSymbol("tencent-us", "NVDA"), "usNVDA");
  assert.equal(mapProviderSymbol("tencent-us", "ORCL"), "usORCL");
  assert.equal(mapProviderSymbol("eastmoney-us", "NVDA"), "105.NVDA");
  assert.equal(mapProviderSymbol("eastmoney-us", "ORCL"), "106.ORCL");
  assert.equal(mapProviderSymbol("eastmoney", "159995.SZ"), "0.159995");
  assert.equal(mapProviderSymbol("yahoo", "159995.SZ"), "159995.SZ");
  assert.equal(mapProviderSymbol("yahoo", "NVDA"), "NVDA");
  assert.equal(mapProviderSymbol("alphavantage", "BRK.B"), "BRK-B");
  assert.equal(mapProviderSymbol("stooq", "NVDA"), "nvda.us");
  assert.equal(mapProviderSymbol("yahoo", "03887"), "3887.HK");
});

test("rejects symbols, market mismatches, and timeframes outside the Workbench contract", async () => {
  const { ProviderError, normalizeMarketRequest } = await import(contractsUrl);

  for (const request of [
    { symbol: "BTC-USD", market: "US", timeframe: "5m" },
    { symbol: "515880.SS", market: "US", timeframe: "5m" },
    { symbol: "NVDA", market: "CN", timeframe: "5m" },
    { symbol: "NVDA", market: "US", timeframe: "1h" },
    { symbol: "3887.HK", market: "US", timeframe: "1d" },
  ]) {
    assert.throws(
      () => normalizeMarketRequest(request),
      (error) => error instanceof ProviderError && error.code === "INVALID_REQUEST",
    );
  }
});

test("normalizes valid OHLCV bars with stable metadata and rejects malformed data", async () => {
  const { ProviderError, normalizeBar } = await import(contractsUrl);
  const fetchedAt = "2026-07-23T02:05:00.000Z";
  const input = {
    timestamp: "2026-07-23T02:00:00.000Z",
    open: "10",
    high: 12,
    low: 9,
    close: "11",
    volume: "1000",
  };

  assert.deepEqual(normalizeBar(input, {
    symbol: "515880.SS",
    timeframe: "5m",
    source: "tencent",
    fetchedAt,
    now: new Date(fetchedAt),
    freshnessThresholdMs: 10 * 60 * 1000,
  }), {
    symbol: "515880.SS",
    timeframe: "5m",
    timestamp: "2026-07-23T02:00:00.000Z",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1000,
    source: "tencent",
    asOf: "2026-07-23T02:00:00.000Z",
    fetchedAt,
    freshness: "fresh",
    adjustment: "none",
    quality: "good",
  });

  for (const bad of [
    { ...input, timestamp: "not-a-date" },
    { ...input, open: Number.NaN },
    { ...input, high: 8 },
    { ...input, low: 13 },
    { ...input, volume: -1 },
  ]) {
    assert.throws(
      () => normalizeBar(bad, {
        symbol: "515880.SS",
        timeframe: "5m",
        source: "tencent",
        fetchedAt,
        now: new Date(fetchedAt),
      }),
      (error) => error instanceof ProviderError && error.code === "MALFORMED_DATA",
    );
  }
});

test("freshness uses a configurable intraday threshold and never labels old data fresh", async () => {
  const { calculateFreshness } = await import(contractsUrl);
  const now = new Date("2026-07-23T02:20:00.000Z");

  assert.equal(
    calculateFreshness("2026-07-23T02:11:00.000Z", now, 10 * 60 * 1000),
    "fresh",
  );
  assert.equal(
    calculateFreshness("2026-07-23T02:09:59.999Z", now, 10 * 60 * 1000),
    "stale",
  );
  assert.equal(calculateFreshness("invalid", now, 10 * 60 * 1000), "stale");
});
