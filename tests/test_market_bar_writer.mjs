import assert from "node:assert/strict";
import test from "node:test";

const writerUrl = new URL(
  "../workers/monitor/src/providers/market-bar-writer.mjs",
  import.meta.url,
);

function marketBar(overrides = {}) {
  return {
    symbol: "515880.SS",
    timeframe: "5m",
    timestamp: "2026-07-23T02:00:00.000Z",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1000,
    source: "tencent",
    asOf: "2026-07-23T02:00:00.000Z",
    fetchedAt: "2026-07-23T02:05:00.000Z",
    freshness: "fresh",
    adjustment: "none",
    quality: "good",
    ...overrides,
  };
}

class FakeBarsD1 {
  constructor() {
    this.rows = new Map();
    this.prepared = [];
    this.batchCalls = 0;
  }

  prepare(sql) {
    this.prepared.push(sql);
    return {
      bind: (...values) => ({
        sql,
        values,
        run: async () => {
          const key = [
            values[0],
            values[1],
            values[2],
            values[3],
            values[9],
            values[13],
          ].join("|");
          this.rows.set(key, values);
          return { meta: { changes: 1 } };
        },
      }),
    };
  }

  async batch(statements) {
    this.batchCalls += 1;
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

test("writes normalized bars with parameterized D1 batch statements", async () => {
  const { writeMarketBars } = await import(writerUrl);
  const db = new FakeBarsD1();
  const result = await writeMarketBars(db, {
    profileId: "profile-a",
    bars: [marketBar()],
    now: new Date("2026-07-23T02:05:00.000Z"),
  });

  assert.deepEqual(result, { written: 1 });
  assert.equal(db.batchCalls, 1);
  assert.equal(db.rows.size, 1);
  assert.match(db.prepared[0], /INSERT INTO market_bars/i);
  assert.match(db.prepared[0], /ON CONFLICT\s*\(\s*profile_id\s*,\s*symbol/i);
  assert.equal(db.prepared[0].includes("profile-a"), false);
  assert.equal(db.prepared[0].includes("515880.SS"), false);
  const values = [...db.rows.values()][0];
  assert.deepEqual(values.slice(0, 4), [
    "profile-a",
    "515880.SS",
    "5m",
    "2026-07-23T02:00:00.000Z",
  ]);
});

test("keeps the same source bar for two profiles and makes repeats idempotent", async () => {
  const { writeMarketBars } = await import(writerUrl);
  const db = new FakeBarsD1();
  const now = new Date("2026-07-23T02:05:00.000Z");

  await writeMarketBars(db, { profileId: "profile-a", bars: [marketBar()], now });
  await writeMarketBars(db, { profileId: "profile-a", bars: [marketBar()], now });
  await writeMarketBars(db, { profileId: "profile-b", bars: [marketBar()], now });

  assert.equal(db.rows.size, 2);
  assert.equal(
    [...db.rows.keys()].some((key) => key.startsWith("profile-a|")),
    true,
  );
  assert.equal(
    [...db.rows.keys()].some((key) => key.startsWith("profile-b|")),
    true,
  );
});

test("rejects bad numeric, timestamp, and metadata values before touching D1", async () => {
  const { MarketBarWriteError, writeMarketBars } = await import(writerUrl);
  const invalidBars = [
    marketBar({ close: Number.NaN }),
    marketBar({ timestamp: "invalid" }),
    marketBar({ high: 8 }),
    marketBar({ freshness: "cached-but-fresh" }),
    marketBar({ source: "" }),
  ];

  for (const bar of invalidBars) {
    const db = new FakeBarsD1();
    await assert.rejects(
      () => writeMarketBars(db, {
        profileId: "profile-a",
        bars: [bar],
        now: new Date("2026-07-23T02:05:00.000Z"),
      }),
      (error) => error instanceof MarketBarWriteError && error.code === "INVALID_BAR",
    );
    assert.equal(db.prepared.length, 0);
    assert.equal(db.batchCalls, 0);
  }
});

test("retains 5m bars for 90 days and 1d bars for five calendar years", async () => {
  const { retentionExpiry, writeMarketBars } = await import(writerUrl);
  const now = new Date("2026-07-23T02:05:00.000Z");
  assert.equal(
    retentionExpiry("5m", now),
    new Date(now.valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  );
  assert.equal(retentionExpiry("1d", now), "2031-07-23T02:05:00.000Z");

  const db = new FakeBarsD1();
  await writeMarketBars(db, {
    profileId: "profile-a",
    bars: [marketBar(), marketBar({
      timeframe: "1d",
      timestamp: "2026-07-23T00:00:00.000Z",
      asOf: "2026-07-23T00:00:00.000Z",
    })],
    now,
  });
  const expiries = [...db.rows.values()].map((values) => values.at(-1)).sort();
  assert.deepEqual(expiries, [
    "2026-10-21T02:05:00.000Z",
    "2031-07-23T02:05:00.000Z",
  ]);
});
