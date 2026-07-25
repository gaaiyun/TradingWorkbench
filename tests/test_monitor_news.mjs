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

const SEC_ATOM = `<?xml version="1.0" encoding="ISO-8859-1"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <company-info>
    <cik>0001341439</cik>
    <conformed-name>ORACLE CORP</conformed-name>
  </company-info>
  <entry>
    <category term="8-K" scheme="https://www.sec.gov/" label="form type" />
    <content type="text/xml">
      <accession-number>0001193125-26-265848</accession-number>
      <filing-date>2026-07-23</filing-date>
      <filing-type>8-K</filing-type>
      <form-name>Current report</form-name>
    </content>
    <link type="text/html" href="https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/example-index.htm" rel="alternate" />
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-07-23&lt;br&gt;Item 2.02: Results of Operations and Financial Condition</summary>
    <title>8-K  - Current report</title>
    <updated>2026-07-23T16:13:46-04:00</updated>
  </entry>
</feed>`;

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

test("SEC EDGAR Atom parser keeps the official filing URL and source timestamp", async () => {
  const { parseSecEdgarAtom } = await import(newsUrl);
  assert.deepEqual(parseSecEdgarAtom(SEC_ATOM), [{
    title: "ORACLE CORP — 8-K - Current report",
    url: "https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/example-index.htm",
    publishedAt: "2026-07-23T20:13:46.000Z",
    summary: "Filed: 2026-07-23 Item 2.02: Results of Operations and Financial Condition",
    publisher: "ORACLE CORP",
  }]);
});

test("SEC EDGAR Atom parser accepts namespace prefixes and rejects non-8-K entries", async () => {
  const { parseSecEdgarAtom } = await import(newsUrl);
  const xml = `<?xml version="1.0"?>
  <atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
    <atom:entry>
      <atom:category label="form type" term="8-K" />
      <atom:link rel="alternate" href="https://example.com/not-sec" />
      <atom:link
        href="https://www.sec.gov/Archives/edgar/data/1652044/official-index.htm"
        type="text/html"
        rel="alternate"
      />
      <atom:summary><![CDATA[Item 8.01: Other Events]]></atom:summary>
      <atom:title>8-K - Current report</atom:title>
      <atom:updated>2026-07-22T18:01:02Z</atom:updated>
    </atom:entry>
    <atom:entry>
      <atom:category term="10-Q" label="form type" />
      <atom:link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1652044/quarterly-index.htm" />
      <atom:title>10-Q - Quarterly report</atom:title>
      <atom:updated>2026-07-22T18:00:00Z</atom:updated>
    </atom:entry>
  </atom:feed>`;
  assert.deepEqual(parseSecEdgarAtom(xml, "Alphabet Inc."), [{
    title: "Alphabet Inc. — 8-K - Current report",
    url: "https://www.sec.gov/Archives/edgar/data/1652044/official-index.htm",
    publishedAt: "2026-07-22T18:01:02.000Z",
    summary: "Item 8.01: Other Events",
    publisher: "Alphabet Inc.",
  }]);
});

test("Oracle and Alphabet prefer deduplicated SEC 8-K evidence before discovery feeds", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const duplicateEntry = SEC_ATOM.match(/<entry>[\s\S]*?<\/entry>/)[0]
    .replace("example-index.htm", "example-index.htm?utm_source=edgar");
  const oracleAtom = SEC_ATOM.replace("</feed>", `${duplicateEntry}</feed>`);
  const alphabetAtom = SEC_ATOM
    .replaceAll("0001341439", "0001652044")
    .replace("ORACLE CORP", "Alphabet Inc.")
    .replaceAll("1341439/", "1652044/")
    .replace("example-index.htm", "alphabet-index.htm");
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "ORCL" }, { symbol: "GOOGL" }],
    },
    db: {},
    fetcher: async (url) => {
      const value = new URL(url);
      calls.push(value);
      const xml = value.searchParams.get("CIK") === "0001341439"
        ? oracleAtom
        : alphabetAtom;
      return new Response(xml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((url) => url.searchParams.get("CIK")).sort(),
    ["0001341439", "0001652044"],
  );
  assert.equal(calls.every((url) =>
    url.hostname === "www.sec.gov"
    && url.searchParams.get("type") === "8-K"
    && url.searchParams.get("output") === "atom"), true);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(({ symbol }) => symbol).sort(), ["GOOGL", "ORCL"]);
  assert.equal(items.every(({ sourceTier }) => sourceTier === "evidence"), true);
  assert.equal(items.every(({ quality }) => quality === "evidence"), true);
  assert.equal(items.every(({ publishedAt, asOf }) =>
    publishedAt === "2026-07-23T20:13:46.000Z"
    && asOf === publishedAt), true);
  assert.equal(items.every(({ url }) =>
    new URL(url).hostname === "www.sec.gov"
    && new URL(url).pathname.startsWith("/Archives/edgar/data/")), true);
  assert.equal(
    items.some(({ source }) => source === "SEC EDGAR 8-K / ORACLE CORP"),
    true,
  );
  assert.equal(
    items.some(({ source }) => source === "SEC EDGAR 8-K / Alphabet Inc."),
    true,
  );
});

test("HashKey investor page parser extracts the embedded official post feed", async () => {
  const { parseHashKeyFeedPage } = await import(newsUrl);
  const posts = JSON.stringify([{
    id: "official-1",
    title: "HashKey Holdings publishes a licensed exchange update",
    excerpt: "The company explains its latest regulated digital asset service.",
    firstPublishedDate: "2026-07-21T01:39:24.598Z",
    url: {
      base: "https://group.hashkey.com/en",
      path: "/newsroom/licensed-exchange-update",
    },
  }]);
  const encoded = JSON.stringify(posts).slice(1, -1);
  const html = `prefix \\"posts\\":{\\"posts\\":${encoded},\\"metaData\\":{\\"count\\":1} suffix`;
  assert.deepEqual(parseHashKeyFeedPage(html), [{
    title: "HashKey Holdings publishes a licensed exchange update",
    url: "https://group.hashkey.com/en/newsroom/licensed-exchange-update",
    publishedAt: "2026-07-21T01:39:24.598Z",
    summary: "The company explains its latest regulated digital asset service.",
    publisher: "HashKey Holdings",
  }]);
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
  assert.equal(semiconductor.publisher, "财经日报");
  assert.equal(semiconductor.relevance, 1);
  assert.match(semiconductor.clusterId, /^cluster-[a-f0-9]{64}$/);
  assert.equal(semiconductor.quality, "discovery");
  assert.match(semiconductor.id, /^news-[a-f0-9]{64}$/);
  assert.equal(semiconductor.freshness, "fresh");
  assert.equal(semiconductor.expiresAt, "2027-01-19T01:30:00.000Z");
});

test("news routing recognizes Alphabet and HashKey while requiring full aliases", async () => {
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
    <item><title>HashKey Holdings expands licensed digital asset services</title><link>https://example.com/hashkey</link><pubDate>Thu, 23 Jul 2026 01:10:00 GMT</pubDate><description>HashKey Group reports a regulated exchange update.</description><source>HKEXnews</source></item>
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

test("HashKey news prefers the official investor feed before discovery providers", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const writes = [];
  const calls = [];
  const posts = JSON.stringify([{
    id: "official-1",
    title: "HashKey Holdings signs a regulated infrastructure agreement",
    excerpt: "HashKey Group announced an update for its licensed digital asset platform.",
    firstPublishedDate: "2026-07-21T01:39:24.598Z",
    url: {
      base: "https://group.hashkey.com/en",
      path: "/newsroom/regulated-infrastructure-agreement",
    },
  }]);
  const encoded = JSON.stringify(posts).slice(1, -1);
  const officialHtml = `prefix \\"posts\\":{\\"posts\\":${encoded},\\"metaData\\":{\\"count\\":1} suffix`;
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "3887.HK" }],
    },
    db: {},
    fetcher: async (url) => {
      calls.push(String(url));
      return new Response(officialHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  const item = writes.flatMap(({ items }) => items)[0];
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "https://group.hashkey.com/en/news/categories/announcement-1");
  assert.equal(item.symbol, "3887.HK");
  assert.equal(item.source, "HashKey Investor Relations");
  assert.equal(item.sourceTier, "evidence");
  assert.equal(item.quality, "evidence");
});

test("news collection falls back to Yahoo feeds for Alphabet and HashKey", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const profile = {
    ...monitorSettings().profiles[0],
    targets: [
      { symbol: "GOOGL" },
      { symbol: "3887.HK" },
    ],
  };
  const result = await collectNewsForProfile({
    profile,
    db: {},
    fetcher: async (url) => {
      const value = String(url);
      calls.push(value);
      if (
        value.includes("sec.gov")
        || value.includes("group.hashkey.com")
        || value.includes("news.google.com")
      ) {
        return new Response("", { status: 503 });
      }
      const symbol = new URL(value).searchParams.get("s");
      const item = symbol === "GOOGL"
        ? "<item><title>Alphabet reports Google Cloud growth</title><link>https://finance.example/googl</link><pubDate>Thu, 23 Jul 2026 01:20:00 GMT</pubDate><description>Alphabet discusses AI investment.</description><source>Company IR</source></item>"
        : "<item><title>HashKey Holdings issues licensed exchange update</title><link>https://finance.example/hashkey</link><pubDate>Thu, 23 Jul 2026 01:10:00 GMT</pubDate><description>HashKey Group discusses digital asset regulation.</description><source>HKEXnews</source></item>";
      return new Response(`<?xml version="1.0"?><rss><channel>${item}</channel></rss>`, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(result.status, "completed");
  assert.equal(items.some(({ symbol }) => symbol === "GOOGL"), true);
  assert.equal(items.some(({ symbol }) => symbol === "3887.HK"), true);
  assert.equal(items.every(({ source }) => source.startsWith("Yahoo Finance RSS /")), true);
  assert.equal(items.every(({ sourceTier }) => sourceTier === "discovery"), true);
  assert.equal(calls.some((url) => url.includes("s=GOOGL")), true);
  assert.equal(calls.some((url) => url.includes("s=3887.HK")), true);
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "sec-edgar-8k"
      && status === "failed"
      && reason === "NEWS_HTTP_503"),
    true,
  );
  assert.equal(
    result.sources.filter(({ source, status }) =>
      source === "google-news-rss" && status === "failed").length,
    2,
  );
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
    publisher: "Publisher",
    relevance: 1,
    clusterId: `cluster-${"b".repeat(64)}`,
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
  assert.match(calls[0].sql, /\bpublisher\b/i);
  assert.match(calls[0].sql, /\brelevance\b/i);
  assert.match(calls[0].sql, /\bcluster_id\b/i);
  assert.equal(calls[0].payload[0].summary, "允许保存的短摘要");
  assert.equal(calls[0].payload[0].publisher, "Publisher");
  assert.equal("body" in calls[0].payload[0], false);
});
