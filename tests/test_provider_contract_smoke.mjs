import assert from "node:assert/strict";
import test from "node:test";

import { createAdapters } from "../workers/monitor/src/providers/adapters.mjs";
import { ProviderError } from "../workers/monitor/src/providers/contracts.mjs";

const runLive = process.env.PROVIDER_CONTRACT_SMOKE === "1";

test("live free-provider contracts still match the Worker adapters", {
  skip: runLive ? false : "set PROVIDER_CONTRACT_SMOKE=1 to call live providers",
  timeout: 60_000,
}, async () => {
  const now = new Date();
  const adapters = createAdapters({
    fetch: globalThis.fetch,
    timeoutMs: 15_000,
  });
  const runtime = {
    fetchedAt: now.toISOString(),
    now,
    freshnessThresholdMs: 36 * 60 * 60 * 1000,
  };

  const [tencent5m, tencentDaily, eastmoney, yahoo, eastmoneyUs5m, yahooUs5m] = await Promise.all([
    adapters.tencent(
      { symbol: "515880.SS", market: "CN", timeframe: "5m" },
      runtime,
    ),
    adapters.tencent(
      { symbol: "512480.SS", market: "CN", timeframe: "1d" },
      runtime,
    ),
    adapters.eastmoney(
      { symbol: "159995.SZ", market: "CN", timeframe: "5m" },
      runtime,
    ),
    adapters.yahoo(
      { symbol: "515880.SS", market: "CN", timeframe: "5m" },
      runtime,
    ),
    adapters["eastmoney-us"](
      { symbol: "NVDA", market: "US", timeframe: "5m" },
      runtime,
    ),
    adapters.yahoo(
      { symbol: "SOXX", market: "US", timeframe: "5m" },
      runtime,
    ),
  ]);
  for (const bars of [tencent5m, tencentDaily, eastmoney, yahoo, eastmoneyUs5m, yahooUs5m]) {
    assert.ok(bars.length > 0);
    assert.ok(Number.isFinite(bars.at(-1).close));
  }

  try {
    const stooq = await adapters.stooq(
      { symbol: "NVDA", market: "US", timeframe: "1d" },
      runtime,
    );
    assert.ok(stooq.length > 0);
  } catch (error) {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "UPSTREAM_CHALLENGE");
  }
});
