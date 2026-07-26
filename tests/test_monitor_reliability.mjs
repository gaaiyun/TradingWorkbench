import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { monitorSettings } from "./helpers/monitor_settings.mjs";

const migrationUrl = new URL(
  "../migrations/0013_monitor_reliability.sql",
  import.meta.url,
);
const slotsUrl = new URL("../workers/monitor/src/slots.mjs", import.meta.url);
const schedulerUrl = new URL(
  "../workers/monitor/src/scheduler.mjs",
  import.meta.url,
);
const dispatchUrl = new URL(
  "../workers/monitor/src/github-dispatch.mjs",
  import.meta.url,
);
const workerUrl = new URL("../workers/monitor/src/index.mjs", import.meta.url);

function d1(sqlite) {
  return {
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: async () => sqlite.prepare(sql).get(...params) ?? null,
          all: async () => ({ results: [...sqlite.prepare(sql).all(...params)] }),
          run: async () => {
            const result = sqlite.prepare(sql).run(...params);
            return { meta: { changes: Number(result.changes) } };
          },
        }),
      };
    },
  };
}

function reliabilityDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE scheduled_slots (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      slot_type TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      expires_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      updated_at TEXT,
      lease_until TEXT,
      next_attempt_at TEXT,
      profile_revision TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      local_date TEXT NOT NULL,
      UNIQUE (profile_id, slot_type, scheduled_for)
    );
    CREATE TABLE full_analysis_reservations (
      slot_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      reserved_at TEXT NOT NULL,
      UNIQUE (profile_id, local_date, slot_id)
    );
    CREATE TABLE github_dispatch_outbox (
      slot_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL,
      post_attempt_count INTEGER NOT NULL DEFAULT 0,
      lookup_attempt_count INTEGER NOT NULL DEFAULT 0,
      external_run_id INTEGER,
      external_run_url TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE github_dispatch_receipts (
      slot_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      external_run_id INTEGER,
      external_run_url TEXT,
      accepted_at TEXT NOT NULL
    );
  `);
  return sqlite;
}

const task = {
  type: "closeFullAnalysis",
  schedule: "closeDeepAnalysis",
  localSlot: "2026-07-23T15:20",
  scheduledFor: "2026-07-23T07:20:00.000Z",
};

test("0013 migration persists immutable scheduler, dispatch, bootstrap, and provider health state", () => {
  assert.equal(existsSync(migrationUrl), true);
  const sql = readFileSync(migrationUrl, "utf8");
  for (const column of [
    "profile_revision",
    "payload_json",
    "payload_hash",
    "local_date",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN ${column}\\b`, "i"));
  }
  for (const table of [
    "full_analysis_reservations",
    "github_dispatch_outbox",
    "github_dispatch_receipts",
    "monitor_bootstrap_targets",
    "monitor_news_provider_health",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table}\\b`, "i"));
  }
  assert.match(sql, /CREATE TRIGGER[\s\S]+IMMUTABLE_SLOT_PAYLOAD/i);
});

test("a staged slot keeps its original profile payload across retry claims", async () => {
  const {
    claimScheduledSlot,
    finishScheduledSlot,
    stageScheduledSlot,
  } = await import(slotsUrl);
  const { scheduledPayloadForTask } = await import(schedulerUrl);
  const sqlite = reliabilityDatabase();
  const db = d1(sqlite);
  const original = monitorSettings().profiles[0];
  const snapshot = await scheduledPayloadForTask(
    original,
    task,
    "2026-07-23T00:00:00.000Z",
  );
  await stageScheduledSlot(db, {
    id: "slot-immutable",
    profileId: original.id,
    slotType: task.type,
    scheduledFor: task.scheduledFor,
    localDate: "2026-07-23",
    ...snapshot,
    now: new Date("2026-07-23T07:20:00.000Z"),
  });
  const first = await claimScheduledSlot(db, {
    id: "slot-immutable",
    payloadHash: snapshot.payloadHash,
    now: new Date("2026-07-23T07:20:00.000Z"),
  });
  await finishScheduledSlot(db, {
    id: first.id,
    attemptCount: first.attemptCount,
    status: "failed",
    errorCode: "UPSTREAM",
    now: new Date("2026-07-23T07:20:01.000Z"),
  });
  const retry = await claimScheduledSlot(db, {
    id: "slot-immutable",
    payloadHash: snapshot.payloadHash,
    now: new Date("2026-07-23T07:25:01.000Z"),
  });
  assert.deepEqual(retry.profile, original);
  assert.deepEqual(retry.task, task);
  assert.equal(retry.profileRevision, "2026-07-23T00:00:00.000Z");
  assert.equal(
    await claimScheduledSlot(db, {
      id: "slot-immutable",
      payloadHash: "changed-payload",
      now: new Date("2026-07-23T07:30:01.000Z"),
    }),
    null,
  );
});

test("deleted, disabled, or revised profiles cancel retryable old slots explicitly", async () => {
  const { cancelStaleScheduledSlots } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  sqlite.exec(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, expires_at,
      attempt_count, updated_at, next_attempt_at, profile_revision,
      payload_json, payload_hash, local_date
    ) VALUES
      ('deleted', 'gone', 'intradayCollect', '2026-07-23T01:30:00Z',
       'failed', '2026-10-01T00:00:00Z', 1, '2026-07-23T01:30:00Z',
       '2026-07-23T01:35:00Z', 'r1', '{}', 'h1', '2026-07-23'),
      ('disabled', 'off', 'intradayCollect', '2026-07-23T01:30:00Z',
       'failed', '2026-10-01T00:00:00Z', 1, '2026-07-23T01:30:00Z',
       '2026-07-23T01:35:00Z', 'r1', '{}', 'h2', '2026-07-23'),
      ('revised', 'changed', 'intradayCollect', '2026-07-23T01:30:00Z',
       'failed', '2026-10-01T00:00:00Z', 1, '2026-07-23T01:30:00Z',
       '2026-07-23T01:35:00Z', 'r1', '{}', 'h3', '2026-07-23');
  `);
  const result = await cancelStaleScheduledSlots(
    d1(sqlite),
    new Map([
      ["off", { enabled: false, revision: "r1" }],
      ["changed", { enabled: true, revision: "r2" }],
    ]),
    new Date("2026-07-23T01:36:00.000Z"),
  );
  assert.equal(result.changed, 3);
  assert.deepEqual(
    [...sqlite.prepare(`
      SELECT id, status, last_error_code FROM scheduled_slots ORDER BY id
    `).all()].map((row) => ({ ...row })),
    [
      { id: "deleted", status: "cancelled", last_error_code: "PROFILE_DELETED" },
      { id: "disabled", status: "cancelled", last_error_code: "PROFILE_DISABLED" },
      { id: "revised", status: "cancelled", last_error_code: "PROFILE_REVISED" },
    ],
  );
});

test("full analysis reservations enforce a concurrent daily hard cap and retries reuse one reservation", async () => {
  const { reserveFullAnalysisBudget } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const db = d1(sqlite);
  const results = await Promise.all([
    reserveFullAnalysisBudget(db, {
      slotId: "slot-a",
      profileId: "profile-a",
      localDate: "2026-07-23",
      limit: 1,
      now: new Date("2026-07-23T07:20:00.000Z"),
    }),
    reserveFullAnalysisBudget(db, {
      slotId: "slot-b",
      profileId: "profile-a",
      localDate: "2026-07-23",
      limit: 1,
      now: new Date("2026-07-23T07:20:00.000Z"),
    }),
  ]);
  assert.equal(results.filter(({ reserved }) => reserved).length, 1);
  const winner = results.find(({ reserved }) => reserved).slotId;
  assert.deepEqual(
    await reserveFullAnalysisBudget(db, {
      slotId: winner,
      profileId: "profile-a",
      localDate: "2026-07-23",
      limit: 1,
      now: new Date("2026-07-23T07:25:00.000Z"),
    }),
    { reserved: true, slotId: winner, reused: true },
  );
  assert.equal(
    (await reserveFullAnalysisBudget(db, {
      slotId: "slot-zero",
      profileId: "profile-zero",
      localDate: "2026-07-23",
      limit: 0,
      now: new Date("2026-07-23T07:20:00.000Z"),
    })).reserved,
    false,
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM full_analysis_reservations").get().count,
    1,
  );
});

test("an accepted dispatch with a thrown client response is reconciled by deterministic run name before another POST", async () => {
  const { dispatchFullAnalysis } = await import(dispatchUrl);
  const sqlite = reliabilityDatabase();
  const calls = [];
  let accepted = false;
  const result = await dispatchFullAnalysis({
    db: d1(sqlite),
    env: {
      GITHUB_DISPATCH_TOKEN: "token",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_WORKFLOW_ID: "daily-analysis.yml",
    },
    fetcher: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      if (init.method === "POST") {
        accepted = true;
        throw new TypeError("response lost");
      }
      return Response.json({
        workflow_runs: accepted
          ? [{
              id: 42,
              html_url: "https://github.com/owner/repo/actions/runs/42",
              display_title:
                "Daily analysis · etf-main · slot-uncertain · 2026-07-23T07:20:00.000Z",
            }]
          : [],
      });
    },
    profile: monitorSettings().profiles[0],
    slotId: "slot-uncertain",
    payloadHash: "payload-uncertain",
    scheduledFor: "2026-07-23T07:20:00.000Z",
    now: new Date("2026-07-23T07:20:00.000Z"),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.dispatchState, "reconciled");
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET"]);
  assert.equal(
    sqlite.prepare(`
      SELECT external_run_id FROM github_dispatch_receipts
      WHERE slot_id = 'slot-uncertain'
    `).get().external_run_id,
    42,
  );
});

test("bootstrap identity is isolated by profile, symbol, timeframe, schema, and target hash", async () => {
  const { bootstrapRequirementsForProfile } = await import(schedulerUrl);
  const profileA = monitorSettings().profiles[0];
  const profileB = structuredClone(profileA);
  profileB.id = "etf-second";
  profileB.targets = [profileB.targets[0]];
  const completed = new Set();
  const firstA = await bootstrapRequirementsForProfile(profileA, completed);
  for (const item of firstA) completed.add(item.identity);
  assert.equal(
    (await bootstrapRequirementsForProfile(profileA, completed)).length,
    0,
  );
  assert.ok(
    (await bootstrapRequirementsForProfile(profileB, completed)).length > 0,
    "another profile's existing bootstrap data must not suppress this profile",
  );
  const expanded = structuredClone(profileA);
  expanded.targets.push({
    symbol: "510300.SS",
    name: "沪深 300 ETF",
    market: "CN",
    role: "comparison",
    analysis: "signal",
  });
  const delta = await bootstrapRequirementsForProfile(expanded, completed);
  assert.ok(delta.some(({ symbol }) => symbol === "510300.SS"));
  assert.ok(delta.every(({ identity }) =>
    /^bootstrap:[^:]+:[^:]+:[^:]+:v\d+:[a-f0-9]{64}$/.test(identity)));
});

test("direct fallback selects a fair backlog without exceeding forty estimated external requests", async () => {
  const {
    estimateTaskExternalRequests,
    selectFairWorkWithinBudget,
  } = await import(schedulerUrl);
  const profiles = ["a", "b", "c"].map((id) => ({
    ...structuredClone(monitorSettings().profiles[0]),
    id,
  }));
  const backlog = profiles.flatMap((profile) =>
    Array.from({ length: 3 }, (_, index) => ({
      id: `${profile.id}-${index}`,
      profile,
      task: {
        type: "intradayCollect",
        schedule: "cnIntraday/collect",
        localSlot: `2026-07-23T09:${30 + index * 5}`,
        scheduledFor: `2026-07-23T01:${30 + index * 5}:00.000Z`,
      },
    })));
  assert.equal(
    estimateTaskExternalRequests(backlog[0].profile, backlog[0].task),
    6,
  );
  const first = selectFairWorkWithinBudget(backlog, {
    externalRequestBudget: 40,
    rotation: 0,
  });
  assert.ok(first.estimatedExternalRequests <= 40);
  assert.ok(first.deferred.length > 0);
  assert.deepEqual(
    new Set(first.selected.map(({ profile }) => profile.id)),
    new Set(["a", "b", "c"]),
  );
  const second = selectFairWorkWithinBudget(backlog, {
    externalRequestBudget: 40,
    rotation: 1,
  });
  assert.notEqual(first.selected[0].profile.id, second.selected[0].profile.id);
});

test("queue consumer claims slotId and payload hash through D1 before executing a message", async () => {
  const { runQueueBatch } = await import(workerUrl);
  const { scheduledPayloadForTask } = await import(schedulerUrl);
  const { stageScheduledSlot } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const db = d1(sqlite);
  const profile = monitorSettings().profiles[0];
  const signalTask = {
    type: "intradaySignal",
    schedule: "cnIntraday/signal",
    localSlot: "2026-07-23T09:30",
    scheduledFor: "2026-07-23T01:30:00.000Z",
  };
  const snapshot = await scheduledPayloadForTask(profile, signalTask, "r1");
  await stageScheduledSlot(db, {
    id: "slot-queue",
    profileId: profile.id,
    slotType: signalTask.type,
    scheduledFor: signalTask.scheduledFor,
    localDate: "2026-07-23",
    ...snapshot,
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  const executions = [];
  const messages = [
    {
      body: { slotId: "slot-queue", payloadHash: snapshot.payloadHash },
      ack() {},
      retry() { assert.fail("valid message should not be retried"); },
    },
    {
      body: { slotId: "slot-queue", payloadHash: snapshot.payloadHash },
      ack() {},
      retry() { assert.fail("duplicate message should be acknowledged"); },
    },
  ];
  const summary = await runQueueBatch(messages, { DB: db }, {
    executeTask: async (input) => {
      executions.push(input);
      return { status: "completed" };
    },
    now: () => new Date("2026-07-23T01:30:01.000Z"),
    skipProfileRevisionCheck: true,
  });
  assert.equal(executions.length, 1);
  assert.equal(executions[0].profile.id, "etf-main");
  assert.equal(summary.mode, "queue");
  assert.equal(summary.counts.claimed, 1);
  assert.equal(summary.counts.skipped, 1);
  assert.equal(
    sqlite.prepare("SELECT status FROM scheduled_slots WHERE id = 'slot-queue'")
      .get().status,
    "completed",
  );
});
