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

const SEC_SUBMISSIONS = JSON.stringify({
  cik: "1341439",
  entityType: "operating",
  name: "ORACLE CORP",
  tickers: ["ORCL"],
  filings: {
    recent: {
      accessionNumber: [
        "0001193125-26-265848",
        "0001193125-26-260001",
      ],
      filingDate: ["2026-07-23", "2026-07-22"],
      reportDate: ["2026-07-23", "2026-05-31"],
      acceptanceDateTime: [
        "2026-07-23T20:13:46.000Z",
        "2026-07-22T18:00:00.000Z",
      ],
      form: ["8-K", "10-Q"],
      items: ["2.02", ""],
      primaryDocument: ["example-index.htm", "quarterly.htm"],
      primaryDocDescription: ["Current report", "Quarterly report"],
    },
  },
});

const EASTMONEY_JSONP = `callback({
  "code": 0,
  "result": {
    "cmsArticleWebOld": [
      {
        "date": "2026-07-25 12:14:47",
        "title": "半导体ETF资金回流，芯片产业成交活跃",
        "content": "半导体设备与集成电路板块受到资金关注。",
        "mediaName": "每日经济新闻",
        "url": "http://finance.eastmoney.com/a/202607253821111766.html"
      }
    ]
  }
})`;

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

test("Eastmoney JSONP parser normalizes publisher, source time and article URL", async () => {
  const { parseEastmoneySearch } = await import(newsUrl);
  assert.deepEqual(parseEastmoneySearch(EASTMONEY_JSONP), [{
    title: "半导体ETF资金回流，芯片产业成交活跃",
    url: "https://finance.eastmoney.com/a/202607253821111766.html",
    publishedAt: "2026-07-25T04:14:47.000Z",
    summary: "半导体设备与集成电路板块受到资金关注。",
    publisher: "每日经济新闻",
  }]);
});

test("SSE fund announcement parser keeps exact ETF filings and official PDF links", async () => {
  const { parseSseFundAnnouncements } = await import(newsUrl);
  const payload = `TradingWorkbenchSse(${JSON.stringify({
    result: [
      {
        SSEDATE: "2026-07-21",
        TITLE: "国联安中证全指半导体产品与设备ETF 2026年第2季度报告",
        SECURITY_CODE: "512480",
        BULLETIN_TYPE: "季报",
        URL: "/disclosure/fund/announcement/c/new/2026-07-21/512480_report.pdf",
      },
      {
        SSEDATE: "2026-07-03",
        TITLE: "国联安半导体ETF基金份额拆分结果公告",
        SECURITY_CODE: "512480",
        BULLETIN_TYPE: "其它",
        URL: "/disclosure/fund/announcement/c/new/2026-07-03/512480_split.pdf",
      },
      {
        SSEDATE: "2026-07-22",
        TITLE: "其他基金公告",
        SECURITY_CODE: "515880",
        URL: "/disclosure/fund/announcement/c/new/2026-07-22/other.pdf",
      },
    ],
  })})`;
  const items = parseSseFundAnnouncements(payload, "512480", {
    begin: "2026-06-23",
    end: "2026-07-23",
    now: new Date("2026-07-23T01:30:00.000Z"),
    targetSymbol: "512480.SS",
  });
  assert.equal(items.length, 2);
  assert.equal(items.every(({ url }) =>
    url.startsWith("https://www.sse.com.cn/disclosure/fund/announcement/")), true);
  assert.equal(items.every(({ publisher }) => publisher === "上海证券交易所"), true);
  assert.deepEqual(items[0]._topicSymbols, ["512480.SS"]);
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

test("SEC submissions parser keeps bounded current reports and official archive URLs", async () => {
  const { parseSecEdgarSubmissions } = await import(newsUrl);
  assert.deepEqual(parseSecEdgarSubmissions(SEC_SUBMISSIONS), [{
    title: "ORACLE CORP — 8-K - Current report",
    url: "https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/example-index.htm",
    publishedAt: "2026-07-23T20:13:46.000Z",
    summary: "Filed: 2026-07-23; report period: 2026-07-23; items: 2.02",
    publisher: "ORACLE CORP",
  }]);
});

test("Federal Reserve official RSS parser rejects foreign links and caps evidence items", async () => {
  const { parseFederalReserveRss } = await import(newsUrl);
  const entries = Array.from({ length: 12 }, (_value, index) => `
    <item>
      <title>Federal Reserve issues FOMC monetary policy update ${index + 1}</title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary202607${String(index + 1).padStart(2, "0")}a.htm</link>
      <pubDate>Thu, 23 Jul 2026 0${index % 9}:00:00 GMT</pubDate>
      <description>Official economic developments and monetary policy evidence.</description>
    </item>`).join("");
  const foreign = `
    <item>
      <title>Copied Federal Reserve announcement</title>
      <link>https://example.com/copied-fed-release</link>
      <pubDate>Thu, 23 Jul 2026 09:00:00 GMT</pubDate>
      <description>Not an official link.</description>
    </item>`;
  const items = parseFederalReserveRss(
    `<?xml version="1.0"?><rss><channel>${entries}${foreign}</channel></rss>`,
  );
  assert.equal(items.length, 8);
  assert.equal(
    items.every(({ url }) =>
      new URL(url).hostname === "www.federalreserve.gov"),
    true,
  );
  assert.equal(
    items.every(({ publisher }) =>
      publisher === "Board of Governors of the Federal Reserve System"),
    true,
  );
});

test("Federal Reserve RSS bounds ETF fan-out and hashes each cluster once", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const writes = [];
  const calls = [];
  const hashMaterials = [];
  const entries = Array.from({ length: 12 }, (_value, index) => `
    <item>
      <title>Federal Reserve issues FOMC monetary policy update ${index + 1}</title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary202607${String(index + 1).padStart(2, "0")}a.htm</link>
      <pubDate>Thu, 23 Jul 2026 0${index % 9}:00:00 GMT</pubDate>
      <description>Official economic developments and monetary policy evidence.</description>
    </item>`).join("");
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [
        { symbol: "SOXX" },
        { symbol: "SMH" },
        { symbol: "NVDA" },
        { symbol: "AMD" },
      ],
    },
    db: {},
    fetcher: async (url) => {
      calls.push(String(url));
      const body = new URL(url).hostname === "www.federalreserve.gov"
        ? `<?xml version="1.0"?><rss><channel>${entries}</channel></rss>`
        : '<?xml version="1.0"?><rss><channel></channel></rss>';
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    hashMaterial: async (material) => {
      hashMaterials.push(material);
      return hashMaterials.length.toString(16).padStart(64, "0");
    },
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 3);
  assert.equal(items.length, 16);
  assert.deepEqual(
    [...new Set(items.map(({ symbol }) => symbol))].sort(),
    ["SMH", "SOXX"],
  );
  assert.equal(items.every(({ sourceTier }) => sourceTier === "evidence"), true);
  assert.equal(items.every(({ quality }) => quality === "evidence"), true);
  assert.equal(
    hashMaterials.filter((material) => material.includes("\n")).length,
    16,
    "每个持久化目标仅计算一次新闻 ID",
  );
  assert.equal(
    hashMaterials.filter((material) => !material.includes("\n")).length,
    8,
    "每条来源新闻仅计算一次 cluster ID，不随 symbol 扇出重复",
  );
});

test("Federal Reserve filters non-macro releases and never blocks discovery fallbacks", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const fedRss = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Federal Reserve finalizes bank capital reporting rule</title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260723a.htm</link>
      <pubDate>Thu, 23 Jul 2026 09:00:00 GMT</pubDate>
      <description>Bank supervision and regulation release.</description>
    </item>
    <item>
      <title>Federal Reserve announces enforcement action</title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/enforcement20260723a.htm</link>
      <pubDate>Thu, 23 Jul 2026 08:00:00 GMT</pubDate>
      <description>Enforcement action against a banking organization.</description>
    </item>
    <item>
      <title>Federal Reserve issues FOMC statement</title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260723a.htm</link>
      <pubDate>Thu, 23 Jul 2026 07:00:00 GMT</pubDate>
      <description>The Committee discussed monetary policy and economic developments.</description>
    </item>
  </channel></rss>`;
  const yahooRss = `<?xml version="1.0"?><rss><channel><item>
    <title>NVIDIA semiconductor demand expands - Market Desk</title>
    <link>https://example.com/nvidia-demand</link>
    <pubDate>Thu, 23 Jul 2026 06:00:00 GMT</pubDate>
    <description>NVIDIA reports stronger semiconductor demand.</description>
    <source>Market Desk</source>
  </item></channel></rss>`;
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [
        { symbol: "SOXX" },
        { symbol: "SMH" },
        { symbol: "NVDA" },
      ],
    },
    db: {},
    fetcher: async (url) => {
      const value = new URL(url);
      calls.push(value);
      if (value.hostname === "www.federalreserve.gov") {
        return new Response(fedRss, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        });
      }
      if (value.hostname === "news.google.com") {
        return new Response("<rss><channel></channel></rss>", {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        });
      }
      return new Response(yahooRss, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  const fedItems = items.filter(({ source }) =>
    source === "Federal Reserve Board Press Releases");
  assert.equal(result.status, "completed");
  assert.equal(calls.some(({ hostname }) => hostname === "news.google.com"), true);
  assert.equal(
    calls.some(({ hostname }) => hostname === "feeds.finance.yahoo.com"),
    true,
  );
  assert.equal(fedItems.length, 2);
  assert.deepEqual(
    fedItems.map(({ symbol }) => symbol).sort(),
    ["SMH", "SOXX"],
  );
  assert.equal(
    fedItems.every(({ title }) => title.includes("FOMC statement")),
    true,
  );
  assert.equal(
    items.some(({ symbol, sourceTier }) =>
      symbol === "NVDA" && sourceTier === "discovery"),
    true,
  );
});

test("Federal Reserve macro evidence stays topic-level without a theme ETF target", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const writes = [];
  const rss = `<?xml version="1.0"?><rss><channel><item>
    <title>Federal Reserve publishes economic developments summary</title>
    <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260723a.htm</link>
    <pubDate>Thu, 23 Jul 2026 07:00:00 GMT</pubDate>
    <description>FOMC monetary policy and economic outlook.</description>
  </item></channel></rss>`;
  await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "NVDA" }],
    },
    db: {},
    fetcher: async (url) => new Response(
      new URL(url).hostname === "www.federalreserve.gov"
        ? rss
        : "<rss><channel></channel></rss>",
      {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      },
    ),
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].symbol, null);
  assert.equal(items[0].topic, "us-semiconductor");
});

test("Federal Reserve RSS response limit produces an evidence failure trace", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "NVDA" }],
    },
    db: {},
    fetcher: async (url) => {
      if (new URL(url).hostname === "www.federalreserve.gov") {
        return new Response("<rss><channel></channel></rss>", {
          status: 200,
          headers: {
            "content-type": "application/rss+xml",
            "content-length": "131073",
          },
        });
      }
      return new Response('<?xml version="1.0"?><rss><channel></channel></rss>', {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    },
    writeItems: async () => {},
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  assert.equal(result.status, "degraded");
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "federal-reserve-rss"
      && status === "failed"
      && reason === "NEWS_RESPONSE_TOO_LARGE"),
    true,
  );
});

test("SEC submissions requests use configured organization and contact without leaking it", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const requests = [];
  const configuredUserAgent = "Example Research sec-ops@example.com";
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "ORCL" }],
    },
    db: {},
    env: { SEC_USER_AGENT: configuredUserAgent },
    fetcher: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return new Response(SEC_SUBMISSIONS, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    writeItems: async () => {},
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url.toString(),
    "https://data.sec.gov/submissions/CIK0001341439.json",
  );
  assert.equal(
    requests[0].options.headers["user-agent"],
    configuredUserAgent,
  );
  assert.equal(JSON.stringify(result).includes(configuredUserAgent), false);
});

test("SEC requests identify TradingWorkbench with the configured contact email", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const requests = [];
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "ORCL" }],
    },
    db: {},
    env: { SEC_CONTACT_EMAIL: "sec-ops@example.com" },
    fetcher: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(SEC_SUBMISSIONS, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    writeItems: async () => {},
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].options.headers["user-agent"],
    "TradingWorkbench sec-ops@example.com",
  );
});

test("SEC skips requests without a compliant contact and continues discovery", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const requests = [];
  const writes = [];
  const discovery = `<?xml version="1.0"?><rss><channel><item>
    <title>Oracle cloud earnings update - Market Desk</title>
    <link>https://example.com/oracle-cloud-update</link>
    <pubDate>Thu, 23 Jul 2026 18:00:00 GMT</pubDate>
    <description>Oracle Cloud reports an earnings update.</description>
    <source>Market Desk</source>
  </item></channel></rss>`;
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "ORCL" }],
    },
    db: {},
    env: {
      SEC_USER_AGENT:
        "TradingWorkbench 115156322+gaaiyun@users.noreply.github.com",
      SEC_CONTACT_EMAIL:
        "115156322+gaaiyun@users.noreply.github.com",
    },
    fetcher: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(discovery, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  assert.equal(
    requests.some(({ url }) => new URL(url).hostname === "data.sec.gov"),
    false,
  );
  assert.equal(result.status, "degraded");
  assert.equal(result.written, 1);
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "sec-edgar-submissions"
      && status === "failed"
      && reason === "SEC_USER_AGENT_REQUIRED"),
    true,
  );
  assert.equal(writes.flatMap(({ items }) => items)[0].sourceTier, "discovery");
});

test("SEC 403 remains a failed source when discovery fallbacks are empty", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const contact = "private-sec-contact@example.com";
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "ORCL" }],
    },
    db: {},
    env: { SEC_CONTACT_EMAIL: contact },
    fetcher: async (url) => {
      if (new URL(url).hostname === "data.sec.gov") {
        return new Response("", { status: 403 });
      }
      return new Response('<?xml version="1.0"?><rss><channel></channel></rss>', {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    },
    writeItems: async () => {},
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.written, 0);
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "sec-edgar-submissions"
      && status === "failed"
      && reason === "NEWS_HTTP_403"),
    true,
  );
  assert.equal(JSON.stringify(result).includes(contact), false);
});

test("SEC HTTP 200 without a submissions envelope remains a failed source", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "GOOGL" }],
    },
    db: {},
    env: { SEC_USER_AGENT: "Example Research sec-ops@example.com" },
    fetcher: async (url) => (
      new URL(url).hostname === "data.sec.gov"
        ? new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
        : new Response('<?xml version="1.0"?><rss><channel></channel></rss>', {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        })
    ),
    writeItems: async () => {},
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  assert.equal(result.status, "degraded");
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "sec-edgar-submissions"
      && status === "failed"
      && reason === "NEWS_MALFORMED_RESPONSE"),
    true,
  );
});

test("SEC evidence failure keeps the run degraded when discovery still returns news", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const discovery = `<?xml version="1.0"?><rss><channel><item>
    <title>Oracle cloud demand expands after earnings - Reuters</title>
    <link>https://example.com/oracle-cloud</link>
    <pubDate>Thu, 23 Jul 2026 18:00:00 GMT</pubDate>
    <description>Oracle cloud infrastructure demand remains in focus.</description>
    <source url="https://www.reuters.com">Reuters</source>
  </item></channel></rss>`;
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "ORCL" }],
    },
    db: {},
    env: { SEC_USER_AGENT: "Example Research sec-ops@example.com" },
    fetcher: async (url) => (
      new URL(url).hostname === "data.sec.gov"
        ? new Response("", { status: 403 })
        : new Response(discovery, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        })
    ),
    writeItems: async () => {},
    now: new Date("2026-07-23T20:30:00.000Z"),
  });

  assert.equal(result.written, 1);
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "NEWS_COLLECTION_PARTIAL");
});

test("old SEC submissions do not short-circuit current discovery", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const oldSubmissions = JSON.parse(SEC_SUBMISSIONS);
  oldSubmissions.filings.recent.filingDate[0] = "2020-01-02";
  oldSubmissions.filings.recent.reportDate[0] = "2020-01-01";
  oldSubmissions.filings.recent.acceptanceDateTime[0] =
    "2020-01-02T20:13:46.000Z";
  const discovery = `<?xml version="1.0"?><rss><channel><item>
    <title>Oracle cloud earnings accelerate - Market Desk</title>
    <link>https://example.com/oracle-current-discovery</link>
    <pubDate>Thu, 23 Jul 2026 18:00:00 GMT</pubDate>
    <description>Oracle Cloud reports current AI demand and earnings growth.</description>
    <source>Market Desk</source>
  </item></channel></rss>`;
  const calls = [];
  const writes = [];
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "ORCL" }],
    },
    db: {},
    env: { SEC_USER_AGENT: "Example Research sec-ops@example.com" },
    fetcher: async (url) => {
      const value = new URL(url);
      calls.push(value);
      return value.hostname === "data.sec.gov"
        ? new Response(JSON.stringify(oldSubmissions), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
        : new Response(discovery, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(result.status, "completed");
  assert.equal(
    calls.some(({ hostname }) => hostname === "news.google.com"),
    true,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://example.com/oracle-current-discovery");
  assert.equal(items[0].sourceTier, "discovery");
});

test("Oracle and Alphabet prefer deduplicated SEC submissions evidence before discovery feeds", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const oracleSubmissions = JSON.parse(SEC_SUBMISSIONS);
  oracleSubmissions.filings.recent.form[1] = "8-K";
  oracleSubmissions.filings.recent.accessionNumber[1] =
    oracleSubmissions.filings.recent.accessionNumber[0];
  oracleSubmissions.filings.recent.primaryDocument[1] =
    oracleSubmissions.filings.recent.primaryDocument[0];
  const alphabetSubmissions = structuredClone(oracleSubmissions);
  alphabetSubmissions.cik = "1652044";
  alphabetSubmissions.name = "Alphabet Inc.";
  alphabetSubmissions.tickers = ["GOOGL"];
  alphabetSubmissions.filings.recent.primaryDocument =
    ["alphabet-index.htm", "alphabet-index.htm"];
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "ORCL" }, { symbol: "GOOGL" }],
    },
    db: {},
    env: { SEC_USER_AGENT: "Example Research sec-ops@example.com" },
    fetcher: async (url) => {
      const value = new URL(url);
      calls.push(value);
      const payload = value.pathname.endsWith("CIK0001341439.json")
        ? oracleSubmissions
        : alphabetSubmissions;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((url) => url.pathname.split("/").at(-1)).sort(),
    ["CIK0001341439.json", "CIK0001652044.json"],
  );
  assert.equal(calls.every((url) =>
    url.hostname === "data.sec.gov"
    && url.pathname.startsWith("/submissions/CIK")), true);
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
    items.some(({ source }) =>
      source === "SEC EDGAR Submissions / ORACLE CORP"),
    true,
  );
  assert.equal(
    items.some(({ source }) =>
      source === "SEC EDGAR Submissions / Alphabet Inc."),
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
      if (String(url).includes("group.hashkey.com")) {
        return new Response(
          'prefix \\"posts\\":{\\"posts\\":[],\\"metaData\\":{\\"count\\":0} suffix',
          {
          status: 200,
          headers: { "content-type": "text/html" },
          },
        );
      }
      if (String(url).includes("sec.gov")) {
        return new Response("<?xml version=\"1.0\"?><feed></feed>", {
          status: 200,
          headers: { "content-type": "application/atom+xml" },
        });
      }
      if (String(url).includes("/search-gov/data")) {
        return new Response(JSON.stringify({
          code: "200",
          searchVO: { catMap: null },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).includes("query.sse.com.cn")) {
        return new Response('TradingWorkbenchSse({"result":[]})', {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }
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
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "content-length": "1028172",
        },
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
    env: { SEC_USER_AGENT: "Example Research sec-ops@example.com" },
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
  assert.equal(result.status, "degraded");
  assert.equal(items.some(({ symbol }) => symbol === "GOOGL"), true);
  assert.equal(items.some(({ symbol }) => symbol === "3887.HK"), true);
  assert.equal(items.every(({ source }) => source.startsWith("Yahoo Finance RSS /")), true);
  assert.equal(items.every(({ sourceTier }) => sourceTier === "discovery"), true);
  assert.equal(calls.some((url) => url.includes("s=GOOGL")), true);
  assert.equal(calls.some((url) => url.includes("s=3887.HK")), true);
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "sec-edgar-submissions"
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

test("news collection uses bounded current government policy queries when Google is blocked", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const policyPayload = {
    code: "200",
    searchVO: {
      catMap: {
        bumenfile: {
          listVO: [
            {
              title: "工业和信息化部关于通信设备产业高质量发展的通知",
              url: "https://www.gov.cn/zhengce/zhengceku/202607/content_communication.htm",
              pubtimeStr: "2026.07.22",
              summary: "工业和信息化部发布通信设备产业政策通知。",
              puborg: "工业和信息化部",
            },
            {
              title: "工业和信息化部关于集成电路产业高质量发展的通知",
              url: "https://www.gov.cn/zhengce/zhengceku/202607/content_integrated_circuit.htm",
              pubtimeStr: "2026.07.21",
              summary: "工业和信息化部发布集成电路产业政策通知。",
              puborg: "工业和信息化部",
            },
          ],
        },
      },
    },
  };
  const result = await collectNewsForProfile({
    profile: monitorSettings().profiles[0],
    db: {},
    fetcher: async (url) => {
      calls.push(url);
      if (String(url).includes("news.google.com")) {
        return new Response("", { status: 403 });
      }
      if (String(url).includes("search-api-web.eastmoney.com")) {
        return new Response("", { status: 503 });
      }
      return new Response(JSON.stringify(policyPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T01:30:00.000Z"),
  });
  const items = writes.flatMap(({ items }) => items);
  assert.equal(result.status, "completed");
  assert.equal(
    calls.filter((url) =>
      new URL(url).pathname === "/search-gov/data").length,
    2,
    "通信与芯片主题各使用一个有界政策检索，policy 计划复用缓存",
  );
  const policyUrls = calls
    .map((url) => new URL(url))
    .filter(({ pathname }) => pathname === "/search-gov/data");
  assert.deepEqual(
    policyUrls.map((url) => url.searchParams.get("q")).sort(),
    ["通信", "集成电路"],
  );
  assert.equal(policyUrls.every((url) => url.searchParams.get("timetype") === "timeqb"), true);
  assert.equal(policyUrls.every((url) => url.searchParams.get("sort") === "pubtime"), true);
  assert.equal(policyUrls.every((url) => url.searchParams.get("searchfield") === "title"), true);
  assert.equal(policyUrls.every((url) => url.searchParams.get("p") === "1"), true);
  assert.equal(policyUrls.every((url) => url.searchParams.get("n") === "20"), true);
  assert.equal(
    items.some(({ source }) => source === "中国政府网政策文件库"),
    true,
  );
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "google-news-rss" &&
      status === "failed" &&
      reason === "NEWS_HTTP_403"),
    true,
  );
  assert.equal(
    result.sources.some(({ source, status }) =>
      source === "gov-policy-library" && status === "success"),
    true,
  );
});

test("government policy library bounds, dates and authority tiers", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const policyResult = ({ title, path, publishedAt, publisher = "工业和信息化部" }) => ({
    title,
    url: path,
    pubtimeStr: publishedAt,
    summary: "工业和信息化部发布半导体与集成电路政策通知。",
    puborg: publisher,
  });
  const foreignHost = policyResult({
    title: "部长调研半导体与集成电路产业",
    path: "https://example.com/not-official",
    publishedAt: "2026.07.24",
  });
  const futurePolicy = policyResult({
    title: "未来发布时间不应进入证据包",
    path: "https://www.gov.cn/zhengce/zhengceku/202607/content_future.htm",
    publishedAt: "2026.07.26",
  });
  const expiredPolicy = policyResult({
    title: "窗口外旧政策不应进入证据包",
    path: "https://www.gov.cn/zhengce/zhengceku/202606/content_expired.htm",
    publishedAt: "2026.06.20",
  });
  const policies = Array.from({ length: 12 }, (_value, index) => policyResult({
    title: `工业和信息化部关于半导体与集成电路产业的政策通知 ${index + 1}`,
    path: `https://www.gov.cn/zhengce/zhengceku/202607/content_policy_${index + 1}.htm`,
    publishedAt: `2026.07.${String(24 - index).padStart(2, "0")}`,
  }));
  const policyPayload = {
    code: "200",
    searchVO: {
      catMap: {
        bumenfile: { listVO: [foreignHost, futurePolicy, expiredPolicy, ...policies] },
        otherfile: { listVO: [policyResult({
          title: "集成电路政策解读",
          path: "https://www.gov.cn/zhengce/202607/content_explanation.htm",
          publishedAt: "2026.07.23",
          publisher: "中国政府网",
        })] },
      },
    },
  };
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "159995.SZ" }],
    },
    db: {},
    fetcher: async (url) => {
      calls.push(String(url));
      const pathname = new URL(url).pathname;
      if (pathname === "/search-gov/data") {
        return new Response(JSON.stringify(policyPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 503 });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-25T02:00:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(result.status, "completed");
  assert.equal(items.length, 8);
  assert.equal(items.every(({ url }) => url.includes("www.gov.cn/")), true);
  assert.equal(items.some(({ url }) => url.includes("example.com")), false);
  assert.equal(items.some(({ url }) => url.includes("future")), false);
  assert.equal(items.some(({ url }) => url.includes("expired")), false);
  assert.equal(items.filter(({ sourceTier }) => sourceTier === "discovery").length, 1);
  assert.equal(
    items.find(({ sourceTier }) => sourceTier === "discovery")?.source,
    "中国政府网政策解读",
  );
  assert.equal(items.filter(({ sourceTier }) => sourceTier === "evidence").length, 7);
  assert.equal(items[0].publishedAt, "2026-07-23T16:00:00.000Z");
  assert.equal(
    calls.filter((url) =>
      new URL(url).pathname === "/search-gov/data").length,
    1,
  );
});

test("government policy window follows the Shanghai calendar across the UTC date boundary", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "159995.SZ" }],
    },
    db: {},
    fetcher: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        code: "200",
        searchVO: { catMap: { bumenfile: { listVO: [
          {
            title: "工业和信息化部集成电路窗口内政策",
            url: "https://www.gov.cn/zhengce/zhengceku/202606/content_in_window.htm",
            pubtimeStr: "2026.06.25",
            summary: "集成电路产业政策",
            puborg: "工业和信息化部",
          },
          {
            title: "工业和信息化部集成电路窗口外政策",
            url: "https://www.gov.cn/zhengce/zhengceku/202606/content_outside_window.htm",
            pubtimeStr: "2026.06.24",
            summary: "集成电路产业政策",
            puborg: "工业和信息化部",
          },
        ] } } },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-24T16:30:00.000Z"),
  });
  const policy = calls.map((url) => new URL(url)).find(
    ({ pathname }) => pathname === "/search-gov/data",
  );
  assert.equal(policy.searchParams.get("q"), "集成电路");
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(items.some(({ url }) => url.includes("in_window")), true);
  assert.equal(items.some(({ url }) => url.includes("outside_window")), false);
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

test("A-share ETF news falls back to Eastmoney when Google News is blocked at the edge", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const policyPayload = {
    code: "200",
    searchVO: { catMap: { bumenfile: { listVO: [{
      title: "工业和信息化部关于集成电路产业高质量发展的通知",
      url: "https://www.gov.cn/zhengce/zhengceku/202607/content_chip_policy.htm",
      pubtimeStr: "2026.07.24",
      summary: "工业和信息化部发布集成电路产业政策通知。",
      puborg: "工业和信息化部电子信息司",
    }] } } },
  };
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "512480.SS" }],
    },
    db: {},
    fetcher: async (url) => {
      calls.push(String(url));
      if (String(url).includes("news.google.com")) {
        return new Response("", { status: 503 });
      }
      if (String(url).includes("search-api-web.eastmoney.com")) {
        return new Response(EASTMONEY_JSONP, {
          status: 200,
          headers: { "content-type": "text/javascript; charset=UTF-8" },
        });
      }
      if (String(url).includes("/search-gov/data")) {
        return new Response(JSON.stringify(policyPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).includes("query.sse.com.cn")) {
        return new Response('TradingWorkbenchSse({"result":[]})', {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }
      return new Response("", {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-25T05:00:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(result.status, "completed");
  assert.equal(items.length, 2);
  const discovery = items.find(({ sourceTier }) => sourceTier === "discovery");
  const evidence = items.find(({ sourceTier }) => sourceTier === "evidence");
  assert.equal(discovery.symbol, "512480.SS");
  assert.equal(discovery.source, "东方财富搜索 / 每日经济新闻");
  assert.equal(discovery.publisher, "每日经济新闻");
  assert.equal(discovery.freshness, "fresh");
  assert.equal(evidence.symbol, "512480.SS");
  assert.equal(evidence.source, "中国政府网政策文件库");
  assert.equal(evidence.publisher, "工业和信息化部电子信息司");
  assert.equal(
    calls.some((url) => url.includes("search-api-web.eastmoney.com")),
    true,
  );
  assert.equal(
    calls.some((url) => url.includes("/search-gov/data")),
    true,
    "发现层成功后仍应查询官方工信部证据层",
  );
  assert.equal(
    result.sources.some(({ source, status }) =>
      source === "eastmoney-search" && status === "success"),
    true,
  );
  assert.equal(
    result.sources.some(({ source, status }) =>
      source === "gov-policy-library" && status === "success"),
    true,
  );
});

test("government policy evidence failure remains degraded after Eastmoney discovery succeeds", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const writes = [];
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "512480.SS" }],
    },
    db: {},
    fetcher: async (url) => {
      if (String(url).includes("news.google.com")) {
        return new Response("", { status: 503 });
      }
      if (String(url).includes("search-api-web.eastmoney.com")) {
        return new Response(EASTMONEY_JSONP, {
          status: 200,
          headers: { "content-type": "text/javascript; charset=UTF-8" },
        });
      }
      return new Response("", { status: 503 });
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-25T05:00:00.000Z"),
  });
  assert.equal(result.status, "degraded");
  assert.equal(writes.flatMap(({ items }) => items).length, 1);
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "gov-policy-library"
      && status === "failed"
      && reason === "NEWS_HTTP_503"),
    true,
  );
});

test("government policy HTTP 200 with a malformed envelope remains degraded", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "512480.SS" }],
    },
    db: {},
    fetcher: async (url) => {
      if (String(url).includes("news.google.com")) {
        return new Response("", { status: 503 });
      }
      if (String(url).includes("search-api-web.eastmoney.com")) {
        return new Response(EASTMONEY_JSONP, {
          status: 200,
          headers: { "content-type": "text/javascript; charset=UTF-8" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    writeItems: async () => {},
    now: new Date("2026-07-25T05:00:00.000Z"),
  });
  assert.equal(result.status, "degraded");
  assert.equal(
    result.sources.some(({ source, status, reason }) =>
      source === "gov-policy-library"
      && status === "failed"
      && reason === "NEWS_MALFORMED_RESPONSE"),
    true,
  );
});

test("semiconductor policy news maps to both chip ETFs without polluting the communication ETF", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const writes = [];
  const rss = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>半导体行业政策支持集成电路设备升级</title>
      <link>https://example.com/semiconductor-policy</link>
      <pubDate>Sat, 25 Jul 2026 04:00:00 GMT</pubDate>
      <description>芯片产业和半导体设备迎来新的政策文件。</description>
      <source>工业主管部门</source>
    </item>
  </channel></rss>`;
  await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [
        { symbol: "515880.SS" },
        { symbol: "512480.SS" },
        { symbol: "159995.SZ" },
      ],
    },
    db: {},
    fetcher: async () => new Response(rss, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    }),
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-25T05:00:00.000Z"),
  });
  const symbols = new Set(
    writes.flatMap(({ items }) => items).map(({ symbol }) => symbol),
  );
  assert.deepEqual([...symbols].sort(), ["159995.SZ", "512480.SS"]);
});
