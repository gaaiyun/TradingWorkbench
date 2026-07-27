import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as eventsApi from "../functions/api/events.js";
import * as marketApi from "../functions/api/market.js";
import * as monitorApi from "../functions/api/monitor-status.js";
import * as newsApi from "../functions/api/news.js";
import { FakeD1 } from "./helpers/fake_d1.mjs";
import { SqliteD1 } from "./helpers/sqlite_d1.mjs";

const SOURCE_KEYS = ["source", "asOf", "fetchedAt", "freshness", "adjustment", "quality"];
const VALID_STATUSES = new Set(["ok", "degraded", "stale", "unavailable"]);

function request(path) {
  return new Request(`https://workbench.test${path}`);
}

function assertEnvelope(payload) {
  assert.deepEqual(Object.keys(payload).slice(0, 4), ["status", "asOf", "data", "sources"]);
  assert.equal(VALID_STATUSES.has(payload.status), true);
  assert.equal(Array.isArray(payload.data), true);
  assert.equal(Array.isArray(payload.sources), true);
  for (const source of payload.sources) assert.deepEqual(Object.keys(source), SOURCE_KEYS);
}

async function sqliteEventsFixture(t, { maxBindings = Infinity } = {}) {
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
  const insertEvent = sqlite.prepare(`
    INSERT INTO market_events (
      id, symbol, profile_id, topic, importance, event_at, title, description,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at,
      provider, provider_as_of, provider_quality, rule_version
    ) VALUES (
      ?, '515880.SS', 'semi', 'market_move', 'high', ?, ?, 'move',
      'signal-engine', ?, ?, 'fresh', 'none', 'good',
      '2099-01-01T00:00:00.000Z', 'tencent', ?, 'good', 'intraday-signal-v1'
    )
  `);
  const insertDelivery = sqlite.prepare(`
    INSERT INTO notification_deliveries (
      id, event_id, profile_id, channel, status, policy_snapshot_json,
      reason_code, attempt_count, created_at, updated_at
    ) VALUES (?, ?, 'semi', 'web', 'sent', '{}',
      'WEB_EVENT_PERSISTED', 0, ?, ?)
  `);
  const oldTimestamp = "2026-07-24T08:00:00.000Z";
  insertEvent.run(
    "event-old",
    oldTimestamp,
    "old",
    oldTimestamp,
    oldTimestamp,
    oldTimestamp,
  );
  const timestamp = "2026-07-24T09:00:00.000Z";
  for (let index = 1; index <= 125; index += 1) {
    const id = `event-${String(index).padStart(3, "0")}`;
    insertEvent.run(id, timestamp, id, timestamp, timestamp, timestamp);
    insertDelivery.run(`delivery-${id}`, id, timestamp, timestamp);
  }
  const inner = new SqliteD1(sqlite);
  const db = {
    prepare(sql) {
      const statement = inner.prepare(sql);
      return {
        bind(...params) {
          if (params.length > maxBindings) {
            throw new Error(`too many bound parameters: ${params.length}`);
          }
          return statement.bind(...params);
        },
      };
    },
  };
  return { sqlite, db, oldTimestamp };
}

test("market API builds parameterized symbol/profile/timeframe/date filters and source metadata", async () => {
  const row = {
    symbol: "SPY",
    profile_id: "us-core",
    timeframe: "5m",
    ts: "2026-07-23T10:00:00Z",
    open: 620,
    high: 622,
    low: 619,
    close: 621,
    volume: 1000,
    source: "market-provider",
    as_of: "2026-07-23T10:01:00Z",
    fetched_at: "2026-07-23T10:01:05Z",
    freshness: "fresh",
    adjustment: "split",
    quality: "good",
  };
  const DB = new FakeD1({ rows: { market_bars: [row] } });
  const response = await marketApi.onRequestGet({
    request: request("/api/market?symbol=spy&profile=us-core&timeframe=5m&from=2026-07-23T09:00:00Z&to=2026-07-23T11:00:00Z&limit=25"),
    env: { DB },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assertEnvelope(payload);
  assert.equal(payload.status, "ok");
  assert.deepEqual(payload.data, [row]);
  assert.equal(payload.indicators.version, "ta-indicators-v1");
  assert.equal(payload.indicators.bars, 1);
  assert.equal(payload.indicators.asOf, row.ts);
  assert.equal(payload.indicators.adjustment, "split");
  assert.deepEqual(payload.sources[0], {
    source: "market-provider",
    asOf: "2026-07-23T10:01:00Z",
    fetchedAt: "2026-07-23T10:01:05Z",
    freshness: "fresh",
    adjustment: "split",
    quality: "good",
  });
  const [{ sql, params }] = DB.calls;
  assert.match(sql, /symbol\s*=\s*\?/i);
  assert.match(sql, /profile_id\s*=\s*\?/i);
  assert.match(sql, /timeframe\s*=\s*\?/i);
  assert.match(sql, /ts\s*>=\s*\?/i);
  assert.match(sql, /ts\s*<=\s*\?/i);
  assert.match(sql, /LIMIT\s+\?/i);
  assert.deepEqual(params.slice(0, 5), ["SPY", "us-core", "5m", "2026-07-23T09:00:00.000Z", "2026-07-23T11:00:00.000Z"]);
  assert.equal(typeof params[5], "string");
  assert.equal(params[6], 150);
});

test("market API aggregates stored 5m bars for a requested 15m timeframe", async () => {
  const base = {
    symbol: "515880.SS",
    profile_id: "cn-etf-semiconductor",
    timeframe: "5m",
    source: "tencent-cn",
    as_of: "2026-07-23T02:00:00Z",
    fetched_at: "2026-07-23T02:00:05Z",
    freshness: "stale",
    adjustment: "none",
    quality: "good",
  };
  const points = [
    ["2026-07-23T01:30:00Z", 1.50, 1.52, 1.49, 1.51, 100],
    ["2026-07-23T01:35:00Z", 1.51, 1.53, 1.50, 1.52, 200],
    ["2026-07-23T01:40:00Z", 1.52, 1.54, 1.51, 1.53, 300],
    ["2026-07-23T01:45:00Z", 1.53, 1.55, 1.52, 1.54, 400],
    ["2026-07-23T01:50:00Z", 1.54, 1.56, 1.53, 1.55, 500],
    ["2026-07-23T01:55:00Z", 1.55, 1.57, 1.54, 1.56, 600],
  ];
  const rows = points.map(([ts, open, high, low, close, volume]) => ({
    ...base,
    ts,
    open,
    high,
    low,
    close,
    volume,
  }));
  const DB = new FakeD1({ rows: { market_bars: rows } });

  const response = await marketApi.onRequestGet({
    request: request("/api/market?symbol=515880.SS&profile=cn-etf-semiconductor&timeframe=15m&limit=2"),
    env: { DB },
  });
  const payload = await response.json();

  assert.equal(payload.status, "stale");
  assert.equal(payload.data.length, 2);
  assert.deepEqual(payload.data[0], {
    ...base,
    timeframe: "15m",
    ts: "2026-07-23T01:45:00.000Z",
    open: 1.53,
    high: 1.57,
    low: 1.52,
    close: 1.56,
    volume: 1500,
  });
  assert.deepEqual(payload.data[1], {
    ...base,
    timeframe: "15m",
    ts: "2026-07-23T01:30:00.000Z",
    open: 1.50,
    high: 1.54,
    low: 1.49,
    close: 1.53,
    volume: 600,
  });
  assert.equal(payload.indicators.bars, 2);
  assert.equal(DB.calls[0].params[2], "5m");
});

test("market API returns distinct timestamps when provider fallbacks overlap", async () => {
  const base = {
    symbol: "ORCL",
    profile_id: "cn-semi-comms",
    timeframe: "1d",
    open: 120,
    high: 122,
    low: 119,
    close: 121,
    volume: 1000,
    as_of: "2026-07-23T04:00:00Z",
    freshness: "stale",
    adjustment: "qfq",
    quality: "good",
  };
  const DB = new FakeD1({ rows: { market_bars: [
    {
      ...base,
      ts: "2026-07-23T04:00:00Z",
      source: "tencent-us",
      fetched_at: "2026-07-23T18:40:00Z",
    },
    {
      ...base,
      ts: "2026-07-23T04:00:00Z",
      source: "eastmoney-us",
      fetched_at: "2026-07-24T01:00:00Z",
      freshness: "fresh",
    },
    {
      ...base,
      ts: "2026-07-22T04:00:00Z",
      as_of: "2026-07-22T04:00:00Z",
      source: "eastmoney-us",
      fetched_at: "2026-07-24T01:00:00Z",
    },
  ] } });

  const response = await marketApi.onRequestGet({
    request: request("/api/market?symbol=ORCL&profile=cn-semi-comms&timeframe=1d&limit=2"),
    env: { DB },
  });
  const payload = await response.json();

  assert.deepEqual(payload.data.map(({ ts }) => ts), [
    "2026-07-23T04:00:00Z",
    "2026-07-22T04:00:00Z",
  ]);
  assert.equal(payload.data[0].source, "eastmoney-us");
  assert.equal(payload.status, "ok");
  assert.equal(payload.sources.length, 1);
  assert.equal(payload.sources[0].freshness, "fresh");
});

test("daily market API keeps one provider bar per trading date", async () => {
  const base = {
    symbol: "SOXX",
    profile_id: "cn-semi-comms",
    timeframe: "1d",
    open: 545.5,
    high: 558.09,
    low: 543.79,
    close: 551.24,
    volume: 1000,
    freshness: "fresh",
    adjustment: "none",
    quality: "good",
  };
  const DB = new FakeD1({ rows: { market_bars: [
    {
      ...base,
      ts: "2026-07-23T13:30:00Z",
      as_of: "2026-07-23T13:30:00Z",
      source: "yahoo",
      fetched_at: "2026-07-24T01:00:00Z",
    },
    {
      ...base,
      ts: "2026-07-23T04:00:00Z",
      as_of: "2026-07-23T04:00:00Z",
      source: "tencent-us",
      fetched_at: "2026-07-23T18:40:00Z",
      adjustment: "qfq",
    },
    {
      ...base,
      ts: "2026-07-22T13:30:00Z",
      as_of: "2026-07-22T13:30:00Z",
      source: "yahoo",
      fetched_at: "2026-07-24T01:00:00Z",
      close: 555.52,
    },
  ] } });

  const response = await marketApi.onRequestGet({
    request: request("/api/market?symbol=SOXX&profile=cn-semi-comms&timeframe=1d&limit=2"),
    env: { DB },
  });
  const payload = await response.json();

  assert.deepEqual(payload.data.map(({ ts }) => ts), [
    "2026-07-23T13:30:00Z",
    "2026-07-22T13:30:00Z",
  ]);
  assert.equal(payload.data[0].source, "yahoo");
  assert.equal(payload.indicators.bars, 2);
});

test("daily market API removes a disconnected legacy seed before calculating change", async () => {
  const base = {
    symbol: "NVDA",
    profile_id: "cn-semi-comms",
    timeframe: "1d",
    open: 208,
    high: 210,
    low: 205,
    close: 208.76,
    volume: 1000,
    source: "tencent-us",
    as_of: "2026-07-23T04:00:00Z",
    fetched_at: "2026-07-24T01:00:00Z",
    freshness: "fresh",
    adjustment: "qfq",
    quality: "good",
  };
  const DB = new FakeD1({ rows: { market_bars: [
    { ...base, ts: "2026-07-23T04:00:00Z" },
    {
      ...base,
      ts: "2011-06-02T04:00:00Z",
      close: 19.02,
      as_of: "2011-06-02T04:00:00Z",
    },
  ] } });

  const response = await marketApi.onRequestGet({
    request: request("/api/market?symbol=NVDA&profile=cn-semi-comms&timeframe=1d&limit=8"),
    env: { DB },
  });
  const payload = await response.json();

  assert.deepEqual(payload.data.map(({ ts }) => ts), ["2026-07-23T04:00:00Z"]);
  assert.equal(payload.indicators.bars, 1);
});

test("daily market API keeps legitimate long holiday closures in one history", async () => {
  const base = {
    symbol: "512480.SS",
    profile_id: "cn-semi-comms",
    timeframe: "1d",
    open: 1.2,
    high: 1.3,
    low: 1.1,
    close: 1.25,
    volume: 1000,
    source: "tencent",
    fetched_at: "2026-07-24T01:00:00Z",
    freshness: "stale",
    adjustment: "qfq",
    quality: "good",
  };
  const DB = new FakeD1({ rows: { market_bars: [
    { ...base, ts: "2026-02-23T16:00:00Z", as_of: "2026-02-23T16:00:00Z" },
    { ...base, ts: "2026-02-13T16:00:00Z", as_of: "2026-02-13T16:00:00Z" },
    { ...base, ts: "2026-02-12T16:00:00Z", as_of: "2026-02-12T16:00:00Z" },
  ] } });

  const response = await marketApi.onRequestGet({
    request: request("/api/market?symbol=512480.SS&profile=cn-semi-comms&timeframe=1d&limit=20"),
    env: { DB },
  });
  const payload = await response.json();
  assert.deepEqual(payload.data.map(({ ts }) => ts), [
    "2026-02-23T16:00:00Z",
    "2026-02-13T16:00:00Z",
    "2026-02-12T16:00:00Z",
  ]);
});

test("news and events APIs support topic and importance filters without interpolating input", async () => {
  const injectedTopic = "chips' OR 1=1 --";
  const newsRow = {
    id: "news-1",
    symbol: "NVDA",
    profile_id: "semi",
    topic: injectedTopic,
    title: "Chip update",
    published_at: "2026-07-23T09:00:00Z",
    source: "wire",
    as_of: "2026-07-23T09:01:00Z",
    fetched_at: "2026-07-23T09:01:05Z",
    freshness: "stale",
    adjustment: null,
    quality: "good",
  };
  const eventRow = {
    id: "event-1",
    profile_id: "semi",
    importance: "high",
    topic: "earnings",
    event_at: "2026-07-24T09:00:00Z",
    title: "Earnings",
    source: "calendar",
    as_of: "2026-07-23T09:00:00Z",
    fetched_at: "2026-07-23T09:00:05Z",
    freshness: "fresh",
    adjustment: null,
    quality: "good",
  };
  const DB = new FakeD1({ rows: { news_items: [newsRow], market_events: [eventRow] } });

  const newsResponse = await newsApi.onRequestGet({
    request: request(`/api/news?symbol=nvda&profile=semi&topic=${encodeURIComponent(injectedTopic)}&limit=9999`),
    env: { DB },
  });
  const eventResponse = await eventsApi.onRequestGet({
    request: request("/api/events?profile=semi&topic=earnings&importance=high&from=2026-07-23&to=2026-07-25"),
    env: { DB },
  });
  const newsPayload = await newsResponse.json();
  const eventPayload = await eventResponse.json();

  assertEnvelope(newsPayload);
  assertEnvelope(eventPayload);
  assert.equal(newsPayload.status, "stale");
  assert.equal(eventPayload.status, "ok");
  const newsCall = DB.calls[0];
  assert.equal(newsCall.sql.includes(injectedTopic), false);
  assert.equal(newsCall.params.includes(injectedTopic), true);
  assert.equal(newsCall.params.at(-1), 2000);
  assert.match(DB.calls[1].sql, /importance\s*=\s*\?/i);
  assert.deepEqual(DB.calls[1].params.slice(0, 3), ["semi", "earnings", "high"]);
});

test("news envelope freshness follows the newest article instead of the oldest row", async () => {
  const DB = new FakeD1({
    rows: {
      news_items: [
        {
          id: "news-new",
          symbol: "NVDA",
          profile_id: "semi",
          title: "Newest",
          published_at: "2026-07-26T05:00:00Z",
          source: "wire",
          as_of: "2026-07-26T05:00:00Z",
          fetched_at: "2026-07-26T05:01:00Z",
          freshness: "fresh",
          adjustment: null,
          quality: "good",
        },
        {
          id: "news-old",
          symbol: "NVDA",
          profile_id: "semi",
          title: "Old",
          published_at: "2026-07-20T05:00:00Z",
          source: "wire",
          as_of: "2026-07-20T05:00:00Z",
          fetched_at: "2026-07-26T05:01:00Z",
          freshness: "stale",
          adjustment: null,
          quality: "good",
        },
      ],
    },
  });

  const response = await newsApi.onRequestGet({
    request: request("/api/news?profile=semi"),
    env: { DB },
  });
  const payload = await response.json();

  assert.equal(payload.status, "ok");
  assert.equal(payload.asOf, "2026-07-26T05:00:00Z");
  assert.equal(payload.data.length, 2);
});

test("events expose structured provenance, safe delivery state, and an after cursor", async () => {
  const oldEvent = {
    id: "event-old",
    symbol: "515880.SS",
    profile_id: "semi",
    topic: "market_move",
    importance: "high",
    event_at: "2026-07-24T08:45:00Z",
    title: "Old",
    source: "signal-engine",
    as_of: "2026-07-24T08:45:00Z",
    fetched_at: "2026-07-24T08:45:05Z",
    freshness: "fresh",
    adjustment: "none",
    quality: "good",
    provider: "tencent",
    provider_as_of: "2026-07-24T08:45:00Z",
    provider_quality: "good",
    rule_version: "intraday-signal-v1",
  };
  const event = {
    ...oldEvent,
    id: "event-new",
    event_at: "2026-07-24T09:00:00Z",
    title: "New",
    as_of: "2026-07-24T09:00:00Z",
    provider_as_of: "2026-07-24T09:00:00Z",
  };
  const DB = new FakeD1({ rows: {
    market_events: [oldEvent, event],
    notification_deliveries: [{
      event_id: "event-new",
      profile_id: "semi",
      channel: "pushPlus",
      status: "skipped",
      policy_snapshot_json: '{"secret":"must-not-leak"}',
      reason_code: "SHADOW_MODE",
      attempt_count: 0,
      next_attempt_at: null,
      last_attempt_at: null,
      sent_at: null,
      updated_at: "2026-07-24T09:00:05Z",
    }],
  } });
  const response = await eventsApi.onRequestGet({
    request: request("/api/events?profile=semi&after=2026-07-24T08:50:00Z"),
    env: { DB },
  });
  const payload = await response.json();

  assert.equal(payload.status, "ok");
  assert.equal(
    payload.cursor,
    '["2026-07-24T09:00:00Z","event-new"]',
  );
  assert.deepEqual(payload.data.map(({ id }) => id), ["event-new"]);
  assert.equal(payload.data[0].provider, "tencent");
  assert.equal(payload.data[0].provider_as_of, "2026-07-24T09:00:00Z");
  assert.deepEqual(payload.data[0].deliveries, [{
    channel: "pushPlus",
    status: "skipped",
    reasonCode: "SHADOW_MODE",
    attemptCount: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    sentAt: null,
    updatedAt: "2026-07-24T09:00:05Z",
  }]);
  assert.doesNotMatch(JSON.stringify(payload), /must-not-leak|policy_snapshot/i);
  assert.match(DB.calls[0].sql, /event_at\s*>\s*\?/i);
});

test("events use a composite cursor to page every equal-timestamp row in real SQLite", async (t) => {
  const value = await sqliteEventsFixture(t, { maxBindings: 100 });
  if (!value) return;
  const seen = [];
  let after = value.oldTimestamp;

  for (let page = 0; page < 4; page += 1) {
    const response = await eventsApi.onRequestGet({
      request: request(
        `/api/events?profile=semi&limit=40&after=${encodeURIComponent(after)}`,
      ),
      env: { DB: value.db },
    });
    const payload = await response.json();
    assert.equal(payload.status, "ok");
    seen.push(...payload.data.map(({ id }) => id));
    after = payload.cursor;
    if (payload.data.length < 40) break;
  }

  assert.equal(new Set(seen).size, 125);
  assert.deepEqual(
    seen,
    Array.from({ length: 125 }, (_, index) =>
      `event-${String(index + 1).padStart(3, "0")}`),
  );
  assert.deepEqual(JSON.parse(after), [
    "2026-07-24T09:00:00.000Z",
    "event-125",
  ]);
});

test("events enrich pages above one hundred rows without exceeding D1 bind limits", async (t) => {
  const value = await sqliteEventsFixture(t, { maxBindings: 100 });
  if (!value) return;
  const response = await eventsApi.onRequestGet({
    request: request("/api/events?profile=semi&limit=125"),
    env: { DB: value.db },
  });
  const payload = await response.json();

  assert.equal(payload.status, "ok");
  assert.equal(payload.data.length, 125);
  assert.equal(
    payload.data.every(({ deliveries }) => deliveries.length === 1),
    true,
  );
});

test("monitor status returns source health in the same envelope", async () => {
  const DB = new FakeD1({ rows: { source_health: [{
    source: "wire",
    status: "degraded",
    as_of: "2026-07-23T09:00:00Z",
    fetched_at: "2026-07-23T09:00:05Z",
    freshness: "fresh",
    adjustment: null,
    quality: "partial",
    detail: "rate limited",
  }] } });
  const response = await monitorApi.onRequestGet({
    request: request("/api/monitor-status?source=wire&limit=10"),
    env: { DB },
  });
  const payload = await response.json();

  assertEnvelope(payload);
  assert.equal(payload.status, "degraded");
  assert.equal(payload.sources[0].adjustment, null);
  assert.equal(DB.calls[0].params[0], "wire");
  assert.equal(typeof DB.calls[0].params[1], "string");
  assert.equal(DB.calls[0].params[2], 10);
});

test("monitor status adds profile-scoped safe notification state and cursor", async () => {
  const DB = new FakeD1({ rows: {
    source_health: [{
      source: "wire",
      status: "ok",
      as_of: "2026-07-24T09:00:00Z",
      fetched_at: "2026-07-24T09:00:05Z",
      freshness: "fresh",
      adjustment: null,
      quality: "good",
    }],
    notification_deliveries: [
      {
        event_id: "event-other",
        profile_id: "other",
        channel: "pushPlus",
        status: "failed",
        reason_code: "PUSHPLUS_HTTP_500",
        attempt_count: 1,
        updated_at: "2026-07-24T09:02:00Z",
      },
      {
        event_id: "event-1",
        profile_id: "semi",
        channel: "pushPlus",
        status: "uncertain",
        reason_code: "PUSHPLUS_TIMEOUT",
        attempt_count: 1,
        updated_at: "2026-07-24T09:03:00Z",
        policy_snapshot_json: '{"private":"hidden"}',
      },
    ],
  } });
  const response = await monitorApi.onRequestGet({
    request: request("/api/monitor-status?profile=semi&after=2026-07-24T09:01:00Z"),
    env: { DB },
  });
  const payload = await response.json();

  assert.equal(payload.status, "ok");
  assert.equal(
    payload.cursor,
    '["2026-07-24T09:03:00Z","event-1:pushPlus"]',
  );
  assert.deepEqual(payload.notifications, [{
    eventId: "event-1",
    channel: "pushPlus",
    status: "uncertain",
    reasonCode: "PUSHPLUS_TIMEOUT",
    attemptCount: 1,
    nextAttemptAt: null,
    lastAttemptAt: null,
    sentAt: null,
    updatedAt: "2026-07-24T09:03:00Z",
  }]);
  assert.doesNotMatch(JSON.stringify(payload), /private|policy_snapshot/i);
});

test("monitor status exposes bounded D1 capacity only when explicitly requested", async () => {
  const calls = [];
  const rows = {
    market_bars: 100001,
    news_items: 530,
    market_events: 21,
    evidence_packets: 9,
    report_manifests: 58,
    chat_messages: 17,
    notification_deliveries: 4,
    fund_flows: 19636,
  };
  const DB = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          calls.push(sql);
          if (/FROM source_health/i.test(sql)) return { results: [] };
          if (/FROM notification_deliveries/i.test(sql)) return { results: [] };
          throw new Error("unexpected all query");
        },
        async first() {
          calls.push(sql);
          if (/^SELECT\s+\(SELECT COUNT/i.test(sql.trim())) return rows;
          if (/PRAGMA page_count/i.test(sql)) return { page_count: 320 };
          if (/PRAGMA page_size/i.test(sql)) return { page_size: 4096 };
          throw new Error("unexpected first query");
        },
      };
    },
  };
  const response = await monitorApi.onRequestGet({
    request: request("/api/monitor-status?capacity=1"),
    env: { DB },
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.capacity.status, "ok");
  assert.equal(payload.capacity.reason, null);
  assert.equal(Number.isFinite(Date.parse(payload.capacity.measuredAt)), true);
  assert.deepEqual(payload.capacity.storage, {
    status: "ok",
    pageCount: 320,
    pageSize: 4096,
    estimatedBytes: 1310720,
  });
  assert.deepEqual(payload.capacity.tables[0], {
    name: "market_bars",
    rowCount: 100001,
    atLeast: true,
  });
  assert.deepEqual(payload.capacity.tables.find(({ name }) => name === "fund_flows"), {
    name: "fund_flows",
    rowCount: 19636,
    atLeast: false,
  });
  assert.match(calls.find((sql) => /^SELECT\s+\(SELECT COUNT/i.test(sql.trim())), /LIMIT 100001/i);

  const withoutCapacity = await monitorApi.onRequestGet({
    request: request("/api/monitor-status"),
    env: { DB: new FakeD1() },
  });
  assert.equal("capacity" in await withoutCapacity.json(), false);
});

test("monitor status capacity distinguishes invalid input, missing binding and timeout", async () => {
  const invalid = await monitorApi.onRequestGet({
    request: request("/api/monitor-status?capacity=true"),
    env: {},
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).capacity.reason, "invalid_parameter");

  const missing = await monitorApi.onRequestGet({
    request: request("/api/monitor-status?capacity=1"),
    env: {},
  });
  assert.equal((await missing.json()).capacity.reason, "no_binding");

  const never = new Promise(() => {});
  const timeoutDb = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          if (/FROM source_health/i.test(sql) || /FROM notification_deliveries/i.test(sql)) {
            return { results: [] };
          }
          throw new Error("unexpected all query");
        },
        async first() { return never; },
      };
    },
  };
  const timedOut = await monitorApi.onRequestGet({
    request: request("/api/monitor-status?capacity=1"),
    env: { DB: timeoutDb, D1_CAPACITY_TIMEOUT_MS: "25" },
  });
  assert.equal((await timedOut.json()).capacity.reason, "query_timeout");
});

test("dynamic queries exclude expired rows before ordering and limiting", async () => {
  const base = {
    symbol: "SPY",
    profile_id: "us-core",
    timeframe: "5m",
    source: "market-provider",
    as_of: "2026-07-23T10:01:00Z",
    fetched_at: "2026-07-23T10:01:05Z",
    freshness: "fresh",
    adjustment: "none",
    quality: "good",
  };
  const DB = new FakeD1({ rows: { market_bars: [
    { ...base, ts: "2026-07-23T10:03:00Z", close: 999, expires_at: "2000-01-01T00:00:00Z" },
    { ...base, ts: "2026-07-23T10:01:00Z", close: 621, expires_at: null },
    { ...base, ts: "2026-07-23T10:02:00Z", close: 622, expires_at: "2099-01-01T00:00:00Z" },
  ] } });

  const response = await marketApi.onRequestGet({
    request: request("/api/market?symbol=SPY&limit=1"),
    env: { DB },
  });
  const payload = await response.json();

  assert.equal(payload.status, "ok");
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0].close, 622);
  assert.match(DB.calls[0].sql, /expires_at\s+IS\s+NULL\s+OR\s+expires_at\s*>\s*\?/i);
  assert.equal(typeof DB.calls[0].params[1], "string");
  assert.equal(DB.calls[0].params.at(-1), 6);
});

test("expired-only market, news, events, and source health return unavailable", async () => {
  const expired = {
    source: "expired-source",
    as_of: "2026-07-23T09:00:00Z",
    fetched_at: "2026-07-23T09:00:05Z",
    freshness: "fresh",
    adjustment: null,
    quality: "good",
    expires_at: "2000-01-01T00:00:00Z",
  };
  const cases = [
    [marketApi, "market_bars", { ...expired, symbol: "SPY", timeframe: "1d", ts: "2026-07-23T00:00:00Z" }],
    [newsApi, "news_items", { ...expired, id: "expired-news", title: "old", published_at: "2026-07-23T00:00:00Z" }],
    [eventsApi, "market_events", { ...expired, id: "expired-event", importance: "low", title: "old", event_at: "2026-07-23T00:00:00Z" }],
    [monitorApi, "source_health", { ...expired, status: "ok" }],
  ];
  for (const [api, table, row] of cases) {
    const response = await api.onRequestGet({
      request: request("/api/data"),
      env: { DB: new FakeD1({ rows: { [table]: [row] } }) },
    });
    const payload = await response.json();
    assert.equal(payload.status, "unavailable");
    assert.deepEqual(payload.data, []);
  }
});

test("monitor status distinguishes total outage, partial outage, and unknown states", async () => {
  const health = (source, status) => ({
    source,
    status,
    as_of: "2026-07-23T09:00:00Z",
    fetched_at: "2026-07-23T09:00:05Z",
    freshness: "fresh",
    adjustment: null,
    quality: "good",
    expires_at: null,
  });
  const cases = [
    [[health("a", "unavailable"), health("b", "unavailable")], "unavailable"],
    [[health("a", "ok"), health("b", "unavailable")], "degraded"],
    [[health("a", "mystery")], "unavailable"],
    [[health("a", "ok"), health("b", "mystery")], "degraded"],
  ];
  for (const [rows, expected] of cases) {
    const response = await monitorApi.onRequestGet({
      request: request("/api/monitor-status"),
      env: { DB: new FakeD1({ rows: { source_health: rows } }) },
    });
    assert.equal((await response.json()).status, expected);
  }
});

test("dynamic APIs return unavailable envelopes for missing, empty, or failing D1", async () => {
  const apis = [marketApi, newsApi, eventsApi, monitorApi];
  for (const api of apis) {
    for (const env of [{}, { DB: new FakeD1() }, { DB: new FakeD1({ fail: true }) }]) {
      const response = await api.onRequestGet({ request: request("/api/data"), env });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assertEnvelope(payload);
      assert.equal(payload.status, "unavailable");
      assert.deepEqual(payload.data, []);
    }
  }
});

test("dynamic APIs reject invalid filters without querying D1", async () => {
  const DB = new FakeD1();
  const cases = [
    [marketApi, "/api/market?symbol=SPY%27%20OR%201%3D1--"],
    [marketApi, "/api/market?timeframe=yearly"],
    [newsApi, "/api/news?limit=-2"],
    [eventsApi, "/api/events?importance=urgent"],
    [eventsApi, "/api/events?from=2026-07-25&to=2026-07-23"],
  ];
  for (const [api, path] of cases) {
    const response = await api.onRequestGet({ request: request(path), env: { DB } });
    assert.equal(response.status, 400);
    assertEnvelope(await response.json());
  }
  assert.equal(DB.calls.length, 0);
});
