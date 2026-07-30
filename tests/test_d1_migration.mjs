import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationUrl = new URL("../migrations/0001_workbench_dynamic.sql", import.meta.url);
const healthMigrationUrl = new URL(
  "../migrations/0002_provider_circuit_breaker.sql",
  import.meta.url,
);
const seedMigrationUrl = new URL(
  "../migrations/0006_seed_workbench_settings.sql",
  import.meta.url,
);
const oracleMigrationUrl = new URL(
  "../migrations/0007_add_oracle_monitor.sql",
  import.meta.url,
);
const globalTechMigrationUrl = new URL(
  "../migrations/0009_seed_global_tech_targets.sql",
  import.meta.url,
);
const evidenceMigrationUrl = new URL(
  "../migrations/0010_news_evidence_metadata.sql",
  import.meta.url,
);
const hashKeyMigrationUrl = new URL(
  "../migrations/0012_fix_hashkey_identity.sql",
  import.meta.url,
);
const chatEvidenceScopeMigrationUrl = new URL(
  "../migrations/0014_chat_evidence_scope.sql",
  import.meta.url,
);
const notificationMigrationUrl = new URL(
  "../migrations/0015_notification_deliveries.sql",
  import.meta.url,
);
const fundFlowMigrationUrl = new URL(
  "../migrations/0016_fund_flows.sql",
  import.meta.url,
);
const deploymentMetadataMigrationUrl = new URL(
  "../migrations/0017_deployment_metadata.sql",
  import.meta.url,
);
const fundFlowTradeDateMigrationUrl = new URL(
  "../migrations/0018_fund_flow_trade_date.sql",
  import.meta.url,
);
const cnIntradayCleanupMigrationUrl = new URL(
  "../migrations/0019_remove_invalid_cn_intraday_bars.sql",
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

test("notification migration keeps structured event provenance and a constrained idempotent ledger", async () => {
  const sql = readFileSync(notificationMigrationUrl, "utf8");
  for (const column of [
    "provider",
    "provider_as_of",
    "provider_quality",
    "rule_version",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN\\s+${column}\\b`, "i"));
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS notification_deliveries/i);
  assert.match(sql, /UNIQUE\s*\(\s*event_id\s*,\s*channel\s*\)/i);
  for (const status of [
    "pending",
    "deferred",
    "sending",
    "sent",
    "failed",
    "uncertain",
    "skipped",
  ]) {
    assert.match(sql, new RegExp(`'${status}'`, "i"));
  }
  for (const column of [
    "policy_snapshot_json",
    "reason_code",
    "attempt_count",
    "next_attempt_at",
    "sent_at",
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "i"));
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(migrationUrl, "utf8"));
  db.exec(sql);
  db.prepare(`
    INSERT INTO market_events (
      id, importance, event_at, title, source, as_of, fetched_at,
      freshness, quality, expires_at
    ) VALUES (
      'event-1', 'high', '2026-07-24T01:00:00.000Z', 'event',
      'signal-engine', '2026-07-24T01:00:00.000Z',
      '2026-07-24T01:00:01.000Z', 'fresh', 'good',
      '2099-01-01T00:00:00.000Z'
    )
  `).run();
  const insert = db.prepare(`
    INSERT INTO notification_deliveries (
      id, event_id, profile_id, channel, status, policy_snapshot_json,
      attempt_count, created_at, updated_at
    ) VALUES (?, 'event-1', 'etf-main', 'web', 'sent', '{}', 0, ?, ?)
  `);
  insert.run(
    "delivery-1",
    "2026-07-24T01:00:01.000Z",
    "2026-07-24T01:00:01.000Z",
  );
  assert.throws(
    () => insert.run(
      "delivery-2",
      "2026-07-24T01:00:02.000Z",
      "2026-07-24T01:00:02.000Z",
    ),
    /UNIQUE constraint failed/i,
  );
  assert.throws(() => db.prepare(`
    UPDATE notification_deliveries SET status = 'mystery' WHERE id = 'delivery-1'
  `).run(), /CHECK constraint failed/i);
});

test("news evidence migration stores source tier, publisher, relevance, and duplicate cluster", () => {
  const sql = readFileSync(evidenceMigrationUrl, "utf8");
  for (const column of ["source_tier", "publisher", "relevance", "cluster_id"]) {
    assert.match(sql, new RegExp(`ADD COLUMN\\s+${column}\\b`, "i"));
  }
  assert.match(sql, /idx_news_items_source_tier_published_at/i);
});

test("settings seed is valid v2 JSON and never overwrites a web-edited row", async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(migrationUrl, "utf8"));
  const seedSql = readFileSync(seedMigrationUrl, "utf8");
  db.exec(seedSql);
  const seeded = db.prepare(
    "SELECT version, settings_json, updated_at FROM workbench_settings WHERE id = 1",
  ).get();
  const settings = JSON.parse(seeded.settings_json);
  assert.equal(seeded.version, 2);
  assert.equal(settings.profiles[0].id, "cn-semi-comms");
  assert.equal(settings.profiles[0].targets.length, 10);

  db.prepare(
    "UPDATE workbench_settings SET settings_json = ?, updated_at = ? WHERE id = 1",
  ).run('{"version":2,"profiles":[]}', "2099-01-01T00:00:00.000Z");
  db.exec(seedSql);
  const preserved = db.prepare(
    "SELECT settings_json, updated_at FROM workbench_settings WHERE id = 1",
  ).get();
  assert.equal(preserved.settings_json, '{"version":2,"profiles":[]}');
  assert.equal(preserved.updated_at, "2099-01-01T00:00:00.000Z");
});

test("Oracle monitor migration appends once without replacing existing targets", async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(migrationUrl, "utf8"));
  db.exec(readFileSync(seedMigrationUrl, "utf8"));
  const sql = readFileSync(oracleMigrationUrl, "utf8");
  db.exec(sql);
  db.exec(sql);
  const settings = JSON.parse(
    db.prepare("SELECT settings_json FROM workbench_settings WHERE id = 1").get().settings_json,
  );
  assert.equal(settings.profiles[0].targets.length, 11);
  assert.equal(
    settings.profiles[0].targets.filter(({ symbol }) => symbol === "ORCL").length,
    1,
  );
  assert.deepEqual(settings.profiles[0].targets.at(-1), {
    symbol: "ORCL",
    name: "Oracle",
    market: "US",
    role: "driver",
    analysis: "signal",
  });
});

test("HashKey identity migration corrects only the 3887.HK display name", async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(migrationUrl, "utf8"));
  db.exec(readFileSync(seedMigrationUrl, "utf8"));
  db.exec(readFileSync(oracleMigrationUrl, "utf8"));
  db.exec(readFileSync(globalTechMigrationUrl, "utf8"));
  const before = JSON.parse(
    db.prepare("SELECT settings_json FROM workbench_settings WHERE id = 1").get().settings_json,
  );
  const target = before.profiles[0].targets.find(({ symbol }) => symbol === "3887.HK");
  target.name = "错误旧名称";
  db.prepare("UPDATE workbench_settings SET settings_json = ? WHERE id = 1")
    .run(JSON.stringify(before));

  const sql = readFileSync(hashKeyMigrationUrl, "utf8");
  db.exec(sql);
  db.exec(sql);

  const after = JSON.parse(
    db.prepare("SELECT settings_json FROM workbench_settings WHERE id = 1").get().settings_json,
  );
  assert.deepEqual(
    after.profiles[0].targets.find(({ symbol }) => symbol === "3887.HK"),
    {
      symbol: "3887.HK",
      name: "HashKey Holdings",
      market: "HK",
      role: "driver",
      analysis: "signal",
    },
  );
  assert.equal(after.profiles[0].targets.find(({ symbol }) => symbol === "ORCL").name, "Oracle");
});

test("chat and evidence scope migration backfills legacy ownership and adds exact lookup indexes", async (t) => {
  const sql = readFileSync(chatEvidenceScopeMigrationUrl, "utf8");
  for (const table of ["evidence_packets", "report_manifests"]) {
    for (const column of ["scope", "profile_id", "request_id", "slot_id", "run_id"]) {
      assert.match(
        sql,
        new RegExp(`ALTER TABLE\\s+${table}\\s+ADD COLUMN\\s+${column}\\b`, "i"),
      );
    }
  }
  assert.match(sql, /scope\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'legacy'/i);
  assert.match(sql, /idx_evidence_packets_scope_profile_symbol_as_of/i);
  assert.match(sql, /idx_evidence_packets_scope_request_symbol_as_of/i);
  assert.match(sql, /idx_report_manifests_scope_profile_report/i);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0011_evidence_packets.sql", import.meta.url), "utf8"));
  db.prepare(`
    INSERT INTO evidence_packets (
      id, symbol, as_of, generated_at, status, packet_json, content_hash, expires_at
    ) VALUES ('old-packet', 'SPY', '2026-07-24T00:00:00Z',
      '2026-07-24T00:01:00Z', 'ok', '{}', ?, '2099-01-01T00:00:00Z')
  `).run("a".repeat(64));
  db.prepare(`
    INSERT INTO report_manifests (
      report, symbol, trade_date, analysis_status, audit_status,
      evidence_hash, manifest_json, created_at
    ) VALUES ('reports/SPY/2026-07-24/complete_report.md', 'SPY', '2026-07-24',
      'rated', 'verified', ?, '{}', '2026-07-24T00:01:00Z')
  `).run("a".repeat(64));

  db.exec(sql);
  assert.deepEqual(
    { ...db.prepare(`
      SELECT scope, profile_id, request_id, slot_id, run_id
      FROM evidence_packets WHERE id = 'old-packet'
    `).get() },
    {
      scope: "legacy",
      profile_id: null,
      request_id: null,
      slot_id: null,
      run_id: null,
    },
  );
  assert.equal(
    db.prepare(`
      SELECT scope FROM report_manifests
      WHERE report = 'reports/SPY/2026-07-24/complete_report.md'
    `).get().scope,
    "legacy",
  );
});

test("fund-flow migration is additive, idempotent, indexed, and profile-scoped", async (t) => {
  const sql = readFileSync(fundFlowMigrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fund_flows\b/i);
  assert.doesNotMatch(sql, /\b(?:ALTER|UPDATE|DELETE|DROP)\b/i);
  assert.match(sql, /id\s+TEXT\s+PRIMARY\s+KEY/i);
  assert.match(sql, /period\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'1d'/i);
  assert.match(sql, /method\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'reported'/i);
  assert.match(sql, /currency\s+TEXT(?!\s+NOT\s+NULL)/i);
  assert.match(sql, /adjustment\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'none'/i);
  assert.match(
    sql,
    /UNIQUE\s*\(\s*profile_id\s*,\s*symbol\s*,\s*flow_type\s*,\s*period\s*,\s*ts\s*,\s*source\s*,\s*adjustment\s*\)/i,
  );
  assert.match(sql, /CREATE INDEX[^;]+fund_flows[^;]+symbol[^;]+flow_type[^;]+period[^;]+ts/i);
  assert.match(sql, /CREATE INDEX[^;]+fund_flows[^;]+profile_id[^;]+ts/i);
  assert.match(sql, /CREATE INDEX[^;]+fund_flows[^;]+expires_at/i);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE legacy_rows (id TEXT PRIMARY KEY, value TEXT NOT NULL);");
  db.prepare("INSERT INTO legacy_rows (id, value) VALUES ('old', 'preserved')").run();
  db.exec(sql);
  db.exec(sql);
  assert.deepEqual({ ...db.prepare("SELECT * FROM legacy_rows").get() }, {
    id: "old",
    value: "preserved",
  });

  const insert = db.prepare(`
    INSERT INTO fund_flows (
      id, profile_id, symbol, flow_type, ts, value, unit, source,
      as_of, fetched_at, freshness, quality, expires_at
    ) VALUES (?, ?, '515880.SS', 'margin_balance',
      '2026-07-27T00:00:00.000Z', 123, 'CNY', 'exchange',
      '2026-07-27T00:00:00.000Z', '2026-07-27T01:00:00.000Z',
      'fresh', 'good', '2099-01-01T00:00:00.000Z')
  `);
  insert.run("flow-a", "profile-a");
  insert.run("flow-b", "profile-b");
  assert.equal(db.prepare("SELECT count(*) AS count FROM fund_flows").get().count, 2);
  assert.throws(() => insert.run("flow-c", "profile-a"), /UNIQUE constraint failed/i);
});

test("deployment metadata migration is additive and keeps one current Pages identity", async (t) => {
  const sql = readFileSync(deploymentMetadataMigrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS deployment_metadata/i);
  assert.doesNotMatch(sql, /\b(?:ALTER|UPDATE|DELETE|DROP)\b/i);
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  db.exec(sql);
  db.prepare(`
    INSERT INTO deployment_metadata
      (service, commit_sha, deployed_at, branch, url, updated_at)
    VALUES ('pages-functions', ?, ?, 'main', NULL, ?)
  `).run("a".repeat(40), "2026-07-27T19:00:00Z", "2026-07-27T19:00:00Z");
  assert.equal(db.prepare("SELECT count(*) AS count FROM deployment_metadata").get().count, 1);
  assert.throws(() => db.prepare(`
    INSERT INTO deployment_metadata
      (service, commit_sha, deployed_at, branch, url, updated_at)
    VALUES ('unknown', ?, ?, 'main', NULL, ?)
  `).run("b".repeat(40), "2026-07-27T19:01:00Z", "2026-07-27T19:01:00Z"), /CHECK constraint failed/i);
});

test("fund-flow trade-date migration makes the Shanghai business date explicit", async (t) => {
  const baseSql = readFileSync(fundFlowMigrationUrl, "utf8");
  const sql = readFileSync(fundFlowTradeDateMigrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE fund_flows ADD COLUMN trade_date TEXT/i);
  assert.match(sql, /date\s*\(\s*datetime\s*\(\s*ts\s*,\s*'\+8 hours'\s*\)\s*\)/i);
  assert.match(sql, /CREATE INDEX[^;]+fund_flows[^;]+trade_date/i);
  assert.doesNotMatch(sql, /\b(?:DELETE|DROP)\b/i);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const db = new DatabaseSync(":memory:");
  db.exec(baseSql);
  db.prepare(`
    INSERT INTO fund_flows (
      id, profile_id, symbol, flow_type, ts, value, unit, source,
      as_of, fetched_at, freshness, quality, expires_at
    ) VALUES (
      'flow-friday', 'profile-a', '515880.SS', 'margin_net_buy',
      '2026-07-23T16:00:00.000Z', 1, 'CNY', 'exchange',
      '2026-07-23T16:00:00.000Z', '2026-07-24T01:00:00.000Z',
      'fresh', 'reported', '2099-01-01T00:00:00.000Z'
    )
  `).run();
  db.exec(sql);
  assert.equal(
    db.prepare("SELECT trade_date FROM fund_flows WHERE id = 'flow-friday'").get().trade_date,
    "2026-07-24",
  );
});

test("CN intraday cleanup removes only Yahoo lunch and flat close sentinels", async (t) => {
  const sql = readFileSync(cnIntradayCleanupMigrationUrl, "utf8");
  assert.match(sql, /DELETE\s+FROM\s+market_bars/i);
  assert.match(sql, /timeframe\s*=\s*'5m'/i);
  assert.match(sql, /source\s*=\s*'yahoo'/i);
  assert.match(sql, /symbol\s+LIKE\s+'%\.SS'/i);
  assert.match(sql, /symbol\s+LIKE\s+'%\.SZ'/i);
  assert.match(sql, /datetime\s*\(\s*ts\s*,\s*'\+8 hours'\s*\)/i);
  assert.doesNotMatch(sql, /\b(?:DROP|ALTER)\b/i);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }

  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(migrationUrl, "utf8"));
  const insert = db.prepare(`
    INSERT INTO market_bars (
      profile_id, symbol, timeframe, ts, open, high, low, close, volume,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at
    ) VALUES ('cn-semi-comms', ?, '5m', ?, ?, ?, ?, ?, ?, ?,
      '2026-07-24T07:00:00.000Z', '2026-07-24T07:01:00.000Z',
      'fresh', 'none', ?, '2099-01-01T00:00:00.000Z')
  `);
  const rows = [
    ["159995.SZ", "2026-07-24T01:30:00.000Z", 1, 1.1, 1, 1.1, 100, "yahoo", "keep-yahoo-morning"],
    ["159995.SZ", "2026-07-24T03:35:00.000Z", 1.1, 1.1, 1.1, 1.1, 0, "yahoo", "delete-yahoo-lunch"],
    ["512480.SS", "2026-07-24T07:00:00.000Z", 1.2, 1.2, 1.2, 1.2, 0, "yahoo", "delete-yahoo-close-sentinel"],
    ["515880.SS", "2026-07-24T07:00:00.000Z", 1.2, 1.3, 1.2, 1.3, 300, "yahoo", "keep-yahoo-real-close"],
    ["159995.SZ", "2026-07-24T03:35:00.000Z", 1.1, 1.1, 1.1, 1.1, 0, "tencent", "keep-tencent-lunch-shaped"],
    ["SOXX", "2026-07-24T03:35:00.000Z", 200, 200, 200, 200, 0, "yahoo", "keep-us-yahoo"],
    ["159995.SZ", "2026-07-24T16:00:00.000Z", 1, 1.1, 1, 1.1, 100, "yahoo", "keep-daily-yahoo"],
  ];
  for (const row of rows) {
    insert.run(...row);
  }
  db.prepare("UPDATE market_bars SET timeframe = '1d' WHERE quality = 'keep-daily-yahoo'").run();

  db.exec(sql);
  const remaining = db.prepare("SELECT quality FROM market_bars ORDER BY quality").all().map((row) => row.quality);
  assert.deepEqual(remaining, [
    "keep-daily-yahoo",
    "keep-tencent-lunch-shaped",
    "keep-us-yahoo",
    "keep-yahoo-morning",
    "keep-yahoo-real-close",
  ]);
});
