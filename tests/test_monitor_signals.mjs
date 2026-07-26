import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateIntradaySignals } from "../workers/monitor/src/signals.mjs";
import { SqliteD1 } from "./helpers/sqlite_d1.mjs";
import { monitorSettings } from "./helpers/monitor_settings.mjs";

async function fixture(t) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return null;
  }
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(
    new URL("../migrations/0001_workbench_dynamic.sql", import.meta.url),
    "utf8",
  ));
  sqlite.exec(readFileSync(
    new URL("../migrations/0015_notification_deliveries.sql", import.meta.url),
    "utf8",
  ));
  return { sqlite, db: new SqliteD1(sqlite) };
}

function insertBars(sqlite, {
  symbol = "515880.SS",
  closes = [1, 1, 1, 1.025],
  volumes = [100, 100, 100, 100],
  timestamps = null,
}) {
  const insert = sqlite.prepare(`
    INSERT INTO market_bars (
      symbol, profile_id, timeframe, ts, open, high, low, close, volume,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at
    ) VALUES (?, 'etf-main', '5m', ?, ?, ?, ?, ?, ?, 'tencent', ?, ?,
      'fresh', 'none', 'good', '2099-01-01T00:00:00.000Z')
  `);
  const start = Date.parse("2026-07-24T01:30:00.000Z");
  closes.forEach((close, index) => {
    const ts = timestamps?.[index]
      || new Date(start + index * 5 * 60_000).toISOString();
    insert.run(
      symbol,
      ts,
      close,
      close,
      close,
      close,
      volumes[index],
      ts,
      new Date(Date.parse(ts) + 1000).toISOString(),
    );
  });
}

test("15-minute price move creates one deterministic high event", async (t) => {
  const value = await fixture(t);
  if (!value) return;
  insertBars(value.sqlite, {});
  const profile = monitorSettings().profiles[0];
  const options = {
    db: value.db,
    profile,
    scheduledFor: "2026-07-24T01:45:00.000Z",
    now: new Date("2026-07-24T01:45:10.000Z"),
  };
  const first = await evaluateIntradaySignals(options);
  const second = await evaluateIntradaySignals(options);
  const rows = value.sqlite.prepare(`
    SELECT symbol, importance, title, description, source, provider,
           provider_as_of, provider_quality, rule_version
    FROM market_events
  `).all();
  const deliveries = value.sqlite.prepare(`
    SELECT channel, status, reason_code, policy_snapshot_json
    FROM notification_deliveries
    ORDER BY channel
  `).all();

  assert.equal(first.status, "degraded");
  assert.equal(first.counts.high, 1);
  assert.equal(second.counts.inserted, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "515880.SS");
  assert.equal(rows[0].importance, "high");
  assert.match(rows[0].title, /15分钟价格异动/);
  assert.match(rows[0].description, /2\.50%/);
  assert.equal(rows[0].source, "signal-engine");
  assert.equal(rows[0].provider, "tencent");
  assert.equal(rows[0].provider_as_of, "2026-07-24T01:45:00.000Z");
  assert.equal(rows[0].provider_quality, "good");
  assert.equal(rows[0].rule_version, "intraday-signal-v1");
  assert.deepEqual(
    deliveries.map(({ channel, status, reason_code: reasonCode }) => ({
      channel,
      status,
      reasonCode,
    })),
    [
      {
        channel: "pushPlus",
        status: "skipped",
        reasonCode: "CHANNEL_DISABLED",
      },
      {
        channel: "web",
        status: "sent",
        reasonCode: "WEB_EVENT_PERSISTED",
      },
    ],
  );
  assert.equal(
    deliveries.every(({ policy_snapshot_json: snapshot }) =>
      !/token/i.test(snapshot)),
    true,
  );
});

test("volume z-score creates medium event while normal bars create none", async (t) => {
  const value = await fixture(t);
  if (!value) return;
  insertBars(value.sqlite, {
    closes: Array.from({ length: 24 }, () => 1),
    volumes: [...Array.from({ length: 23 }, (_, index) => 90 + (index % 3) * 10), 120],
  });
  insertBars(value.sqlite, {
    symbol: "159995.SZ",
    closes: Array.from({ length: 24 }, (_, index) => index === 23 ? 1.001 : 1),
    volumes: Array.from({ length: 24 }, () => 100),
  });
  const result = await evaluateIntradaySignals({
    db: value.db,
    profile: monitorSettings().profiles[0],
    scheduledFor: "2026-07-24T03:25:00.000Z",
    now: new Date("2026-07-24T03:25:10.000Z"),
  });
  const rows = value.sqlite.prepare(
    "SELECT symbol, importance, description FROM market_events ORDER BY symbol",
  ).all();

  assert.equal(result.counts.evaluated, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "515880.SS");
  assert.equal(rows[0].importance, "medium");
  assert.match(rows[0].description, /成交量 z-score/);
});

test("insufficient or stale bars do not create a signal", async (t) => {
  const value = await fixture(t);
  if (!value) return;
  insertBars(value.sqlite, { closes: [1, 1], volumes: [100, 100] });
  const result = await evaluateIntradaySignals({
    db: value.db,
    profile: monitorSettings().profiles[0],
    scheduledFor: "2026-07-24T05:00:00.000Z",
    now: new Date("2026-07-24T05:30:00.000Z"),
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.errorCode, "SIGNAL_INPUT_UNAVAILABLE");
  assert.equal(
    value.sqlite.prepare("SELECT count(*) AS count FROM market_events").get().count,
    0,
  );
});

test("same-timestamp providers are deterministically ranked before signal calculation", async (t) => {
  const value = await fixture(t);
  if (!value) return;
  insertBars(value.sqlite, {});
  value.sqlite.prepare(`
    INSERT INTO market_bars (
      symbol, profile_id, timeframe, ts, open, high, low, close, volume,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at
    ) VALUES (
      '515880.SS', 'etf-main', '5m', '2026-07-24T01:45:00.000Z',
      0.5, 0.5, 0.5, 0.5, 999999, 'stale-wire',
      '2026-07-24T01:45:00.000Z', '2026-07-24T01:45:09.000Z',
      'stale', 'none', 'poor', '2099-01-01T00:00:00.000Z'
    )
  `).run();
  const result = await evaluateIntradaySignals({
    db: value.db,
    profile: monitorSettings().profiles[0],
    scheduledFor: "2026-07-24T01:45:00.000Z",
    now: new Date("2026-07-24T01:45:10.000Z"),
  });
  const event = value.sqlite.prepare(`
    SELECT provider, provider_quality, description
    FROM market_events
  `).get();
  assert.equal(result.counts.high, 1);
  assert.equal(event.provider, "tencent");
  assert.equal(event.provider_quality, "good");
  assert.match(event.description, /收盘 1\.025/);
  assert.doesNotMatch(event.description, /999999/);
});

test("fresh timestamps with stale or poor provenance do not propagate into events", async (t) => {
  const value = await fixture(t);
  if (!value) return;
  insertBars(value.sqlite, {});
  value.sqlite.prepare(`
    UPDATE market_bars
    SET freshness = 'stale', quality = 'poor'
  `).run();
  const result = await evaluateIntradaySignals({
    db: value.db,
    profile: monitorSettings().profiles[0],
    scheduledFor: "2026-07-24T01:45:00.000Z",
    now: new Date("2026-07-24T01:45:10.000Z"),
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.errorCode, "SIGNAL_INPUT_UNAVAILABLE");
  assert.equal(
    value.sqlite.prepare("SELECT count(*) AS count FROM market_events").get().count,
    0,
  );
});

test("a cross-session gap is insufficient and creates neither event nor delivery ledger", async (t) => {
  const value = await fixture(t);
  if (!value) return;
  insertBars(value.sqlite, {
    closes: [1, 1, 1, 1.025],
    volumes: [100, 100, 100, 100],
    timestamps: [
      "2026-07-23T06:45:00.000Z",
      "2026-07-23T06:50:00.000Z",
      "2026-07-23T06:55:00.000Z",
      "2026-07-24T01:45:00.000Z",
    ],
  });

  const result = await evaluateIntradaySignals({
    db: value.db,
    profile: monitorSettings().profiles[0],
    scheduledFor: "2026-07-24T01:45:00.000Z",
    now: new Date("2026-07-24T01:45:10.000Z"),
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.errorCode, "SIGNAL_INPUT_UNAVAILABLE");
  assert.equal(result.counts.evaluated, 0);
  assert.equal(
    value.sqlite.prepare("SELECT count(*) AS count FROM market_events").get().count,
    0,
  );
  assert.equal(
    value.sqlite.prepare("SELECT count(*) AS count FROM notification_deliveries").get().count,
    0,
  );
});
