import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationUrl = new URL("../migrations/0001_workbench_dynamic.sql", import.meta.url);
const healthMigrationUrl = new URL(
  "../migrations/0002_provider_circuit_breaker.sql",
  import.meta.url,
);

test("D1 migration defines every dynamic workbench table and its lookup indexes", () => {
  const sql = readFileSync(migrationUrl, "utf8");
  const tables = [
    "workbench_settings",
    "market_bars",
    "news_items",
    "market_events",
    "source_health",
    "scheduled_slots",
    "research_runs",
    "chat_sessions",
    "chat_messages",
  ];

  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"));
  }

  assert.match(sql, /profile_id\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+''/i);
  assert.match(sql, /UNIQUE\s*\(\s*profile_id\s*,\s*symbol\s*,\s*timeframe\s*,\s*ts\s*,\s*source\s*,\s*adjustment\s*\)/i);
  assert.match(sql, /CREATE INDEX[^;]+market_bars[^;]+symbol[^;]+timeframe[^;]+ts/i);
  assert.match(sql, /CREATE INDEX[^;]+news_items[^;]+symbol[^;]+published_at/i);
  assert.match(sql, /CREATE INDEX[^;]+market_events[^;]+profile_id[^;]+event_at/i);
  assert.match(sql, /(?:expires_at|retention_until|delete_after)/i);
});

test("D1 migration stores stable source metadata on dynamic records", () => {
  const sql = readFileSync(migrationUrl, "utf8");
  for (const column of ["source", "as_of", "fetched_at", "freshness", "adjustment", "quality"]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "i"));
  }
  assert.match(sql, /workbench_settings[\s\S]+version[\s\S]+updated_at/i);
  assert.match(sql, /source_health[\s\S]+status\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*status\s+IN\s*\(\s*'ok'\s*,\s*'degraded'\s*,\s*'stale'\s*,\s*'unavailable'\s*\)\s*\)/i);
});

test("market bar uniqueness is profile-scoped and source health rejects unknown states", async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const sql = readFileSync(migrationUrl, "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  const insertBar = db.prepare(`
    INSERT INTO market_bars (
      profile_id, symbol, timeframe, ts, source, as_of, fetched_at,
      freshness, adjustment, quality, expires_at
    ) VALUES (?, 'SPY', '5m', '2026-07-23T10:00:00Z', 'wire',
      '2026-07-23T10:00:00Z', '2026-07-23T10:00:01Z', 'fresh', 'none', 'good',
      '2099-01-01T00:00:00Z')
  `);
  insertBar.run("profile-a");
  insertBar.run("profile-b");
  assert.equal(db.prepare("SELECT count(*) AS count FROM market_bars").get().count, 2);
  assert.throws(() => insertBar.run("profile-a"), /UNIQUE constraint failed/i);
  assert.throws(() => db.prepare(`
    INSERT INTO source_health (source, status, expires_at)
    VALUES ('wire', 'mystery', '2099-01-01T00:00:00Z')
  `).run(), /CHECK constraint failed/i);
});

test("provider health migration adds durable circuit-breaker state without widening public status", async (t) => {
  const sql = readFileSync(healthMigrationUrl, "utf8");
  for (const column of [
    "consecutive_failures",
    "paused_until",
    "last_error_code",
    "last_success_at",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN ${column}\\b`, "i"));
  }
  assert.doesNotMatch(sql, /status[^;]+circuit_open/i);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(migrationUrl, "utf8"));
  db.prepare(`
    INSERT INTO source_health (source, status, expires_at)
    VALUES ('legacy', 'ok', '2099-01-01T00:00:00Z')
  `).run();
  db.exec(sql);
  const row = db.prepare(`
    SELECT consecutive_failures, paused_until, last_error_code, last_success_at
    FROM source_health WHERE source = 'legacy'
  `).get();
  assert.deepEqual({ ...row }, {
    consecutive_failures: 0,
    paused_until: null,
    last_error_code: null,
    last_success_at: null,
  });
});
