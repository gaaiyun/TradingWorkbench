import assert from "node:assert/strict";
import test from "node:test";

const registryUrl = new URL(
  "../workers/monitor/src/providers/registry.mjs",
  import.meta.url,
);

function response(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function eastmoneyFixture() {
  return {
    data: {
      klines: ["2026-07-23 10:00,10,11,12,9,1000"],
    },
  };
}

function tencentFixture() {
  return {
    data: {
      sh515880: {
        m5: [["202607231000", "10", "11", "12", "9", "1000"]],
      },
    },
  };
}

class FakeHealthD1 {
  constructor() {
    this.rows = new Map();
    this.calls = [];
  }

  prepare(sql) {
    return {
      bind: (...values) => {
        this.calls.push({ sql, values });
        return {
          first: async () => this.rows.get(values[0]) ?? null,
          run: async () => {
            const source = values[0];
            const previous = this.rows.get(source);
            if (sql.includes("source_health.consecutive_failures + 1")) {
              const consecutiveFailures = (previous?.consecutive_failures ?? 0) + 1;
              const threshold = values[5];
              this.rows.set(source, {
                source,
                status: consecutiveFailures >= threshold ? "unavailable" : "degraded",
                consecutive_failures: consecutiveFailures,
                paused_until: consecutiveFailures >= threshold ? values[6] : null,
                last_error_code: values[4],
              });
            } else {
              this.rows.set(source, {
                source,
                status: previous && sql.includes("status = 'ok'") ? "ok" : values[1],
                as_of: values[2],
                fetched_at: values[3],
                freshness: values[4],
                adjustment: values[5],
                quality: values[6],
                consecutive_failures: 0,
                paused_until: null,
                last_error_code: null,
              });
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  }
}

test("opens a D1-backed circuit after three failures, skips for 15 minutes, then retries", async () => {
  const { createProviderRegistry } = await import(registryUrl);
  const db = new FakeHealthD1();
  let current = new Date("2026-07-23T02:05:00.000Z");
  let tencentCalls = 0;
  const registry = createProviderRegistry({
    db,
    fetch: async (url) => {
      if (String(url).includes("gtimg")) {
        tencentCalls += 1;
        return response("", 503);
      }
      return response(eastmoneyFixture());
    },
    now: () => new Date(current),
  });
  const request = { symbol: "515880.SS", market: "CN", timeframe: "5m" };

  await registry.fetchMarketData(request);
  await registry.fetchMarketData(request);
  await registry.fetchMarketData(request);
  const paused = await registry.fetchMarketData(request);

  assert.equal(tencentCalls, 3);
  assert.deepEqual(paused.sources[0], {
    source: "tencent",
    status: "skipped",
    reason: "CIRCUIT_OPEN",
  });
  assert.equal(db.rows.get("tencent").consecutive_failures, 3);
  assert.equal(db.rows.get("tencent").paused_until, "2026-07-23T02:20:00.000Z");
  assert.equal(db.rows.get("tencent").last_error_code, "HTTP_ERROR");

  current = new Date("2026-07-23T02:20:00.000Z");
  await registry.fetchMarketData(request);
  assert.equal(tencentCalls, 4);
});

test("a successful recovery resets the consecutive failure counter", async () => {
  const { createProviderRegistry } = await import(registryUrl);
  const db = new FakeHealthD1();
  let current = new Date("2026-07-23T02:05:00.000Z");
  let tencentSucceeds = false;
  const registry = createProviderRegistry({
    db,
    fetch: async (url) => {
      if (String(url).includes("gtimg")) {
        return tencentSucceeds ? response(tencentFixture()) : response("", 503);
      }
      return response(eastmoneyFixture());
    },
    now: () => new Date(current),
  });
  const request = { symbol: "515880.SS", market: "CN", timeframe: "5m" };

  await registry.fetchMarketData(request);
  await registry.fetchMarketData(request);
  await registry.fetchMarketData(request);
  current = new Date("2026-07-23T02:21:00.000Z");
  tencentSucceeds = true;
  const recovered = await registry.fetchMarketData(request);
  assert.equal(recovered.status, "stale");
  assert.equal(recovered.source, "tencent");
  assert.equal(db.rows.get("tencent").status, "stale");
  assert.equal(db.rows.get("tencent").freshness, "stale");
  assert.equal(db.rows.get("tencent").consecutive_failures, 0);
  assert.equal(db.rows.get("tencent").paused_until, null);
  assert.equal(db.rows.get("tencent").last_error_code, null);

  tencentSucceeds = false;
  await registry.fetchMarketData(request);
  assert.equal(db.rows.get("tencent").consecutive_failures, 1);
  assert.equal(db.rows.get("tencent").paused_until, null);
});

test("persists normalized stale metadata instead of reporting the source as fresh", async () => {
  const { createProviderRegistry } = await import(registryUrl);
  const db = new FakeHealthD1();
  const registry = createProviderRegistry({
    db,
    fetch: async () => response(tencentFixture()),
    now: () => new Date("2026-07-23T03:00:00.000Z"),
    intradayFreshnessMs: 10 * 60 * 1000,
  });

  const result = await registry.fetchMarketData({
    symbol: "515880.SS",
    market: "CN",
    timeframe: "5m",
  });
  const health = db.rows.get("tencent");

  assert.equal(result.status, "stale");
  assert.deepEqual(health, {
    source: "tencent",
    status: "stale",
    as_of: "2026-07-23T02:00:00.000Z",
    fetched_at: "2026-07-23T03:00:00.000Z",
    freshness: "stale",
    adjustment: "none",
    quality: "good",
    consecutive_failures: 0,
    paused_until: null,
    last_error_code: null,
  });
});

test("health SQL is parameterized and stores only stable error codes", async () => {
  const { recordSourceFailure } = await import(
    new URL("../workers/monitor/src/providers/health.mjs", import.meta.url)
  );
  const db = new FakeHealthD1();
  await recordSourceFailure(
    db,
    "yahoo",
    "HTTP_ERROR",
    new Date("2026-07-23T02:05:00.000Z"),
  );

  const write = db.calls.at(-1);
  assert.match(write.sql, /INSERT INTO source_health/i);
  assert.match(write.sql, /ON CONFLICT\s*\(\s*source\s*\)\s*DO UPDATE/i);
  assert.match(write.sql, /source_health\.consecutive_failures\s*\+\s*1/i);
  assert.equal(write.sql.includes("yahoo"), false);
  assert.equal(write.sql.includes("HTTP_ERROR"), false);
  assert.deepEqual(
    write.values.filter((value) => typeof value === "string" && value.includes("ERROR")),
    ["HTTP_ERROR"],
  );
  assert.doesNotMatch(JSON.stringify(db.calls), /api[_-]?key|token|secret/i);
});
