import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const slotUrl = new URL("../workers/monitor/src/slots.mjs", import.meta.url);
const migration1 = readFileSync(
  new URL("../migrations/0001_workbench_dynamic.sql", import.meta.url),
  "utf8",
);
const migration2 = readFileSync(
  new URL("../migrations/0002_provider_circuit_breaker.sql", import.meta.url),
  "utf8",
);
const migration3Url = new URL(
  "../migrations/0003_monitor_scheduled_slots.sql",
  import.meta.url,
);

function d1(sqlite) {
  return {
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: async () => sqlite.prepare(sql).get(...params) ?? null,
          run: async () => sqlite.prepare(sql).run(...params),
        }),
      };
    },
  };
}

function freshDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration1);
  sqlite.exec(migration2);
  sqlite.exec(readFileSync(migration3Url, "utf8"));
  return sqlite;
}

const claimInput = {
  id: "slot-1",
  profileId: "etf-main",
  slotType: "intradayCollect",
  scheduledFor: "2026-07-23T01:30:00.000Z",
  now: new Date("2026-07-23T01:30:01.000Z"),
};

test("monitor migration adds durable retry and error bookkeeping", () => {
  const sql = readFileSync(migration3Url, "utf8");
  assert.match(sql, /ADD COLUMN attempt_count\b/i);
  assert.match(sql, /ADD COLUMN last_error_code\b/i);
  assert.match(sql, /ADD COLUMN updated_at\b/i);
});

test("duplicate and concurrent claims execute a new slot only once", async () => {
  const { claimScheduledSlot } = await import(slotUrl);
  const sqlite = freshDatabase();
  const db = d1(sqlite);
  const claims = await Promise.all([
    claimScheduledSlot(db, claimInput),
    claimScheduledSlot(db, claimInput),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(
    sqlite.prepare("SELECT attempt_count FROM scheduled_slots WHERE id = ?").get("slot-1")
      .attempt_count,
    1,
  );
});

test("DST fallback UTC duplicates with the same local slot id are safely deduplicated", async () => {
  const { claimScheduledSlot } = await import(slotUrl);
  const sqlite = freshDatabase();
  const db = d1(sqlite);
  assert.ok(await claimScheduledSlot(db, {
    ...claimInput,
    id: "slot-fallback-local-0130",
    scheduledFor: "2026-11-01T05:30:00.000Z",
  }));
  assert.equal(
    await claimScheduledSlot(db, {
      ...claimInput,
      id: "slot-fallback-local-0130",
      scheduledFor: "2026-11-01T06:30:00.000Z",
    }),
    null,
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM scheduled_slots").get().count,
    1,
  );
});

test("failed slots retry up to three total attempts but completed slots never retry", async () => {
  const { claimScheduledSlot, finishScheduledSlot } = await import(slotUrl);
  const sqlite = freshDatabase();
  const db = d1(sqlite);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claim = await claimScheduledSlot(db, claimInput);
    assert.equal(claim.attemptCount, attempt);
    await finishScheduledSlot(db, {
      id: claimInput.id,
      status: "failed",
      errorCode: `FAIL_${attempt}`,
      now: new Date(`2026-07-23T01:3${attempt}:00.000Z`),
    });
  }
  assert.equal(await claimScheduledSlot(db, claimInput), null);

  const completedInput = {
    ...claimInput,
    id: "slot-2",
    scheduledFor: "2026-07-23T01:35:00.000Z",
  };
  assert.ok(await claimScheduledSlot(db, completedInput));
  await finishScheduledSlot(db, {
    id: completedInput.id,
    status: "completed",
    now: new Date("2026-07-23T01:35:00.000Z"),
  });
  assert.equal(await claimScheduledSlot(db, completedInput), null);
});

test("deferred hook slots are terminal and all SQL values stay parameterized", async () => {
  const { claimScheduledSlot, finishScheduledSlot } = await import(slotUrl);
  const sqlite = freshDatabase();
  const statements = [];
  const db = {
    prepare(sql) {
      statements.push(sql);
      return d1(sqlite).prepare(sql);
    },
  };
  const hostile = { ...claimInput, id: "slot-hostile", profileId: "x' OR 1=1 --" };
  assert.ok(await claimScheduledSlot(db, hostile));
  await finishScheduledSlot(db, {
    id: hostile.id,
    status: "deferred",
    errorCode: "HOOK_NOT_IMPLEMENTED",
    now: claimInput.now,
  });
  assert.equal(await claimScheduledSlot(db, hostile), null);
  assert.equal(statements.some((sql) => sql.includes(hostile.profileId)), false);
});
