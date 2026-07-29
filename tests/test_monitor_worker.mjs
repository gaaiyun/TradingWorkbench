import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { monitorSettings } from "./helpers/monitor_settings.mjs";
import { bootstrapRequirementsForProfile } from "../workers/monitor/src/scheduler.mjs";

const workerUrl = new URL("../workers/monitor/src/index.mjs", import.meta.url);

function sqliteWorkerD1(settings, { failNextFinish = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0001_workbench_dynamic.sql",
    "0002_provider_circuit_breaker.sql",
    "0003_monitor_scheduled_slots.sql",
    "0004_monitor_slot_leases.sql",
    "0010_news_evidence_metadata.sql",
    "0013_monitor_reliability.sql",
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
              /UPDATE\s+scheduled_slots[\s\S]+SET\s+status\s*=\s*\?/i.test(sql)
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

async function markBootstrapComplete(db, settings) {
  const completedAt = "2026-07-23T00:00:00.000Z";
  for (const profile of settings.profiles) {
    const requirements = await bootstrapRequirementsForProfile(
      profile,
      new Set(),
    );
    for (const requirement of requirements) {
      db.sqlite.prepare(`
        INSERT INTO monitor_bootstrap_targets (
          profile_id, symbol, timeframe, schema_version, target_hash,
          completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        requirement.profileId,
        requirement.symbol,
        requirement.timeframe,
        requirement.schemaVersion,
        requirement.targetHash,
        completedAt,
      );
    }
  }
}

class WorkerD1 {
  constructor(settings, { barCount = 1 } = {}) {
    this.settings = settings;
    this.slots = new Map();
    this.barWrites = [];
    this.barCount = barCount;
    this.bootstrapRows = [];
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
                : {
                    settings_json: JSON.stringify(db.settings),
                    updated_at: "2026-07-23T00:00:00.000Z",
                  };
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
                expiresAt,
                updatedAt,
                nextAttemptAt,
                profileRevision,
                payloadJson,
                payloadHash,
                localDate,
              ] =
                params;
              const row = db.slots.get(id);
              if (!row) {
                const claim = {
                  id,
                  profile_id: profileId,
                  slot_type: slotType,
                  scheduled_for: scheduledFor,
                  status: "pending",
                  attempt_count: 0,
                  claimed_at: null,
                  expires_at: expiresAt,
                  updated_at: updatedAt,
                  lease_until: null,
                  next_attempt_at: nextAttemptAt,
                  profile_revision: profileRevision,
                  payload_json: payloadJson,
                  payload_hash: payloadHash,
                  local_date: localDate,
                };
                db.slots.set(id, claim);
                return claim;
              }
              return null;
            }
            if (/UPDATE\s+scheduled_slots[\s\S]+RETURNING/i.test(sql)) {
              const [
                claimedAt,
                updatedAt,
                leaseUntil,
                id,
                payloadHash,
                maxAttempts,
                failedAt,
                leaseAt,
              ] = params;
              const row = db.slots.get(id);
              if (
                row &&
                row.payload_hash === payloadHash &&
                row.attempt_count < maxAttempts &&
                (
                  row.status === "pending" ||
                  row.status === "queued" ||
                  (row.status === "failed" && row.next_attempt_at <= failedAt) ||
                  (row.status === "claimed" && row.lease_until <= leaseAt)
                )
              ) {
                row.status = "claimed";
                row.attempt_count += 1;
                row.claimed_at = claimedAt;
                row.updated_at = updatedAt;
                row.lease_until = leaseUntil;
                row.next_attempt_at = null;
                return row;
              }
              return null;
            }
            return null;
          },
          async all() {
            if (/FROM\s+monitor_bootstrap_targets/i.test(sql)) {
              if (db.barCount > 0 && db.bootstrapRows.length === 0 && db.settings) {
                for (const profile of db.settings.profiles) {
                  const requirements = await bootstrapRequirementsForProfile(
                    profile,
                    new Set(),
                  );
                  db.bootstrapRows.push(...requirements.map((requirement) => ({
                    profile_id: requirement.profileId,
                    symbol: requirement.symbol,
                    timeframe: requirement.timeframe,
                    schema_version: requirement.schemaVersion,
                    target_hash: requirement.targetHash,
                  })));
                }
              }
              return { results: structuredClone(db.bootstrapRows) };
            }
            if (/SELECT\s+id,\s*profile_id,\s*profile_revision/i.test(sql)) {
              const [leaseAt] = params;
              return {
                results: [...db.slots.values()].filter((row) =>
                  ["pending", "queued", "failed"].includes(row.status) ||
                  (row.status === "claimed" && row.lease_until <= leaseAt)),
              };
            }
            if (/FROM\s+scheduled_slots/i.test(sql)) {
              const [maxAttempts, failedAt, leaseAt, limit] = params;
              return {
                results: [...db.slots.values()].filter((row) =>
                  row.attempt_count < maxAttempts &&
                  (
                    (
                      ["pending", "queued", "failed"].includes(row.status) &&
                      row.next_attempt_at <= failedAt
                    ) ||
                    (row.status === "claimed" && row.lease_until <= leaseAt)
                  )).slice(0, limit),
              };
            }
            return { results: [] };
          },
          async run() {
            if (/INSERT\s+INTO\s+monitor_bootstrap_targets/i.test(sql)) {
              const [
                profileId,
                symbol,
                timeframe,
                schemaVersion,
                targetHash,
              ] = params;
              if (!db.bootstrapRows.some((row) =>
                row.profile_id === profileId &&
                row.symbol === symbol &&
                row.timeframe === timeframe &&
                row.schema_version === schemaVersion &&
                row.target_hash === targetHash)) {
                db.bootstrapRows.push({
                  profile_id: profileId,
                  symbol,
                  timeframe,
                  schema_version: schemaVersion,
                  target_hash: targetHash,
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            if (/UPDATE\s+scheduled_slots/i.test(sql)) {
              if (/status = 'cancelled'/i.test(sql)) {
                const [completedAt, errorCode, updatedAt, id] = params;
                const row = db.slots.get(id);
                if (!row) return { meta: { changes: 0 } };
                Object.assign(row, {
                  status: "cancelled",
                  completed_at: completedAt,
                  last_error_code: errorCode,
                  updated_at: updatedAt,
                  lease_until: null,
                  next_attempt_at: null,
                });
                return { meta: { changes: 1 } };
              }
              if (/status = 'queued'/i.test(sql)) {
                const [updatedAt, nextAttemptAt, id, payloadHash] = params;
                const row = db.slots.get(id);
                if (!row || row.payload_hash !== payloadHash) {
                  return { meta: { changes: 0 } };
                }
                row.status = "queued";
                row.updated_at = updatedAt;
                row.next_attempt_at = nextAttemptAt;
                return { meta: { changes: 1 } };
              }
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
            if (/monitor_scheduler_state/i.test(sql)) {
              return { meta: { changes: 1 } };
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
    {
      DB: db,
      DIRECT_EXTERNAL_REQUEST_BUDGET: "999",
      DIRECT_MAX_TASKS: "1",
    },
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
  assert.equal(result.status, "degraded");
  assert.equal(result.externalRequestBudget, 32);
  assert.deepEqual(result.counts, {
    due: 2,
    claimed: 1,
    completed: 1,
    degraded: 0,
    deferred: 0,
    failed: 0,
    skipped: 0,
  });
  assert.equal(db.barWrites.length, 2);
  assert.deepEqual(
    [...db.slots.values()].map((row) => row.status).sort(),
    ["completed", "pending"],
  );
});

test("fourteen-target collection shards drain without duplicate target writes or permanent backlog", async () => {
  const { runScheduled } = await import(workerUrl);
  const targets = Array.from({ length: 14 }, (_, index) => ({
    symbol: `${510000 + index}.SS`,
    name: `ETF ${index}`,
    market: "CN",
    role: index === 0 ? "core" : "comparison",
    analysis: "signal",
  }));
  const db = new WorkerD1(monitorSettings({ targets }));
  const requests = [];
  const deps = {
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
  };
  const scheduledTime = Date.parse("2026-07-23T01:30:00.000Z");
  const first = await runScheduled(
    scheduledTime,
    { DB: db, DIRECT_EXTERNAL_REQUEST_BUDGET: "40" },
    {
      ...deps,
      now: () => new Date("2026-07-23T01:30:00.000Z"),
    },
  );
  assert.equal(first.externalRequestBudget, 32);
  assert.equal(first.capped, 2);
  const second = await runScheduled(
    scheduledTime,
    { DB: db, DIRECT_EXTERNAL_REQUEST_BUDGET: "40" },
    {
      ...deps,
      now: () => new Date("2026-07-23T01:35:00.000Z"),
    },
  );
  assert.equal(second.capped, 0);
  assert.equal(requests.length, 14);
  assert.equal(new Set(requests.map(({ symbol }) => symbol)).size, 14);
  assert.equal(
    [...db.slots.values()].filter((row) =>
      row.slot_type === "intradayCollect" &&
      ["pending", "queued", "failed", "claimed"].includes(row.status)).length,
    0,
  );
});

test("fourteen-target bootstrap keeps a stable remaining shard across cron ticks", async () => {
  const { runScheduled } = await import(workerUrl);
  const targets = Array.from({ length: 14 }, (_, index) => ({
    symbol: `${510100 + index}.SS`,
    name: `Bootstrap ETF ${index}`,
    market: "CN",
    role: index === 0 ? "core" : "comparison",
    analysis: "signal",
  }));
  const settings = monitorSettings({ targets });
  const profile = settings.profiles[0];
  const db = new WorkerD1(settings, { barCount: 0 });
  const requirements = await bootstrapRequirementsForProfile(
    profile,
    new Set(),
  );
  db.bootstrapRows.push(...requirements
    .filter(({ taskType }) => taskType !== "intradayCollect")
    .map((requirement) => ({
      profile_id: requirement.profileId,
      symbol: requirement.symbol,
      timeframe: requirement.timeframe,
      schema_version: requirement.schemaVersion,
      target_hash: requirement.targetHash,
    })));
  const requests = [];
  const deps = {
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
  };
  const scheduledTime = Date.parse("2026-07-23T18:20:00.000Z");
  const first = await runScheduled(
    scheduledTime,
    { DB: db },
    {
      ...deps,
      now: () => new Date("2026-07-23T18:20:00.000Z"),
    },
  );
  assert.equal(first.capped, 1);
  assert.equal(requests.length, 10);

  const second = await runScheduled(
    scheduledTime,
    { DB: db },
    {
      ...deps,
      now: () => new Date("2026-07-23T18:25:00.000Z"),
    },
  );
  assert.equal(second.capped, 0);
  assert.equal(requests.length, 14);
  assert.equal(new Set(requests.map(({ symbol }) => symbol)).size, 14);
  assert.equal(
    [...db.slots.values()].filter(({ slot_type: type }) =>
      type === "intradayCollect").length,
    2,
  );
  assert.equal(
    [...db.slots.values()].filter(({ status }) =>
      ["pending", "queued", "failed", "claimed"].includes(status)).length,
    0,
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
      now: () => new Date("2026-07-23T18:20:00.000Z"),
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
        counts: { queries: 0, succeeded: 0, failed: 0, items: 0 },
        sources: [],
      }),
    },
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "DIRECT_FALLBACK_CAPPED");
  assert.equal(result.counts.due, 4);
  assert.equal(result.counts.completed, 3);
  assert.equal(result.capped, 1);
  assert.equal(
    [...db.slots.values()].filter(({ status }) => status === "pending").length,
    1,
  );
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
  const followup = await runScheduled(
    Date.parse("2026-07-23T18:25:00.000Z"),
    { DB: db },
    {
      now: () => new Date("2026-07-23T18:25:00.000Z"),
      collectNews: async () => ({
        status: "completed",
        written: 0,
        counts: { queries: 0, succeeded: 0, failed: 0, items: 0 },
        sources: [],
      }),
    },
  );
  assert.equal(followup.status, "completed");
  assert.equal(followup.counts.due, 1);
  assert.equal(followup.counts.completed, 1);
  assert.equal(followup.backlog, 0);
});

test("bootstrap discovery advances one of eight profiles per cron tick", async () => {
  const { runScheduled } = await import(workerUrl);
  const template = monitorSettings().profiles[0];
  const settings = {
    version: 2,
    profiles: Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(template),
      id: `profile-${index}`,
    })),
  };
  const db = new WorkerD1(settings, { barCount: 0 });
  const result = await runScheduled(
    Date.parse("2026-07-23T18:20:00.000Z"),
    { DB: db, DIRECT_EXTERNAL_REQUEST_BUDGET: "0" },
    { now: () => new Date("2026-07-23T18:20:00.000Z") },
  );
  assert.equal(result.discovered, 4);
  assert.equal(result.externalRequestBudget, 0);
  assert.deepEqual(
    new Set([...db.slots.values()].map(({ profile_id: profileId }) => profileId)),
    new Set(["profile-0"]),
  );
});

test("daily recovery stages only missed critical semantic slots after a failed cron", async () => {
  const { runScheduled } = await import(workerUrl);
  const settings = monitorSettings();
  const db = sqliteWorkerD1(settings);
  await markBootstrapComplete(db, settings);
  const result = await runScheduled(
    Date.parse("2026-07-29T20:38:00.000Z"),
    { DB: db, DIRECT_EXTERNAL_REQUEST_BUDGET: "0" },
    {
      now: () => new Date("2026-07-29T20:38:00.000Z"),
      dailyRecoveryEnabled: true,
    },
  );
  assert.equal(result.discovered, 3);
  const rows = db.sqlite.prepare(
    "SELECT slot_type FROM scheduled_slots ORDER BY slot_type",
  ).all();
  assert.deepEqual(
    rows.map(({ slot_type: type }) => type),
    ["closeFullAnalysis", "cnDailySnapshot", "usCloseSnapshot"],
  );
  assert.equal(
    rows.some(({ slot_type: type }) =>
      ["intradayCollect", "intradaySignal", "newsCollect"].includes(type)),
    false,
  );
});

test("a 204 dispatch completes the slot and queued workflow time never causes a lease retry", async () => {
  const { runScheduled } = await import(workerUrl);
  const settings = monitorSettings();
  const db = sqliteWorkerD1(settings);
  await markBootstrapComplete(db, settings);
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

  const slot = db.sqlite.prepare(`
    SELECT status, attempt_count, lease_until
    FROM scheduled_slots
    WHERE slot_type = 'closeFullAnalysis'
  `).get();
  assert.equal(slot.status, "completed");
  assert.equal(slot.attempt_count, 1);
  assert.equal(slot.lease_until, null);

  const later = await runScheduled(
    Date.parse("2026-07-23T07:25:00.000Z"),
    {
      DB: db,
      GITHUB_DISPATCH_TOKEN: "worker-secret",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_WORKFLOW_ID: "daily-analysis.yml",
    },
    {
      registryFactory: () => ({
        fetchMarketData: async () => assert.fail("no market collection is due"),
      }),
      fetcher: async () => assert.fail("completed dispatch slot must not retry"),
      now: () => new Date("2026-07-23T07:25:00.000Z"),
    },
  );
  assert.equal(later.counts.due, 0);
  assert.equal(requests.length, 1);
  assert.equal(db.sqlite.prepare(`
    SELECT attempt_count
    FROM scheduled_slots
    WHERE slot_type = 'closeFullAnalysis'
  `).get().attempt_count, 1);
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
  const settings = monitorSettings();
  settings.profiles[0].schedules.newsRefresh = {
    enabled: true,
    intervalMinutes: 15,
  };
  const db = new WorkerD1(settings);
  let promise;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    '<?xml version="1.0"?><rss><channel></channel></rss>',
    { status: 200, headers: { "content-type": "application/rss+xml" } },
  );
  try {
    worker.scheduled(
      { scheduledTime: Date.parse("2026-07-23T00:30:00.000Z") },
      { DB: db, GITHUB_DISPATCH_TOKEN: "secret-value" },
      { waitUntil(value) { promise = value; } },
    );
    assert.ok(promise instanceof Promise);
    const summary = await promise;
    assert.equal(summary.counts.completed, 0);
    assert.equal(
      summary.counts.degraded,
      1,
      "官方证据源返回非目标格式时，发现层空结果不能掩盖降级状态",
    );
    assert.equal(summary.counts.deferred, 0);
    assert.equal(JSON.stringify(summary).includes("secret-value"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const response = await worker.fetch(new Request("https://monitor.example/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "monitor-worker",
    deployment: {
      commitSha: "unknown",
      deployedAt: "unknown",
    },
    newsProviders: {
      status: "unavailable",
      reason: "no_binding",
      providers: [],
    },
  });
  assert.equal((await worker.fetch(new Request("https://monitor.example/anything"))).status, 404);
});

test("weekend scheduler refreshes news without invoking market providers", async () => {
  const { runScheduled } = await import(workerUrl);
  const settings = monitorSettings();
  settings.profiles[0].schedules.newsRefresh = {
    enabled: true,
    intervalMinutes: 15,
  };
  const db = new WorkerD1(settings);
  let newsCalls = 0;
  const result = await runScheduled(
    Date.parse("2026-07-25T01:30:00.000Z"),
    { DB: db },
    {
      collectNews: async () => {
        newsCalls += 1;
        return {
          status: "ok",
          written: 1,
          counts: { queries: 1, succeeded: 1, failed: 0, items: 1 },
          sources: [{ source: "fixture-news", status: "success", reason: null }],
        };
      },
      registryFactory: () => ({
        fetchMarketData: async () =>
          assert.fail("weekend news refresh must not invoke market providers"),
      }),
      now: () => new Date("2026-07-25T01:30:00.000Z"),
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(newsCalls, 1);
  assert.deepEqual(result.counts, {
    due: 1,
    claimed: 1,
    completed: 1,
    degraded: 0,
    deferred: 0,
    failed: 0,
    skipped: 0,
  });
});

test("health exposes deployment identity and bounded news provider outcomes without secrets", async () => {
  const { handleFetch, runManualCollection } = await import(workerUrl);
  const settings = monitorSettings();
  const db = sqliteWorkerD1(settings);
  const env = {
    DB: db,
    WORKER_COMMIT_SHA: "abc1234",
    WORKER_DEPLOYED_AT: "2026-07-26T03:00:00.000Z",
    GITHUB_DISPATCH_TOKEN: "github-secret",
    SEC_CONTACT_EMAIL: "private@example.com",
  };
  const runAt = new Date("2026-07-26T03:05:00.000Z");
  const bodyMarker = "SEC response body must not escape";
  await runManualCollection("newsCollect", env, {
    now: () => runAt,
    collectNews: async () => ({
      status: "degraded",
      written: 0,
      counts: { queries: 2, succeeded: 1, failed: 1, items: 0 },
      sources: [
        {
          source: "sec-edgar-submissions",
          status: "failed",
          reason: "NEWS_HTTP_403",
          body: bodyMarker,
        },
        {
          source: "gov-policy-library",
          status: "success",
          reason: null,
        },
        {
          source: "miit-policy-api",
          status: "success",
          reason: null,
        },
      ],
    }),
  });

  const response = await handleFetch(
    new Request("https://monitor.example/health"),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.deployment, {
    commitSha: "abc1234",
    deployedAt: "2026-07-26T03:00:00.000Z",
  });
  assert.deepEqual(payload.newsProviders, {
    status: "degraded",
    reason: null,
    providers: [
      {
        source: "gov-policy-library",
        status: "ok",
        lastSuccessAt: runAt.toISOString(),
        lastFailureAt: null,
        lastErrorCode: null,
      },
      {
        source: "sec-edgar-submissions",
        status: "unavailable",
        lastSuccessAt: null,
        lastFailureAt: runAt.toISOString(),
        lastErrorCode: "NEWS_HTTP_403",
      },
    ],
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("github-secret"), false);
  assert.equal(serialized.includes("private@example.com"), false);
  assert.equal(serialized.includes(bodyMarker), false);
  assert.equal(serialized.includes("miit-policy-api"), false);
});

test("health stays 200 and marks providers unavailable when the bounded D1 query times out", async () => {
  const { handleFetch } = await import(workerUrl);
  const startedAt = performance.now();
  const response = await handleFetch(
    new Request("https://monitor.example/health"),
    {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  return new Promise(() => {});
                },
              };
            },
          };
        },
      },
      WORKER_COMMIT_SHA: "def5678",
      WORKER_DEPLOYED_AT: "2026-07-26T04:00:00.000Z",
      HEALTH_QUERY_TIMEOUT_MS: "10",
    },
  );
  assert.ok(performance.now() - startedAt < 100);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.deployment, {
    commitSha: "def5678",
    deployedAt: "2026-07-26T04:00:00.000Z",
  });
  assert.deepEqual(payload.newsProviders, {
    status: "unavailable",
    reason: "query_timeout",
    providers: [],
  });
});

test("health distinguishes missing binding, empty table, and D1 query errors", async () => {
  const { handleFetch } = await import(workerUrl);
  const missing = await handleFetch(new Request("https://monitor.example/health"), {});
  assert.deepEqual((await missing.json()).newsProviders, {
    status: "unavailable",
    reason: "no_binding",
    providers: [],
  });

  const empty = await handleFetch(
    new Request("https://monitor.example/health"),
    { DB: sqliteWorkerD1(monitorSettings()) },
  );
  assert.deepEqual((await empty.json()).newsProviders, {
    status: "unavailable",
    reason: "empty_table",
    providers: [],
  });

  const failed = await handleFetch(
    new Request("https://monitor.example/health"),
    {
      DB: {
        prepare() {
          throw new Error("private database failure detail");
        },
      },
    },
  );
  const failedPayload = await failed.json();
  assert.deepEqual(failedPayload.newsProviders, {
    status: "unavailable",
    reason: "query_error",
    providers: [],
  });
  assert.equal(JSON.stringify(failedPayload).includes("private database failure detail"), false);
});

test("health retries one cold D1 timeout and returns the recovered provider state", async () => {
  const { handleFetch } = await import(workerUrl);
  let attempts = 0;
  const response = await handleFetch(
    new Request("https://monitor.example/health"),
    {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  attempts += 1;
                  if (attempts === 1) return new Promise(() => {});
                  return {
                    results: [{
                      source: "recovered-provider",
                      status: "ok",
                      last_success_at: "2026-07-28T00:00:00.000Z",
                      last_failure_at: null,
                      last_error_code: null,
                    }],
                  };
                },
              };
            },
          };
        },
      },
      HEALTH_QUERY_TIMEOUT_MS: "10",
    },
  );
  assert.equal(attempts, 2);
  assert.deepEqual((await response.json()).newsProviders, {
    status: "ok",
    reason: null,
    providers: [{
      source: "recovered-provider",
      status: "ok",
      lastSuccessAt: "2026-07-28T00:00:00.000Z",
      lastFailureAt: null,
      lastErrorCode: null,
    }],
  });
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

test("protected manual market collection resumes the remaining target shard by cursor", async () => {
  const { handleFetch } = await import(workerUrl);
  const targets = Array.from({ length: 14 }, (_, index) => ({
    symbol: `${512000 + index}.SS`,
    name: `Manual ETF ${index}`,
    market: "CN",
    role: index === 0 ? "core" : "comparison",
    analysis: "signal",
  }));
  const env = {
    DB: new WorkerD1(monitorSettings({ targets })),
    MONITOR_RUN_TOKEN: "monitor-secret",
  };
  const requests = [];
  const deps = {
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
  };
  const first = await handleFetch(
    new Request(
      "https://monitor.example/run-collection?task=cnDailySnapshot&limit=32",
      {
        method: "POST",
        headers: { authorization: "Bearer monitor-secret" },
      },
    ),
    env,
    deps,
  );
  const firstPayload = await first.json();
  assert.equal(first.status, 200);
  assert.equal(requests.length, 10);
  assert.equal(firstPayload.processed, 1);
  assert.equal(firstPayload.nextCursor, 1);
  assert.equal(firstPayload.backlog, 1);

  const second = await handleFetch(
    new Request(
      `https://monitor.example/run-collection?task=cnDailySnapshot&cursor=${
        firstPayload.nextCursor
      }`,
      {
        method: "POST",
        headers: { authorization: "Bearer monitor-secret" },
      },
    ),
    env,
    deps,
  );
  const secondPayload = await second.json();
  assert.equal(second.status, 200);
  assert.equal(requests.length, 14);
  assert.equal(new Set(requests.map(({ symbol }) => symbol)).size, 14);
  assert.equal(secondPayload.nextCursor, null);
  assert.equal(secondPayload.backlog, 0);
});

test("protected manual news collection reports discovery query counts", async () => {
  const { handleFetch } = await import(workerUrl);
  let receivedProfile;
  let receivedEnv;
  const workerEnv = {
    DB: new WorkerD1(monitorSettings()),
    MONITOR_RUN_TOKEN: "monitor-secret",
    SEC_CONTACT_EMAIL: "sec-ops@example.com",
  };
  const response = await handleFetch(
    new Request("https://monitor.example/run-collection?task=newsCollect", {
      method: "POST",
      headers: { authorization: "Bearer monitor-secret" },
    }),
    workerEnv,
    {
      collectNews: async ({ profile, env }) => {
        receivedProfile = profile;
        receivedEnv = env;
        return {
          status: "degraded",
          errorCode: "NEWS_COLLECTION_PARTIAL",
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
  assert.equal(receivedEnv, workerEnv);
  assert.deepEqual(payload.counts, { targets: 3, succeeded: 3, failed: 0 });
  assert.equal(payload.written, 12);
  assert.equal(payload.status, "degraded");
});

test("protected manual news collection pages eight profiles within one bounded request", async () => {
  const { handleFetch } = await import(workerUrl);
  const template = monitorSettings().profiles[0];
  const settings = {
    version: 2,
    profiles: Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(template),
      id: `profile-${index}`,
    })),
  };
  const env = {
    DB: new WorkerD1(settings),
    MONITOR_RUN_TOKEN: "monitor-secret",
  };
  const collectedProfiles = [];
  const deps = {
    collectNews: async ({ profile }) => {
      collectedProfiles.push(profile.id);
      return {
        status: "completed",
        written: 0,
        counts: { queries: 21, succeeded: 21, failed: 0, items: 0 },
        sources: [],
      };
    },
  };
  const first = await handleFetch(
    new Request(
      "https://monitor.example/run-collection?task=newsCollect&limit=8",
      {
        method: "POST",
        headers: { authorization: "Bearer monitor-secret" },
      },
    ),
    env,
    deps,
  );
  const firstPayload = await first.json();
  assert.equal(first.status, 200);
  assert.deepEqual(collectedProfiles, ["profile-0"]);
  assert.equal(firstPayload.limit, 8);
  assert.equal(firstPayload.cursor, 0);
  assert.equal(firstPayload.nextCursor, 1);
  assert.equal(firstPayload.backlog, 7);
  assert.equal(firstPayload.processed, 1);
  assert.equal(firstPayload.estimatedWorkUnits, 21);

  const second = await handleFetch(
    new Request(
      `https://monitor.example/run-collection?task=newsCollect&limit=8&cursor=${
        firstPayload.nextCursor
      }`,
      {
        method: "POST",
        headers: { authorization: "Bearer monitor-secret" },
      },
    ),
    env,
    deps,
  );
  const secondPayload = await second.json();
  assert.equal(second.status, 200);
  assert.deepEqual(collectedProfiles, ["profile-0", "profile-1"]);
  assert.equal(secondPayload.cursor, 1);
  assert.equal(secondPayload.nextCursor, 2);
  assert.equal(secondPayload.backlog, 6);
});

test("monitor wrangler config uses five-minute cron and the same deployed D1 binding", () => {
  const pages = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const monitor = readFileSync(
    new URL("../wrangler.monitor.toml", import.meta.url),
    "utf8",
  );
  assert.match(pages, /^name\s*=\s*"tradingagents-board"/m);
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
  const queueConfig = readFileSync(
    new URL("../wrangler.monitor.queue.toml", import.meta.url),
    "utf8",
  );
  assert.match(queueConfig, /binding\s*=\s*"MONITOR_QUEUE"/);
  assert.match(queueConfig, /queue\s*=\s*"tradingagents-monitor-tasks"/);
  assert.match(queueConfig, /dead_letter_queue\s*=\s*"tradingagents-monitor-dlq"/);
});

test("dedicated monitor deployment fails closed and verifies the online commit", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-monitor.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /wrangler@4\.113\.0 deploy/);
  assert.match(workflow, /--config wrangler\.monitor\.toml/);
  assert.match(workflow, /WORKER_COMMIT_SHA:"\$GITHUB_SHA"/);
  assert.match(workflow, /WORKER_DEPLOYED_AT:"\$deployed_at"/);
  assert.match(workflow, /date -u \+"\%Y-\%m-\%dT\%H:\%M:\%SZ"/);
  assert.match(workflow, /Cloudflare deployment credentials are required/);
  assert.match(workflow, /exit 1/);
  assert.doesNotMatch(workflow, /monitor deployment was skipped/);
  assert.match(workflow, /curl[\s\S]+\/health/);
  assert.match(workflow, /deployment\?\.commitSha/);
  assert.match(workflow, /GITHUB_SHA/);
  assert.match(workflow, /for attempt in \$\(seq 1 12\)/);
  assert.match(workflow, /health\?attempt=\$\{attempt\}/);
  assert.match(workflow, /sleep 5/);
  assert.match(
    workflow,
    /Monitor production endpoint did not expose the deployed commit SHA/,
  );
  assert.match(workflow, /workers\/monitor\/\*\*/);
  assert.match(workflow, /wrangler\.monitor\.toml/);
});

test("Pages and monitor deployments serialize migrations before publishing runtime code", () => {
  const pages = readFileSync(
    new URL("../.github/workflows/deploy-workbench.yml", import.meta.url),
    "utf8",
  );
  const monitor = readFileSync(
    new URL("../.github/workflows/deploy-monitor.yml", import.meta.url),
    "utf8",
  );

  for (const workflow of [pages, monitor]) {
    assert.match(
      workflow,
      /concurrency:\r?\n  group: cloudflare-workbench\r?\n  cancel-in-progress: false/,
    );
  }
  assert.match(pages, /Cloudflare deployment credentials are required/);
  assert.match(pages, /exit 1/);
  assert.match(pages, /npm run test:frontend/);
  assert.match(pages, /npm run check:workbench/);
  assert.match(pages, /npm run check:asset-version/);
  assert.doesNotMatch(pages, /available=(?:true|false)|steps\.cloudflare\.outputs\.available/);
  assert.match(pages, /migrations\/\*\*/);
  const migration = pages.indexOf("d1 migrations apply");
  const deployment = pages.indexOf("pages deploy public");
  const persistedIdentity = pages.indexOf("Persist deployment identity");
  const verification = pages.indexOf("Verify deployed Pages identity");
  assert.notEqual(migration, -1);
  assert.notEqual(deployment, -1);
  assert.equal(migration < deployment, true);
  assert.equal(deployment < persistedIdentity, true);
  assert.equal(persistedIdentity < verification, true);
  assert.match(pages, /Persist deployment identity/);
  assert.match(pages, /INSERT INTO deployment_metadata/);
  assert.match(
    pages,
    /d1 migrations apply\s+tradingagents-workbench\s+--remote\s+--config wrangler\.toml/,
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
  assert.match(
    workflow,
    /deploy-github-pages:\r?\n\s+needs: analyze-and-persist\r?\n\s+if: \$\{\{ vars\.ENABLE_GITHUB_PAGES == 'true' \}\}/,
  );
  for (const step of ["Setup Pages", "Upload site artifact", "Deploy to GitHub Pages"]) {
    assert.match(workflow, new RegExp(`- name: ${step}\\r?\\n`));
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
  const settings = monitorSettings();
  const db = sqliteWorkerD1(settings);
  await markBootstrapComplete(db, settings);
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
