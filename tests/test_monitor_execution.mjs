import assert from "node:assert/strict";
import test from "node:test";

import { monitorSettings } from "./helpers/monitor_settings.mjs";

const collectorUrl = new URL(
  "../workers/monitor/src/collector.mjs",
  import.meta.url,
);
const dispatchUrl = new URL(
  "../workers/monitor/src/github-dispatch.mjs",
  import.meta.url,
);

function registryWith(outcomes, calls) {
  return {
    async fetchMarketData(request) {
      calls.push(request);
      const outcome = outcomes[request.symbol];
      if (outcome instanceof Error) throw outcome;
      if (outcome === "unavailable") {
        return {
          status: "unavailable",
          symbol: request.symbol,
          source: null,
          bars: [],
          sources: [{ source: "wire", status: "failed", reason: "UPSTREAM" }],
        };
      }
      return {
        status: outcome?.status ?? "ok",
        symbol: request.symbol,
        source: outcome?.source ?? "wire",
        bars: outcome?.bars ?? [{ symbol: request.symbol }],
        sources: [{ source: outcome?.source ?? "wire", status: "success", reason: null }],
      };
    },
  };
}

test("US close uses only US driver targets at 1d and persists returned bars", async () => {
  const { collectForTask } = await import(collectorUrl);
  const calls = [];
  const writes = [];
  const result = await collectForTask({
    taskType: "usCloseSnapshot",
    profile: monitorSettings().profiles[0],
    registry: registryWith({}, calls),
    writeBars: async (_db, payload) => writes.push(payload),
    db: {},
    now: new Date("2026-07-23T21:35:00.000Z"),
  });
  assert.deepEqual(calls, [{ symbol: "SPY", market: "US", timeframe: "1d" }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].profileId, "etf-main");
  assert.equal(result.status, "completed");
  assert.equal(result.written, 1);
});

test("intraday uses only CN core/comparison targets at 5m and keeps partial success", async () => {
  const { collectForTask } = await import(collectorUrl);
  const calls = [];
  const writes = [];
  const result = await collectForTask({
    taskType: "intradayCollect",
    profile: monitorSettings().profiles[0],
    registry: registryWith(
      { "159995.SZ": "unavailable" },
      calls,
    ),
    writeBars: async (_db, payload) => writes.push(payload),
    db: {},
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  assert.deepEqual(calls, [
    { symbol: "515880.SS", market: "CN", timeframe: "5m" },
    { symbol: "159995.SZ", market: "CN", timeframe: "5m" },
  ]);
  assert.equal(writes.length, 1);
  assert.equal(result.status, "degraded");
  assert.deepEqual(result.counts, { targets: 2, succeeded: 1, failed: 1 });
  assert.equal(result.sources.some((source) => source.reason === "UPSTREAM"), true);
});

test("collector isolates thrown provider errors and fails stably only when all targets fail", async () => {
  const { collectForTask } = await import(collectorUrl);
  const calls = [];
  const result = await collectForTask({
    taskType: "intradayCollect",
    profile: monitorSettings().profiles[0],
    registry: registryWith(
      {
        "515880.SS": new Error("secret upstream body"),
        "159995.SZ": "unavailable",
      },
      calls,
    ),
    writeBars: async () => assert.fail("no bars should be written"),
    db: {},
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "COLLECTION_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("secret upstream body"), false);
});

test("GitHub dispatch sends required inputs and treats only 204 as success", async () => {
  const { dispatchFullAnalysis } = await import(dispatchUrl);
  const requests = [];
  const result = await dispatchFullAnalysis({
    env: {
      GITHUB_DISPATCH_TOKEN: "super-secret-token",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_WORKFLOW_ID: "daily-analysis.yml",
    },
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 204 });
    },
    profile: monitorSettings().profiles[0],
    slotId: "slot-abc",
    scheduledFor: "2026-07-23T07:20:00.000Z",
  });
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /owner\/repo\/actions\/workflows\/daily-analysis\.yml\/dispatches$/);
  assert.equal(requests[0].init.headers.Authorization, "Bearer super-secret-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    ref: "main",
    inputs: {
      profileId: "etf-main",
      slotId: "slot-abc",
      scheduledFor: "2026-07-23T07:20:00.000Z",
      tickers: "515880.SS,QQQ",
    },
  });
  assert.equal(JSON.stringify(result).includes("super-secret-token"), false);
});

test("GitHub dispatch is deferred without token and hides non-204 response bodies", async () => {
  const { dispatchFullAnalysis } = await import(dispatchUrl);
  const profile = monitorSettings().profiles[0];
  assert.deepEqual(
    await dispatchFullAnalysis({
      env: {},
      fetcher: async () => assert.fail("must not fetch"),
      profile,
      slotId: "slot-1",
      scheduledFor: "2026-07-23T07:20:00.000Z",
    }),
    { status: "deferred", errorCode: "GITHUB_DISPATCH_NOT_CONFIGURED" },
  );
  const failed = await dispatchFullAnalysis({
    env: {
      GITHUB_DISPATCH_TOKEN: "token",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_WORKFLOW_ID: "daily-analysis.yml",
    },
    fetcher: async () => new Response("private provider error body", { status: 500 }),
    profile,
    slotId: "slot-1",
    scheduledFor: "2026-07-23T07:20:00.000Z",
  });
  assert.deepEqual(failed, {
    status: "failed",
    errorCode: "GITHUB_DISPATCH_HTTP_500",
  });
  assert.equal(JSON.stringify(failed).includes("private provider error body"), false);
});

test("GitHub dispatch requires repository from env and never falls back or fetches", async () => {
  const { dispatchFullAnalysis } = await import(dispatchUrl);
  const result = await dispatchFullAnalysis({
    env: {
      GITHUB_DISPATCH_TOKEN: "token",
      GITHUB_WORKFLOW_ID: "daily-analysis.yml",
    },
    fetcher: async () => assert.fail("missing repository must not fetch"),
    profile: monitorSettings().profiles[0],
    slotId: "slot-1",
    scheduledFor: "2026-07-23T07:20:00.000Z",
  });
  assert.deepEqual(result, {
    status: "deferred",
    errorCode: "GITHUB_DISPATCH_NOT_CONFIGURED",
  });
});
