import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { monitorSettings } from "./helpers/monitor_settings.mjs";

const workerUrl = new URL("../workers/monitor/src/index.mjs", import.meta.url);

function sqliteWorkerD1(settings, { failNextFinish = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0001_workbench_dynamic.sql",
    "0002_provider_circuit_breaker.sql",
    "0003_monitor_scheduled_slots.sql",
    "0004_monitor_slot_leases.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  sqlite.prepare(`
    INSERT INTO workbench_settings (id, version, settings_json, updated_at)
    VALUES (1, 2, ?, '2026-07-23T00:00:00.000Z')
  `).run(JSON.stringify(settings));
  const state = { failNextFinish };
  return {
    sqlite,
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: async () => /COUNT\(\*\)[\s\S]+FROM\s+market_bars/i.test(sql)
            ? { count: 1 }
            : sqlite.prepare(sql).get(...params) ?? null,
          all: async () => ({ results: [...sqlite.prepare(sql).all(...params)] }),
          run: async () => {
            if (
              state.failNextFinish &&
              /UPDATE\s+scheduled_slots/i.test(sql)
            ) {
              state.failNextFinish = false;
              throw new Error("simulated terminal write failure");
            }
            const result = sqlite.prepare(sql).run(...params);
            return { meta: { changes: Number(result.changes) } };
          },
        }),
      };
    },
  };
}

class WorkerD1 {
  constructor(settings, { barCount = 1 } = {}) {
    this.settings = settings;
    this.slots = new Map();
    this.barWrites = [];
    this.barCount = barCount;
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...params) {
        return {
          async first() {
            if (/FROM\s+workbench_settings/i.test(sql)) {
              return db.settings == null
                ? null
                : { settings_json: JSON.stringify(db.settings) };
            }
            if (/COUNT\(\*\)[\s\S]+FROM\s+market_bars/i.test(sql)) {
              return { count: db.barCount + db.barWrites.length };
            }
            if (/INSERT\s+INTO\s+scheduled_slots/i.test(sql)) {
              const [
                id,
                profileId,
                slotType,
                scheduledFor,
                claimedAt,
                expiresAt,
                updatedAt,
                leaseUntil,
              ] =
                params;
              const row = db.slots.get(id);
              if (!row) {
                const claim = {
                  id,
                  profile_id: profileId,
                  slot_type: slotType,
                  scheduled_for: scheduledFor,
                  status: "claimed",
                  attempt_count: 1,
                  claimed_at: claimedAt,
                  expires_at: expiresAt,
                  updated_at: updatedAt,
                  lease_until: leaseUntil,
                  next_attempt_at: null,
                };
                db.slots.set(id, claim);
                return claim;
              }
              if (
                row.attempt_count < 3 &&
                (
                  (row.status === "failed" && row.next_attempt_at <= claimedAt) ||
                  (row.status === "claimed" && row.lease_until <= claimedAt)
                )
              ) {
                row.status = "claimed";
                row.attempt_count += 1;
                row.lease_until = leaseUntil;
                row.next_attempt_at = null;
                return row;
              }
              return null;
            }
            return null;
          },
          async all() {
            if (/FROM\s+scheduled_slots/i.test(sql)) {
              const [, failedAt, leaseAt] = params;
              return {
                results: [...db.slots.values()].filter((row) =>
                  row.attempt_count < 3 &&
                  (
                    (row.status === "failed" && row.next_attempt_at <= failedAt) ||
                    (row.status === "claimed" && row.lease_until <= leaseAt)
                  )),
              };
            }
            return { results: [] };
          },
          async run() {
            if (/UPDATE\s+scheduled_slots/i.test(sql)) {
              const [
                status,
                completedAt,
                errorCode,
                updatedAt,
                nextAttemptAt,
                id,
                attemptCount,
              ] =
                params;
              const row = db.slots.get(id);
              if (
                !row ||
                row.status !== "claimed" ||
                row.attempt_count !== attemptCount
              ) {
                return { meta: { changes: 0 } };
              }
              Object.assign(row, {
                status,
                completed_at: completedAt,
                last_error_code: errorCode,
                updated_at: updatedAt,
                lease_until: null,
                next_attempt_at: nextAttemptAt,
              });
              return { meta: { changes: 1 } };
            }
            if (/INSERT\s+INTO\s+market_bars/i.test(sql)) {
              db.barWrites.push(...JSON.parse(params[0]));
              return { meta: { changes: db.barWrites.length } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

function barFor(request) {
  return {
    symbol: request.symbol,
    timeframe: request.timeframe,
    timestamp: "2026-07-23T01:30:00.000Z",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1000,
    source: "wire",
    asOf: "2026-07-23T01:30:00.000Z",
    fetchedAt: "2026-07-23T01:30:01.000Z",
    freshness: "fresh",
    adjustment: "none",
    quality: "good",
  };
}

test("core scheduled run reads D1 settings, executes due tasks, and is awaitable", async () => {
  const { runScheduled } = await import(workerUrl);
  const db = new WorkerD1(monitorSettings());
  const result = await runScheduled(
    Date.parse("2026-07-23T01:30:00.000Z"),
    { DB: db },
    {
      registryFactory: () => ({
        fetchMarketData: async (request) => ({
          status: "ok",
          source: "wire",
          bars: [barFor(request)],
          sources: [{ source: "wire", status: "success", reason: null }],
        }),
      }),
    },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(result.counts, {
    due: 2,
    claimed: 2,
    completed: 1,
    degraded: 0,
    deferred: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(db.barWrites.length, 2);
  assert.deepEqual(
    [...db.slots.values()].map((row) => row.status).sort(),
    ["completed", "deferred"],
  );
});

test("an empty production database bootstraps CN and US market snapshots outside trading hours", async () => {
  const { runScheduled } = await import(workerUrl);
  const db = new WorkerD1(monitorSettings(), { barCount: 0 });
  const requests = [];
  const result = await runScheduled(
    Date.parse("2026-07-23T18:20:00.000Z"),
    { DB: db },
    {
      registryFactory: () => ({
        fetchMarketData: async (request) => {
          requests.push(request);
          return {
            status: "ok",
            source: "wire",
            bars: [barFor(request)],
            sources: [{ source: "wire", status: "success", reason: null }],
          };
        },
      }),
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.counts.due, 4);
  assert.equal(result.counts.completed, 4);
  assert.deepEqual(
    requests.map(({ symbol, timeframe }) => [symbol, timeframe]),
    [
      ["515880.SS", "5m"],
      ["159995.SZ", "5m"],
      ["515880.SS", "1d"],
      ["159995.SZ", "1d"],
      ["SPY", "1d"],
    ],
  );
  assert.equal(db.barWrites.length, 5);
});

test("close scheduled run dispatches one full analysis with the claimed slot metadata", async () => {
  const { runScheduled } = await import(workerUrl);
  const db = new WorkerD1(monitorSettings());
  const requests = [];
  const marketRequests = [];
  const result = await runScheduled(
    Date.parse("2026-07-23T07:20:00.000Z"),
    {
      DB: db,
      GITHUB_DISPATCH_TOKEN: "worker-secret",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_WORKFLOW_ID: "daily-analysis.yml",
    },
    {
      registryFactory: () => ({
        fetchMarketData: async (request) => {
          marketRequests.push(request);
          return {
            status: "ok",
            source: "wire",
            bars: [barFor(request)],
            sources: [{ source: "wire", status: "success", reason: null }],
          };
        },
      }),
      fetcher: async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: 204 });
      },
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.counts.completed, 2);
  assert.equal(marketRequests.length, 2);
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.inputs.profileId, "etf-main");
  assert.match(payload.inputs.slotId, /^slot-[a-f0-9]{64}$/);
  assert.equal(payload.inputs.scheduledFor, "2026-07-23T07:20:00.000Z");
  assert.equal(payload.inputs.tickers, "515880.SS,QQQ");
  assert.equal(JSON.stringify(result).includes("worker-secret"), false);
});

test("missing and invalid D1 settings fail safely with stable summaries", async () => {
  const { runScheduled } = await import(workerUrl);
  assert.deepEqual(
    await runScheduled(Date.now(), { DB: new WorkerD1(null) }),
    {
      status: "unavailable",
      errorCode: "WORKBENCH_SETTINGS_MISSING",
      counts: {
        due: 0,
        claimed: 0,
        completed: 0,
        degraded: 0,
        deferred: 0,
        failed: 0,
        skipped: 0,
      },
      sources: [],
    },
  );
  const bad = await runScheduled(Date.now(), { DB: new WorkerD1({ version: 999 }) });
  assert.equal(bad.status, "unavailable");
  assert.equal(bad.errorCode, "WORKBENCH_SETTINGS_INVALID");
  assert.equal(JSON.stringify(bad).includes("不支持"), false);
});

test("scheduled handler uses scheduledTime and waitUntil while health reveals no secret", async () => {
  const { default: worker } = await import(workerUrl);
  const db = new WorkerD1(monitorSettings());
  let promise;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    '<?xml version="1.0"?><rss><channel></channel></rss>',
    { status: 200, headers: { "content-type": "application/rss+xml" } },
  );
  try {
    worker.scheduled(
      { scheduledTime: Date.parse("2026-07-23T00:25:00.000Z") },
      { DB: db, GITHUB_DISPATCH_TOKEN: "secret-value" },
      { waitUntil(value) { promise = value; } },
    );
    assert.ok(promise instanceof Promise);
    const summary = await promise;
    assert.equal(summary.counts.completed, 1);
    assert.equal(summary.counts.deferred, 1);
    assert.equal(JSON.stringify(summary).includes("secret-value"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const response = await worker.fetch(new Request("https://monitor.example/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "monitor-worker" });
  assert.equal((await worker.fetch(new Request("https://monitor.example/anything"))).status, 404);
});

test("protected manual collection backfills the configured US daily targets", async () => {
  const { handleFetch } = await import(workerUrl);
  const env = {
    DB: new WorkerD1(monitorSettings()),
    MONITOR_RUN_TOKEN: "monitor-secret",
  };
  const unauthorized = await handleFetch(
    new Request("https://monitor.example/run-collection?task=usCloseSnapshot", {
      method: "POST",
    }),
    env,
  );
  assert.equal(unauthorized.status, 401);

  const requests = [];
  let registryOptions;
  const response = await handleFetch(
    new Request("https://monitor.example/run-collection?task=usCloseSnapshot", {
      method: "POST",
      headers: { authorization: "Bearer monitor-secret" },
    }),
    env,
    {
      registryFactory: (options) => {
        registryOptions = options;
        return {
          fetchMarketData: async (request) => {
            requests.push(request);
            return {
              status: "ok",
              source: "wire",
              bars: [barFor(request)],
              sources: [{ source: "wire", status: "success", reason: null }],
            };
          },
        };
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, "completed");
  assert.equal(payload.counts.targets, 1);
  assert.equal(payload.counts.succeeded, 1);
  assert.equal(payload.written, 1);
  assert.equal(registryOptions.ignoreCircuitBreaker, true);
  assert.deepEqual(requests, [{
    symbol: "SPY",
    market: "US",
    timeframe: "1d",
    limit: 1500,
  }]);
  assert.equal(JSON.stringify(payload).includes("monitor-secret"), false);
});

test("protected manual collection backfills configured CN daily targets", async () => {
  const { handleFetch } = await import(workerUrl);
  const requests = [];
  const response = await handleFetch(
    new Request("https://monitor.example/run-collection?task=cnDailySnapshot", {
      method: "POST",
      headers: { authorization: "Bearer monitor-secret" },
    }),
    {
      DB: new WorkerD1(monitorSettings()),
      MONITOR_RUN_TOKEN: "monitor-secret",
    },
    {
      registryFactory: () => ({
        fetchMarketData: async (request) => {
          requests.push(request);
          return {
            status: "ok",
            source: "wire",
            bars: [barFor(request)],
            sources: [{ source: "wire", status: "success", reason: null }],
          };
        },
      }),
      collectNews: async () => ({
        status: "completed",
        written: 0,
        counts: { queries: 1, succeeded: 1, failed: 0, items: 0 },
        sources: [{ source: "google-news-rss", status: "success", reason: null }],
      }),
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.status, "completed");
  assert.deepEqual(requests, [
    { symbol: "515880.SS", market: "CN", timeframe: "1d", limit: 1500 },
    { symbol: "159995.SZ", market: "CN", timeframe: "1d", limit: 1500 },
  ]);
});

test("protected manual news collection reports discovery query counts", async () => {
  const { handleFetch } = await import(workerUrl);
  let receivedProfile;
  const response = await handleFetch(
    new Request("https://monitor.example/run-collection?task=newsCollect", {
      method: "POST",
      headers: { authorization: "Bearer monitor-secret" },
    }),
    {
      DB: new WorkerD1(monitorSettings()),
      MONITOR_RUN_TOKEN: "monitor-secret",
    },
    {
      collectNews: async ({ profile }) => {
        receivedProfile = profile;
        return {
          status: "completed",
          written: 12,
          counts: { queries: 3, succeeded: 3, failed: 0, items: 12 },
          sources: [{ source: "google-news-rss", status: "success", reason: null }],
        };
      },
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(receivedProfile.id, "etf-main");
  assert.deepEqual(payload.counts, { targets: 3, succeeded: 3, failed: 0 });
  assert.equal(payload.written, 12);
});

test("monitor wrangler config uses five-minute cron and the same deployed D1 binding", () => {
  const pages = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const monitor = readFileSync(
    new URL("../wrangler.monitor.toml", import.meta.url),
    "utf8",
  );
  assert.match(monitor, /main\s*=\s*"workers\/monitor\/src\/index\.mjs"/);
  assert.match(monitor, /crons\s*=\s*\[\s*"\*\/5 \* \* \* \*"\s*\]/);
  assert.match(monitor, /binding\s*=\s*"DB"/);
  assert.match(monitor, /database_name\s*=\s*"tradingagents-workbench"/);
  assert.match(monitor, /GITHUB_REPOSITORY\s*=\s*"gaaiyun\/TradingWorkbench"/);
  assert.match(monitor, /GITHUB_WORKFLOW_ID\s*=\s*"daily-analysis\.yml"/);
  const monitorDatabaseId = /database_id\s*=\s*"([^"]+)"/.exec(monitor)[1];
  const pagesDatabaseId = /database_id\s*=\s*"([^"]+)"/.exec(pages)[1];
  assert.match(monitorDatabaseId, /^[0-9a-f-]{36}$/);
  assert.equal(monitorDatabaseId, pagesDatabaseId);
  assert.equal(monitor.includes("GITHUB_DISPATCH_TOKEN"), false);
  assert.equal(
    /database_name\s*=\s*"([^"]+)"/.exec(monitor)[1],
    /database_name\s*=\s*"([^"]+)"/.exec(pages)[1],
  );
});

test("daily workflow accepts monitor dispatch metadata and keeps legacy manual input", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/daily-analysis.yml", import.meta.url),
    "utf8",
  );
  for (const input of ["tickers", "profileId", "slotId", "scheduledFor"]) {
    assert.match(workflow, new RegExp(`^\\s{6}${input}:`, "m"));
  }
  assert.match(workflow, /MANUAL_TICKERS:\s*\$\{\{\s*inputs\.tickers/);
  assert.match(workflow, /ENABLE_GITHUB_PAGES:\s*\$\{\{\s*vars\.ENABLE_GITHUB_PAGES/);
  for (const step of ["Setup Pages", "Upload site artifact", "Deploy to GitHub Pages"]) {
    assert.match(
      workflow,
      new RegExp(`- name: ${step}\\r?\\n\\s+if: \\$\\{\\{ env\\.ENABLE_GITHUB_PAGES == 'true' \\}\\}`),
    );
  }
});

test("failed 09:30 slot is retried by later cron ticks and stops after three attempts", async () => {
  const { runScheduled } = await import(workerUrl);
  const db = sqliteWorkerD1(monitorSettings());
  const registryFactory = () => ({
    fetchMarketData: async (request) => ({
      status: "unavailable",
      symbol: request.symbol,
      bars: [],
      sources: [{ source: "wire", status: "failed", reason: "UPSTREAM" }],
    }),
  });
  for (const iso of [
    "2026-07-23T01:30:00.000Z",
    "2026-07-23T01:35:00.000Z",
    "2026-07-23T01:40:00.000Z",
  ]) {
    await runScheduled(Date.parse(iso), { DB: db }, {
      registryFactory,
      now: () => new Date(iso),
    });
  }
  const original = db.sqlite.prepare(`
    SELECT status, attempt_count
    FROM scheduled_slots
    WHERE slot_type = 'intradayCollect'
      AND scheduled_for = '2026-07-23T01:30:00.000Z'
  `).get();
  assert.deepEqual({ ...original }, { status: "failed", attempt_count: 3 });

  await runScheduled(Date.parse("2026-07-23T01:45:00.000Z"), { DB: db }, {
    registryFactory,
    now: () => new Date("2026-07-23T01:45:00.000Z"),
  });
  assert.equal(db.sqlite.prepare(`
    SELECT attempt_count
    FROM scheduled_slots
    WHERE slot_type = 'intradayCollect'
      AND scheduled_for = '2026-07-23T01:30:00.000Z'
  `).get().attempt_count, 3);
});

test("expired claim lease recovers on the next cron after a terminal write crash", async () => {
  const { runScheduled } = await import(workerUrl);
  const db = sqliteWorkerD1(monitorSettings(), { failNextFinish: true });
  const registryFactory = () => ({
    fetchMarketData: async (request) => ({
      status: "ok",
      source: "wire",
      bars: [barFor(request)],
      sources: [{ source: "wire", status: "success", reason: null }],
    }),
  });
  await runScheduled(Date.parse("2026-07-23T01:30:00.000Z"), { DB: db }, {
    registryFactory,
    now: () => new Date("2026-07-23T01:30:00.000Z"),
  });
  assert.equal(db.sqlite.prepare(`
    SELECT status FROM scheduled_slots
    WHERE slot_type = 'intradayCollect'
      AND scheduled_for = '2026-07-23T01:30:00.000Z'
  `).get().status, "claimed");

  await runScheduled(Date.parse("2026-07-23T01:35:00.000Z"), { DB: db }, {
    registryFactory,
    now: () => new Date("2026-07-23T01:35:00.000Z"),
  });
  assert.deepEqual({ ...db.sqlite.prepare(`
    SELECT status, attempt_count FROM scheduled_slots
    WHERE slot_type = 'intradayCollect'
      AND scheduled_for = '2026-07-23T01:30:00.000Z'
  `).get() }, { status: "completed", attempt_count: 2 });
});

test("partial collection retries without losing bars and completes after recovery", async () => {
  const { runScheduled } = await import(workerUrl);
  const db = sqliteWorkerD1(monitorSettings());
  let comparisonCalls = 0;
  const registryFactory = () => ({
    fetchMarketData: async (request) => {
      if (request.symbol === "159995.SZ" && comparisonCalls++ === 0) {
        return {
          status: "unavailable",
          symbol: request.symbol,
          bars: [],
          sources: [{ source: "wire", status: "failed", reason: "UPSTREAM" }],
        };
      }
      return {
        status: "ok",
        source: "wire",
        bars: [barFor(request)],
        sources: [{ source: "wire", status: "success", reason: null }],
      };
    },
  });
  const first = await runScheduled(
    Date.parse("2026-07-23T01:30:00.000Z"),
    { DB: db },
    {
      registryFactory,
      now: () => new Date("2026-07-23T01:30:00.000Z"),
    },
  );
  assert.equal(first.counts.degraded, 1);
  assert.equal(first.counts.completed, 0);

  await runScheduled(Date.parse("2026-07-23T01:35:00.000Z"), { DB: db }, {
    registryFactory,
    now: () => new Date("2026-07-23T01:35:00.000Z"),
  });
  assert.deepEqual({ ...db.sqlite.prepare(`
    SELECT status, attempt_count FROM scheduled_slots
    WHERE slot_type = 'intradayCollect'
      AND scheduled_for = '2026-07-23T01:30:00.000Z'
  `).get() }, { status: "completed", attempt_count: 2 });
  assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM market_bars").get().count, 2);
});

test("workflow has no legacy cron and exposes dispatch metadata to the analysis runner", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/daily-analysis.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /^\s+schedule:/m);
  assert.doesNotMatch(workflow, /^\s+- cron:/m);
  assert.match(workflow, /^run-name:\s*>-/m);
  for (const name of [
    "TRADINGAGENTS_PROFILE_ID",
    "TRADINGAGENTS_SLOT_ID",
    "TRADINGAGENTS_SCHEDULED_FOR",
  ]) {
    assert.match(workflow, new RegExp(`^\\s{6}${name}:`, "m"));
  }
  assert.match(workflow, /Run multi-agent analysis[\s\S]+python scripts\/run_daily\.py/);
});
