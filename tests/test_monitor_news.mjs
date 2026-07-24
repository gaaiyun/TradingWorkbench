import assert from "node:assert/strict";
import test from "node:test";

import { monitorSettings } from "./helpers/monitor_settings.mjs";

const newsUrl = new URL(
  "../workers/monitor/src/news-collector.mjs",
  import.meta.url,
);

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title><![CDATA[半导体ETF份额增长，设备板块走强 - 财经日报]]></title>
    <link>https://example.com/semiconductor?utm_source=rss</link>
    <pubDate>Thu, 23 Jul 2026 01:20:00 GMT</pubDate>
    <description><![CDATA[<b>半导体设备</b>景气度受到关注。]]></description>
    <source url="https://example.com">财经日报</source>
  </item>
  <item>
    <title><![CDATA[SMH publishes its morning city briefing - Local Daily]]></title>
    <link>https://example.com/city</link>
    <pubDate>Thu, 23 Jul 2026 01:10:00 GMT</pubDate>
    <description>Ordinary local news.</description>
    <source url="https://example.com">Local Daily</source>
  </item>
</channel></rss>`;

test("Google News RSS parser preserves evidence metadata and strips markup", async () => {
  const { parseGoogleNewsRss } = await import(newsUrl);
  assert.deepEqual(parseGoogleNewsRss(RSS), [
    {
      title: "半导体ETF份额增长，设备板块走强 - 财经日报",
      url: "https://example.com/semiconductor?utm_source=rss",
      publishedAt: "2026-07-23T01:20:00.000Z",
      summary: "半导体设备景气度受到关注。",
      publisher: "财经日报",
    },
    {
      title: "SMH publishes its morning city briefing - Local Daily",
      url: "https://example.com/city",
      publishedAt: "2026-07-23T01:10:00.000Z",
      summary: "Ordinary local news.",
      publisher: "Local Daily",
    },
  ]);
});

test("news collection writes relevant discovery items and rejects bare SMH false positives", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const writes = [];
  const calls = [];
  const result = await collectNewsForProfile({
    profile: monitorSettings().profiles[0],
    db: {},
    fetcher: async (url) => {
      calls.push(url);
      return new Response(RSS, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  const items = writes.flatMap(({ items }) => items);
  assert.ok(calls.length >= 3);
  assert.equal(result.status, "completed");
  assert.equal(items.some(({ title }) => title.startsWith("半导体ETF")), true);
  assert.equal(items.some(({ title }) => title.startsWith("SMH publishes")), false);
  const semiconductor = items.find(({ title }) => title.startsWith("半导体ETF"));
  assert.equal(semiconductor.symbol, "159995.SZ");
  assert.equal(semiconductor.topic, "cn-semiconductor");
  assert.equal(semiconductor.source, "Google News / 财经日报");
  assert.equal(semiconductor.quality, "discovery");
  assert.match(semiconductor.id, /^news-[a-f0-9]{64}$/);
  assert.equal(semiconductor.freshness, "fresh");
  assert.equal(semiconductor.expiresAt, "2027-01-19T01:30:00.000Z");
});

test("news routing recognizes Alphabet and Bitdeer while requiring full aliases", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const writes = [];
  const profile = {
    ...monitorSettings().profiles[0],
    targets: [
      { symbol: "GOOGL" },
      { symbol: "3887.HK" },
    ],
  };
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title>Alphabet Cloud earnings update</title><link>https://example.com/googl</link><pubDate>Thu, 23 Jul 2026 01:20:00 GMT</pubDate><description>Google Cloud and AI investment.</description><source>Reuters</source></item>
    <item><title>Bitdeer Technologies expands mining capacity</title><link>https://example.com/bitdeer</link><pubDate>Thu, 23 Jul 2026 01:10:00 GMT</pubDate><description>Bitdeer reports a new data center plan.</description><source>HKEXnews</source></item>
    <item><title>Google maps traffic update</title><link>https://example.com/maps</link><pubDate>Thu, 23 Jul 2026 01:00:00 GMT</pubDate><description>Ordinary local news.</description><source>Local Daily</source></item>
  </channel></rss>`;
  await collectNewsForProfile({
    profile,
    db: {},
    fetcher: async () => new Response(rss, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    }),
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(items.some((item) => item.symbol === "GOOGL"), true);
  assert.equal(items.some((item) => item.symbol === "3887.HK"), true);
  assert.equal(items.some((item) => item.url.endsWith("/maps")), false);
  assert.equal(items.every((item) => item.sourceTier === "discovery"), true);
});

test("news collection falls back to one cached MIIT RSS request when Google is blocked", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const result = await collectNewsForProfile({
    profile: monitorSettings().profiles[0],
    db: {},
    fetcher: async (url) => {
      calls.push(url);
      if (String(url).includes("news.google.com")) {
        return new Response("", { status: 403 });
      }
      return new Response(RSS, {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  const items = writes.flatMap(({ items }) => items);
  assert.equal(result.status, "completed");
  assert.equal(
    calls.filter((url) => new URL(url).hostname === "www.miit.gov.cn").length,
    1,
    "多个 A 股主题共用同一官方 RSS 响应，避免重复下载大文档",
  );
  assert.equal(items.some(({ source }) => source === "工业和信息化部 RSS"), true);
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "google-news-rss" &&
      status === "failed" &&
      reason === "NEWS_HTTP_403"),
    true,
  );
  assert.equal(
    result.sources.some(({ source, status }) =>
      source === "miit-rss" && status === "success"),
    true,
  );
});

test("news writer uses idempotent upserts without storing article bodies", async () => {
  const { writeNewsItems } = await import(newsUrl);
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(payload) {
          return {
            async run() {
              calls.push({ sql, payload: JSON.parse(payload) });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const item = {
    id: `news-${"a".repeat(64)}`,
    symbol: "159995.SZ",
    profileId: "etf-main",
    topic: "cn-semiconductor",
    title: "芯片产业动态",
    summary: "允许保存的短摘要",
    url: "https://example.com/news",
    publishedAt: "2026-07-23T01:20:00.000Z",
    source: "Google News / Publisher",
    asOf: "2026-07-23T01:20:00.000Z",
    fetchedAt: "2026-07-23T01:30:00.000Z",
    freshness: "fresh",
    adjustment: null,
    quality: "discovery",
    expiresAt: "2027-01-19T01:30:00.000Z",
  };
  await writeNewsItems(db, { items: [item] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT\(id\)\s+DO UPDATE/i);
  assert.equal(calls[0].payload[0].summary, "允许保存的短摘要");
  assert.equal("body" in calls[0].payload[0], false);
});
