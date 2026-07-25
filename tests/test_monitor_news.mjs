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
      <title>Federal Reserve semiconductor policy update ${index + 1}</title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary202607${String(index + 1).padStart(2, "0")}a.htm</link>
      <pubDate>Thu, 23 Jul 2026 0${index % 9}:00:00 GMT</pubDate>
      <description>Official monetary policy evidence for the semiconductor sector.</description>
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

test("Federal Reserve RSS is a bounded evidence source for configured US drivers", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const writes = [];
  const calls = [];
  const entries = Array.from({ length: 12 }, (_value, index) => `
    <item>
      <title>Federal Reserve semiconductor policy update ${index + 1}</title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary202607${String(index + 1).padStart(2, "0")}a.htm</link>
      <pubDate>Thu, 23 Jul 2026 0${index % 9}:00:00 GMT</pubDate>
      <description>Official monetary policy evidence for the semiconductor sector.</description>
    </item>`).join("");
  const result = await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "NVDA" }],
    },
    db: {},
    fetcher: async (url) => {
      calls.push(String(url));
      return new Response(
        `<?xml version="1.0"?><rss><channel>${entries}</channel></rss>`,
        {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        },
      );
    },
    writeItems: async (_db, payload) => writes.push(payload),
    now: new Date("2026-07-23T20:30:00.000Z"),
  });
  const items = writes.flatMap(({ items: rows }) => rows);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(items.length, 8);
  assert.equal(items.every(({ symbol }) => symbol === "NVDA"), true);
  assert.equal(items.every(({ sourceTier }) => sourceTier === "evidence"), true);
  assert.equal(items.every(({ quality }) => quality === "evidence"), true);
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

test("SEC requests use the project contact when no email is configured", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const requests = [];
  await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "ORCL" }],
    },
    db: {},
    env: {},
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
  assert.equal(
    requests[0].options.headers["user-agent"],
    "TradingWorkbench 115156322+gaaiyun@users.noreply.github.com",
  );
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
      if (String(url).includes("search-front-server/api/search/info")) {
        return new Response(JSON.stringify({
          data: { searchResult: { dataResults: [] } },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
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

test("news collection uses bounded current MIIT policy queries when Google is blocked", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const miitPayload = {
    data: {
      searchResult: {
        dataResults: [{
          groupData: [{
            data: {
              title: "工业和信息化部关于通信设备产业高质量发展的通知",
              url: "/zwgk/zcwj/wjfb/tz/art/2026/art_communications.html",
              deploytime: String(Date.parse("2026-07-22T01:00:00.000Z")),
              infocontent: "工业和信息化部发布通信设备产业政策通知。",
              columnname: "通知",
              columnid: "3e3ad1a3bec74939890a0d3e54815141",
              publishgroupname: "信息通信发展司",
            },
          }],
        }],
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
      return new Response(JSON.stringify(miitPayload), {
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
      new URL(url).pathname === "/search-front-server/api/search/info").length,
    2,
    "通信与芯片主题各使用一个有界政策检索，policy 计划复用缓存",
  );
  const miitUrls = calls
    .map((url) => new URL(url))
    .filter(({ pathname }) => pathname === "/search-front-server/api/search/info");
  assert.deepEqual(
    miitUrls.map((url) => url.searchParams.get("q")).sort(),
    ["芯片", "通信"],
  );
  assert.equal(miitUrls.every((url) => url.searchParams.get("cateid") === "58"), true);
  assert.equal(miitUrls.every((url) => url.searchParams.get("pg") === "10"), true);
  assert.equal(miitUrls.every((url) => url.searchParams.get("p") === "1"), true);
  assert.equal(
    miitUrls.every((url) => url.searchParams.get("begin") === "2026-06-23"),
    true,
  );
  assert.equal(
    miitUrls.every((url) => url.searchParams.get("end") === "2026-07-23"),
    true,
  );
  assert.equal(
    items.some(({ source }) => source === "工业和信息化部政策文件库"),
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
      source === "miit-policy-api" && status === "success"),
    true,
  );
});

test("MIIT policy API bounds parsed items and excludes leadership activity noise", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  const writes = [];
  const miitResult = ({ title, path, publishedAt, columnname, columnid }) => ({
    groupData: [{
      data: {
        title,
        url: path,
        deploytime: String(publishedAt),
        infocontent: "工业和信息化部发布半导体与集成电路政策通知。",
        columnname,
        columnid,
        publishgroupname: "电子信息司",
      },
    }],
  });
  const leadership = miitResult({
    title: "部长调研半导体与集成电路产业",
    path: "/xwfb/bldhd/art/2026/art_leadership.html",
    publishedAt: Date.parse("2026-07-25T01:00:00.000Z"),
    columnname: "部领导活动",
    columnid: "d3e2bede1bc045e2875fc7161c01db7d",
  });
  const futurePolicy = miitResult({
    title: "未来发布时间不应进入证据包",
    path: "/zwgk/zcwj/wjfb/art/2026/art_future.html",
    publishedAt: Date.parse("2026-07-25T10:00:00.000Z"),
    columnname: "通知",
    columnid: "3e3ad1a3bec74939890a0d3e54815141",
  });
  const expiredPolicy = miitResult({
    title: "窗口外旧政策不应进入证据包",
    path: "/zwgk/zcwj/wjfb/art/2026/art_expired.html",
    publishedAt: Date.parse("2026-06-20T01:00:00.000Z"),
    columnname: "通知",
    columnid: "3e3ad1a3bec74939890a0d3e54815141",
  });
  const policies = Array.from({ length: 12 }, (_value, index) => miitResult({
    title: `工业和信息化部关于半导体与集成电路产业的政策通知 ${index + 1}`,
    path: `/zwgk/zcwj/wjfb/art/2026/art_policy_${index + 1}.html`,
    publishedAt: Date.parse(`2026-07-${String(24 - index).padStart(2, "0")}T01:00:00.000Z`),
    columnname: "通知",
    columnid: "3e3ad1a3bec74939890a0d3e54815141",
  }));
  const miitPayload = {
    data: {
      searchResult: {
        dataResults: [leadership, futurePolicy, expiredPolicy, ...policies],
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
      if (pathname === "/search-front-server/api/search/info") {
        return new Response(JSON.stringify(miitPayload), {
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
  assert.equal(items.every(({ url }) => url.includes("/zwgk/zcwj/")), true);
  assert.equal(items.some(({ url }) => url.includes("/bldhd/")), false);
  assert.equal(items.some(({ url }) => url.includes("future")), false);
  assert.equal(items.some(({ url }) => url.includes("expired")), false);
  assert.equal(items.every(({ sourceTier }) => sourceTier === "evidence"), true);
  assert.equal(items[0].publishedAt, "2026-07-24T01:00:00.000Z");
  assert.equal(
    calls.filter((url) =>
      new URL(url).pathname === "/search-front-server/api/search/info").length,
    1,
  );
});

test("MIIT search window follows the Shanghai calendar across the UTC date boundary", async () => {
  const { collectNewsForProfile } = await import(newsUrl);
  const calls = [];
  await collectNewsForProfile({
    profile: {
      ...monitorSettings().profiles[0],
      targets: [{ symbol: "159995.SZ" }],
    },
    db: {},
    fetcher: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        data: { searchResult: { dataResults: [] } },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    writeItems: async () => {},
    now: new Date("2026-07-24T16:30:00.000Z"),
  });
  const miit = calls.map((url) => new URL(url)).find(
    ({ pathname }) => pathname === "/search-front-server/api/search/info",
  );
  assert.equal(miit.searchParams.get("begin"), "2026-06-25");
  assert.equal(miit.searchParams.get("end"), "2026-07-25");
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
  const miitPayload = {
    data: {
      searchResult: {
        dataResults: [{
          groupData: [{
            data: {
              title: "工业和信息化部关于芯片产业高质量发展的通知",
              url: "/zwgk/zcwj/wjfb/tz/art/2026/art_chip_policy.html",
              deploytime: String(Date.parse("2026-07-24T01:00:00.000Z")),
              infocontent: "工业和信息化部发布芯片产业政策通知。",
              columnname: "通知",
              columnid: "3e3ad1a3bec74939890a0d3e54815141",
              publishgroupname: "电子信息司",
            },
          }],
        }],
      },
    },
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
      if (String(url).includes("search-front-server/api/search/info")) {
        return new Response(JSON.stringify(miitPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
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
  assert.equal(evidence.source, "工业和信息化部政策文件库");
  assert.equal(evidence.publisher, "电子信息司");
  assert.equal(
    calls.some((url) => url.includes("search-api-web.eastmoney.com")),
    true,
  );
  assert.equal(
    calls.some((url) => url.includes("search-front-server/api/search/info")),
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
      source === "miit-policy-api" && status === "success"),
    true,
  );
});

test("MIIT evidence failure remains degraded after Eastmoney discovery succeeds", async () => {
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
      source === "miit-policy-api"
      && status === "failed"
      && reason === "NEWS_HTTP_503"),
    true,
  );
});

test("MIIT HTTP 200 with a malformed envelope remains degraded", async () => {
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
      source === "miit-policy-api"
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
