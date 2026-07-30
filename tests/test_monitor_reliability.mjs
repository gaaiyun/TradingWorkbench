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
  const workflow = readFileSync(
    new URL("../.github/workflows/daily-analysis.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /format\('profile · monitor · \{0\} · \{1\} · \{2\}', inputs\.profileId, inputs\.slotId, inputs\.scheduledFor\)/,
  );
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
                "Daily analysis · profile · monitor · etf-main · slot-uncertain · 2026-07-23T07:20:00.000Z",
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

test("profile revisions hash one profile so editing B does not cancel A", async () => {
  const {
    profileRevisionForProfile,
    scheduledPayloadForTask,
  } = await import(schedulerUrl);
  const {
    cancelStaleScheduledSlots,
    stageScheduledSlot,
  } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const db = d1(sqlite);
  const profileA = monitorSettings().profiles[0];
  const profileB = structuredClone(profileA);
  profileB.id = "etf-second";
  const revisionA = await profileRevisionForProfile(profileA);
  const revisionB = await profileRevisionForProfile(profileB);
  for (const profile of [profileA, profileB]) {
    const revision = profile.id === profileA.id ? revisionA : revisionB;
    const snapshot = await scheduledPayloadForTask(profile, task, revision);
    await stageScheduledSlot(db, {
      id: `slot-${profile.id}`,
      profileId: profile.id,
      slotType: task.type,
      scheduledFor: task.scheduledFor,
      localDate: "2026-07-23",
      ...snapshot,
      now: new Date("2026-07-23T07:20:00.000Z"),
    });
  }
  const revisedB = structuredClone(profileB);
  revisedB.name = "仅修改 B";
  const result = await cancelStaleScheduledSlots(
    db,
    new Map([
      [profileA.id, { enabled: true, revision: await profileRevisionForProfile(profileA) }],
      [profileB.id, { enabled: true, revision: await profileRevisionForProfile(revisedB) }],
    ]),
    new Date("2026-07-23T07:21:00.000Z"),
  );
  assert.equal(result.changed, 1);
  assert.deepEqual(
    [...sqlite.prepare(`
      SELECT profile_id, status FROM scheduled_slots ORDER BY profile_id
    `).all()].map((row) => ({ ...row })),
    [
      { profile_id: "etf-main", status: "pending" },
      { profile_id: "etf-second", status: "cancelled" },
    ],
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

test("direct fallback uses real upper bounds, clamps at forty, and shards fourteen targets", async () => {
  const {
    estimateTaskExternalRequests,
    scheduledPayloadForTask,
    selectFairWorkWithinBudget,
    splitTaskWithinRequestLimit,
  } = await import(schedulerUrl);
  const { stageScheduledSlots } = await import(slotsUrl);
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
  const fourteenTargetProfile = structuredClone(profiles[0]);
  fourteenTargetProfile.targets = Array.from({ length: 14 }, (_, index) => ({
    symbol: `CN-${index}`,
    name: `CN ${index}`,
    market: "CN",
    role: index === 0 ? "core" : "comparison",
    analysis: "signal",
  }));
  const shards = splitTaskWithinRequestLimit(
    fourteenTargetProfile,
    backlog[0].task,
    32,
  );
  assert.equal(shards.length, 2);
  assert.equal(
    new Set(shards.map(({ scheduledFor }) => scheduledFor)).size,
    2,
    "every shard needs a distinct dispatch timestamp under the legacy unique key",
  );
  assert.equal(
    new Set(shards.flatMap(({ targetSymbols }) => targetSymbols)).size,
    14,
  );
  assert.ok(shards.every((shard) =>
    estimateTaskExternalRequests(fourteenTargetProfile, shard) <= 32));
  const sqlite = reliabilityDatabase();
  const staged = await stageScheduledSlots(
    d1(sqlite),
    await Promise.all(shards.map(async (shard, index) => ({
      id: `shard-${index}`,
      profileId: fourteenTargetProfile.id,
      slotType: shard.type,
      scheduledFor: shard.scheduledFor,
      localDate: "2026-07-23",
      ...await scheduledPayloadForTask(
        fourteenTargetProfile,
        shard,
        "r1",
      ),
      now: new Date("2026-07-23T01:30:00.000Z"),
    }))),
  );
  assert.equal(staged.staged, 2);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM scheduled_slots").get().count,
    2,
  );
  const { collectForTask } = await import(
    "../workers/monitor/src/collector.mjs"
  );
  const fetchedSymbols = [];
  const collected = await collectForTask({
    taskType: shards[0].type,
    task: shards[0],
    profile: fourteenTargetProfile,
    registry: {
      async fetchMarketData(request) {
        fetchedSymbols.push(request.symbol);
        return {
          status: "ok",
          bars: [{ symbol: request.symbol }],
          sources: [],
        };
      },
    },
    writeBars: async () => {},
    db: {},
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  assert.equal(collected.status, "completed");
  assert.deepEqual(fetchedSymbols, shards[0].targetSymbols);
  const first = selectFairWorkWithinBudget(backlog, {
    externalRequestBudget: 999,
    rotation: 0,
  });
  assert.equal(first.externalRequestBudget, 40);
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

test("us close snapshot shards coexist under the legacy scheduled slot unique key", async () => {
  const {
    scheduledPayloadForTask,
    splitTaskWithinRequestLimit,
  } = await import(schedulerUrl);
  const { stageScheduledSlots } = await import(slotsUrl);
  const profile = structuredClone(monitorSettings().profiles[0]);
  profile.targets = [
    ...["SOXX", "SMH", "NVDA", "TSM", "AVGO", "AMD", "ASML", "ORCL", "GOOGL"]
      .map((symbol) => ({
        symbol,
        name: symbol,
        market: "US",
        role: "driver",
        analysis: "signal",
      })),
    {
      symbol: "3887.HK",
      name: "HashKey Holdings",
      market: "HK",
      role: "driver",
      analysis: "signal",
    },
  ];
  const baseTask = {
    type: "usCloseSnapshot",
    schedule: "usCloseSnapshot",
    localSlot: "2026-07-30T05:35",
    scheduledFor: "2026-07-29T21:35:00.000Z",
  };
  const shards = splitTaskWithinRequestLimit(profile, baseTask, 32);
  assert.equal(shards.length, 2);
  assert.equal(new Set(shards.map(({ scheduledFor }) => scheduledFor)).size, 2);

  const sqlite = reliabilityDatabase();
  const result = await stageScheduledSlots(
    d1(sqlite),
    await Promise.all(shards.map(async (shard, index) => ({
      id: `us-close-shard-${index}`,
      profileId: profile.id,
      slotType: shard.type,
      scheduledFor: shard.scheduledFor,
      localDate: "2026-07-30",
      ...await scheduledPayloadForTask(profile, shard, "r1"),
      now: new Date("2026-07-29T21:35:00.000Z"),
    }))),
  );

  assert.deepEqual(result, { discovered: 2, staged: 2, conflicted: 0 });
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM scheduled_slots").get().count,
    2,
  );
});

test("slot staging distinguishes a true unique collision from an idempotent duplicate", async () => {
  const { stageScheduledSlots } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const sqliteD1 = d1(sqlite);
  let identityQueries = 0;
  const db = {
    prepare(sql) {
      if (/json_each/i.test(sql)) identityQueries += 1;
      return sqliteD1.prepare(sql);
    },
  };
  const common = {
    profileId: "profile-a",
    slotType: "usCloseSnapshot",
    scheduledFor: "2026-07-29T21:35:00.000Z",
    localDate: "2026-07-30",
    profileRevision: "r1",
    now: new Date("2026-07-29T21:35:00.000Z"),
  };
  const inputs = [
    {
      ...common,
      id: "slot-first",
      payloadJson: '{"profile":{"id":"profile-a"},"task":{"type":"usCloseSnapshot","part":1}}',
      payloadHash: "hash-first",
    },
    {
      ...common,
      id: "slot-colliding",
      payloadJson: '{"profile":{"id":"profile-a"},"task":{"type":"usCloseSnapshot","part":2}}',
      payloadHash: "hash-colliding",
    },
    {
      ...common,
      id: "slot-colliding-2",
      payloadJson: '{"profile":{"id":"profile-a"},"task":{"type":"usCloseSnapshot","part":3}}',
      payloadHash: "hash-colliding-2",
    },
    {
      ...common,
      id: "slot-colliding-3",
      payloadJson: '{"profile":{"id":"profile-a"},"task":{"type":"usCloseSnapshot","part":4}}',
      payloadHash: "hash-colliding-3",
    },
  ];

  assert.deepEqual(
    await stageScheduledSlots(db, inputs),
    { discovered: 4, staged: 1, conflicted: 3 },
  );
  assert.equal(identityQueries, 1);
  assert.deepEqual(
    await stageScheduledSlots(db, [inputs[0]]),
    { discovered: 1, staged: 0, conflicted: 0 },
  );
  assert.equal(identityQueries, 2);
});

test("selector budgets signal D1 work and caps two hundred zero-fetch tasks fairly", async () => {
  const {
    estimateTaskExternalRequests,
    selectFairWorkWithinBudget,
  } = await import(schedulerUrl);
  const template = monitorSettings().profiles[0];
  const profiles = Array.from({ length: 14 }, (_, profileIndex) => ({
    ...structuredClone(template),
    id: `profile-${String(profileIndex).padStart(2, "0")}`,
    targets: Array.from({ length: 14 }, (_, targetIndex) => ({
      symbol: `${profileIndex}-${targetIndex}.SS`,
      name: `Target ${profileIndex}-${targetIndex}`,
      market: "CN",
      role: targetIndex === 0 ? "core" : "comparison",
      analysis: "signal",
    })),
  }));
  const signalWork = Array.from({ length: 200 }, (_, index) => {
    const profile = profiles[index % profiles.length];
    return {
      id: `signal-${index}`,
      profile,
      task: {
        type: "intradaySignal",
        scheduledFor: new Date(
          Date.parse("2026-07-23T01:30:00.000Z") + index * 60_000,
        ).toISOString(),
      },
    };
  });
  assert.equal(
    estimateTaskExternalRequests(signalWork[0].profile, signalWork[0].task),
    14,
  );
  assert.equal(
    estimateTaskExternalRequests(profiles[0], { type: "premarketBrief" }),
    1,
  );

  const signals = selectFairWorkWithinBudget(signalWork, {
    externalRequestBudget: 32,
  });
  assert.equal(signals.selected.length, 2);
  assert.equal(signals.deferred.length, 198);
  assert.ok(signals.estimatedExternalRequests <= 32);
  assert.equal(
    new Set(signals.selected.map(({ profile }) => profile.id)).size,
    2,
  );
  assert.deepEqual(
    new Set(signals.deferred.map(({ profile }) => profile.id)),
    new Set(profiles.map(({ id }) => id)),
  );

  const briefs = selectFairWorkWithinBudget(
    Array.from({ length: 200 }, (_, index) => ({
      id: `brief-${index}`,
      profile: profiles[index % profiles.length],
      task: { type: "premarketBrief" },
    })),
    { externalRequestBudget: 40 },
  );
  assert.equal(briefs.selected.length, 32);
  assert.equal(briefs.deferred.length, 168);
  assert.equal(
    new Set(briefs.selected.map(({ profile }) => profile.id)).size,
    profiles.length,
  );
});

test("backlog SQL admits B before a two-hundred-row A prefix can starve it", async () => {
  const { listRetryableSlots } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const insert = sqlite.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, expires_at,
      attempt_count, updated_at, next_attempt_at, profile_revision,
      payload_json, payload_hash, local_date
    ) VALUES (?, ?, 'intradaySignal', ?, 'pending', ?, 0, ?, ?, 'r1', ?, ?, ?)
  `);
  for (let index = 0; index < 205; index += 1) {
    const scheduledFor = new Date(
      Date.parse("2026-07-22T00:00:00.000Z") + index * 60_000,
    ).toISOString();
    insert.run(
      `a-${index}`,
      "profile-a",
      scheduledFor,
      "2026-10-01T00:00:00.000Z",
      scheduledFor,
      scheduledFor,
      JSON.stringify({
        profile: { id: "profile-a" },
        task: { type: "intradaySignal", scheduledFor },
      }),
      `ha-${index}`,
      "2026-07-22",
    );
  }
  insert.run(
    "b-0",
    "profile-b",
    "2026-07-23T00:00:00.000Z",
    "2026-10-01T00:00:00.000Z",
    "2026-07-23T00:00:00.000Z",
    "2026-07-23T00:00:00.000Z",
    JSON.stringify({
      profile: { id: "profile-b" },
      task: {
        type: "intradaySignal",
        scheduledFor: "2026-07-23T00:00:00.000Z",
      },
    }),
    "hb-0",
    "2026-07-23",
  );
  const rows = await listRetryableSlots(
    d1(sqlite),
    new Date("2026-07-24T00:00:00.000Z"),
    200,
  );
  assert.equal(rows.length, 200);
  assert.ok(rows.some(({ profile_id: profileId }) => profileId === "profile-b"));
});

test("retry backlog prioritizes market collection before news at the same slot", async () => {
  const { listRetryableSlots } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const insert = sqlite.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, expires_at,
      attempt_count, updated_at, next_attempt_at, profile_revision,
      payload_json, payload_hash, local_date
    ) VALUES (?, 'profile-a', ?, '2026-07-23T13:45:00.000Z',
      'pending', '2026-10-01T00:00:00.000Z', 0,
      '2026-07-23T13:45:00.000Z', '2026-07-23T13:45:00.000Z',
      'r1', ?, ?, '2026-07-23')
  `);
  for (const type of ["newsCollect", "usIntradayCollect"]) {
    insert.run(
      type,
      type,
      JSON.stringify({
        profile: { id: "profile-a" },
        task: { type, scheduledFor: "2026-07-23T13:45:00.000Z" },
      }),
      `hash-${type}`,
    );
  }
  const rows = await listRetryableSlots(
    d1(sqlite),
    new Date("2026-07-23T14:00:00.000Z"),
    2,
  );
  assert.deepEqual(
    rows.map(({ slot_type: slotType }) => slotType),
    ["usIntradayCollect", "newsCollect"],
  );
});

test("retry backlog completes offset daily shards before close analysis", async () => {
  const { listRetryableSlots } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const insert = sqlite.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, expires_at,
      attempt_count, updated_at, next_attempt_at, profile_revision,
      payload_json, payload_hash, local_date
    ) VALUES (?, 'profile-a', ?, ?, 'pending',
      '2026-10-01T00:00:00.000Z', 0, ?, ?, 'r1', ?, ?, '2026-07-23')
  `);
  const rows = [
    ["daily-0", "cnDailySnapshot", "2026-07-23T07:20:00.000Z"],
    ["analysis", "closeFullAnalysis", "2026-07-23T07:20:00.000Z"],
    ["daily-1", "cnDailySnapshot", "2026-07-23T07:20:01.000Z"],
    ["daily-2", "cnDailySnapshot", "2026-07-23T07:20:02.000Z"],
  ];
  for (const [id, type, scheduledFor] of rows) {
    insert.run(
      id,
      type,
      scheduledFor,
      scheduledFor,
      scheduledFor,
      JSON.stringify({
        profile: { id: "profile-a" },
        task: { type, scheduledFor },
      }),
      `hash-${id}`,
    );
  }

  const retryable = await listRetryableSlots(
    d1(sqlite),
    new Date("2026-07-23T08:00:00.000Z"),
    4,
  );
  assert.deepEqual(
    retryable.map(({ id }) => id),
    ["daily-0", "daily-1", "daily-2", "analysis"],
  );
});

test("retry backlog does not let a newer market day starve an older analysis", async () => {
  const { listRetryableSlots } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const insert = sqlite.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, expires_at,
      attempt_count, updated_at, next_attempt_at, profile_revision,
      payload_json, payload_hash, local_date
    ) VALUES (?, 'profile-a', ?, ?, 'pending',
      '2026-10-01T00:00:00.000Z', 0, ?, ?, 'r1', ?, ?, ?)
  `);
  const rows = [
    ["older-analysis", "closeFullAnalysis", "2026-07-23T07:20:00.000Z", "2026-07-23"],
    ["newer-market", "usCloseSnapshot", "2026-07-23T21:35:00.000Z", "2026-07-24"],
  ];
  for (const [id, type, scheduledFor, localDate] of rows) {
    insert.run(
      id,
      type,
      scheduledFor,
      scheduledFor,
      scheduledFor,
      JSON.stringify({
        profile: { id: "profile-a" },
        task: { type, scheduledFor },
      }),
      `hash-${id}`,
      localDate,
    );
  }

  const retryable = await listRetryableSlots(
    d1(sqlite),
    new Date("2026-07-24T08:00:00.000Z"),
    2,
  );
  assert.deepEqual(
    retryable.map(({ id }) => id),
    ["older-analysis", "newer-market"],
  );
});

test("superseded high-frequency backlog is cancelled while the newest slot remains", async () => {
  const { cancelSupersededScheduledSlots } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const insert = sqlite.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, expires_at,
      attempt_count, updated_at, lease_until, next_attempt_at,
      profile_revision, payload_json, payload_hash, local_date
    ) VALUES (?, 'profile-a', ?, ?, ?, '2026-10-01T00:00:00.000Z',
      ?, ?, ?, ?, 'r1', ?, ?, '2026-07-23')
  `);
  const rows = [
    ["old-market", "usIntradayCollect", "2026-07-23T13:45:00.000Z", "pending", 0],
    ["new-market", "usIntradayCollect", "2026-07-23T14:00:00.000Z", "pending", 0],
    ["old-news", "newsCollect", "2026-07-23T13:45:00.000Z", "failed", 2],
    ["new-news", "newsCollect", "2026-07-23T14:00:00.000Z", "pending", 0],
    ["daily", "usCloseSnapshot", "2026-07-23T13:45:00.000Z", "pending", 0],
  ];
  for (const [id, type, scheduledFor, status, attempts] of rows) {
    insert.run(
      id,
      type,
      scheduledFor,
      status,
      attempts,
      scheduledFor,
      status === "claimed" ? scheduledFor : null,
      scheduledFor,
      JSON.stringify({
        profile: { id: "profile-a" },
        task: { type, scheduledFor },
      }),
      `hash-${id}`,
    );
  }
  const result = await cancelSupersededScheduledSlots(
    d1(sqlite),
    new Date("2026-07-23T14:05:00.000Z"),
  );
  assert.equal(result.changed, 2);
  const states = Object.fromEntries(
    sqlite.prepare(
      "SELECT id, status, last_error_code FROM scheduled_slots ORDER BY id",
    ).all().map((row) => [row.id, row]),
  );
  assert.equal(states["old-market"].status, "cancelled");
  assert.equal(states["old-market"].last_error_code, "SUPERSEDED_BY_NEWER_SLOT");
  assert.equal(states["old-news"].status, "cancelled");
  assert.equal(states["new-market"].status, "pending");
  assert.equal(states["new-news"].status, "pending");
  assert.equal(states.daily.status, "pending");
});

test("stale high-frequency slots expire even when no newer slot was discovered", async () => {
  const { cancelExpiredScheduledSlots } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const insert = sqlite.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, expires_at,
      attempt_count, updated_at, lease_until, next_attempt_at,
      profile_revision, payload_json, payload_hash, local_date
    ) VALUES (?, 'profile-a', ?, ?, ?, '2026-10-01T00:00:00.000Z',
      ?, ?, ?, ?, 'r1', '{}', ?, '2026-07-23')
  `);
  const rows = [
    ["old-cn", "intradayCollect", "2026-07-23T13:00:00.000Z", "pending", 0, null],
    ["old-signal", "intradaySignal", "2026-07-23T13:00:00.000Z", "failed", 1, null],
    ["old-us", "usIntradayCollect", "2026-07-23T13:00:00.000Z", "queued", 0, null],
    ["old-news", "newsCollect", "2026-07-23T13:00:00.000Z", "claimed", 1, "2026-07-23T13:20:00.000Z"],
    ["fresh-news", "newsCollect", "2026-07-23T13:50:00.000Z", "pending", 0, null],
    ["daily", "usCloseSnapshot", "2026-07-23T13:00:00.000Z", "pending", 0, null],
  ];
  for (const [id, type, scheduledFor, status, attempts, leaseUntil] of rows) {
    insert.run(
      id,
      type,
      scheduledFor,
      status,
      attempts,
      scheduledFor,
      leaseUntil,
      scheduledFor,
      `hash-${id}`,
    );
  }

  const result = await cancelExpiredScheduledSlots(
    d1(sqlite),
    new Date("2026-07-23T14:00:00.000Z"),
  );
  assert.equal(result.changed, 4);
  const states = Object.fromEntries(
    sqlite.prepare(`
      SELECT id, status, last_error_code
      FROM scheduled_slots
      ORDER BY id
    `).all().map((row) => [row.id, row]),
  );
  for (const id of ["old-cn", "old-signal", "old-us", "old-news"]) {
    assert.equal(states[id].status, "cancelled");
    assert.equal(states[id].last_error_code, "STALE_SLOT_EXPIRED");
  }
  assert.equal(states["fresh-news"].status, "pending");
  assert.equal(states.daily.status, "pending");
});

test("retry-exhausted backlog is finalized instead of remaining claimed or failed", async () => {
  const { finalizeExhaustedScheduledSlots } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const insert = sqlite.prepare(`
    INSERT INTO scheduled_slots (
      id, profile_id, slot_type, scheduled_for, status, expires_at,
      attempt_count, updated_at, lease_until, next_attempt_at,
      profile_revision, payload_json, payload_hash, local_date
    ) VALUES (?, 'profile-a', 'newsCollect', ?, ?,
      '2026-10-01T00:00:00.000Z', 3, '2026-07-23T14:00:00.000Z', ?, ?,
      'r1', '{}', ?, '2026-07-23')
  `);
  insert.run(
    "failed-max",
    "2026-07-23T13:45:00.000Z",
    "failed",
    null,
    "2026-07-23T14:05:00.000Z",
    "hash-failed",
  );
  insert.run(
    "claimed-max",
    "2026-07-23T13:46:00.000Z",
    "claimed",
    "2026-07-23T13:59:00.000Z",
    null,
    "hash-claimed",
  );

  const result = await finalizeExhaustedScheduledSlots(
    d1(sqlite),
    new Date("2026-07-23T14:05:00.000Z"),
  );
  assert.equal(result.changed, 2);
  const rows = sqlite.prepare(`
    SELECT status, last_error_code, lease_until, next_attempt_at
    FROM scheduled_slots ORDER BY id
  `).all();
  for (const row of rows) {
    assert.equal(row.status, "cancelled");
    assert.equal(row.last_error_code, "RETRY_EXHAUSTED");
    assert.equal(row.lease_until, null);
    assert.equal(row.next_attempt_at, null);
  }
});

test("queue consumer deduplicates one identity and retries unique work beyond its batch cap", async () => {
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
    {
      body: { slotId: "slot-queue-2", payloadHash: snapshot.payloadHash },
      ack() { assert.fail("unique work beyond the cap should not be acknowledged"); },
      retry() { retries += 1; },
    },
  ];
  await stageScheduledSlot(db, {
    id: "slot-queue-2",
    profileId: profile.id,
    slotType: signalTask.type,
    scheduledFor: "2026-07-23T01:35:00.000Z",
    localDate: "2026-07-23",
    ...snapshot,
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  let retries = 0;
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
  assert.equal(summary.counts.skipped, 0);
  assert.equal(summary.capped, 1);
  assert.equal(retries, 1);
  assert.equal(
    sqlite.prepare("SELECT status FROM scheduled_slots WHERE id = 'slot-queue'")
      .get().status,
    "completed",
  );
});

test("queue consumer terminally rejects a legacy oversized task with an observable code", async () => {
  const { runQueueBatch } = await import(workerUrl);
  const { scheduledPayloadForTask } = await import(schedulerUrl);
  const { stageScheduledSlot } = await import(slotsUrl);
  const sqlite = reliabilityDatabase();
  const db = d1(sqlite);
  const profile = structuredClone(monitorSettings().profiles[0]);
  profile.targets = Array.from({ length: 14 }, (_, index) => ({
    symbol: `CN-${index}`,
    name: `CN ${index}`,
    market: "CN",
    role: index === 0 ? "core" : "comparison",
    analysis: "signal",
  }));
  const oversizedTask = {
    type: "intradayCollect",
    schedule: "cnIntraday/collect",
    localSlot: "2026-07-23T09:30",
    scheduledFor: "2026-07-23T01:30:00.000Z",
  };
  const snapshot = await scheduledPayloadForTask(profile, oversizedTask, "r1");
  await stageScheduledSlot(db, {
    id: "slot-oversized",
    profileId: profile.id,
    slotType: oversizedTask.type,
    scheduledFor: oversizedTask.scheduledFor,
    localDate: "2026-07-23",
    ...snapshot,
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  const summary = await runQueueBatch([{
    body: { slotId: "slot-oversized", payloadHash: snapshot.payloadHash },
    ack() {},
    retry() { assert.fail("stable oversized work must not loop"); },
  }], { DB: db }, {
    executeTask: async () => assert.fail("oversized work must not execute"),
    now: () => new Date("2026-07-23T01:30:01.000Z"),
    skipProfileRevisionCheck: true,
  });
  assert.equal(summary.oversized, 1);
  assert.equal(summary.counts.deferred, 1);
  assert.deepEqual({ ...sqlite.prepare(`
    SELECT status, last_error_code
    FROM scheduled_slots
    WHERE id = 'slot-oversized'
  `).get() }, {
    status: "deferred",
    last_error_code: "TASK_EXTERNAL_REQUEST_LIMIT",
  });
});
