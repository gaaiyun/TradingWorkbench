const DAY_MS = 24 * 60 * 60 * 1000;
const RSS_LIMIT_PER_QUERY = 8;
const RSS_SCAN_LIMIT = 32;
const SEC_SCAN_LIMIT = 200;
const DEFAULT_RESPONSE_LIMIT_BYTES = 256 * 1024;
const SEC_RESPONSE_LIMIT_BYTES = 512 * 1024;
const FED_RSS_RESPONSE_LIMIT_BYTES = 128 * 1024;
const HASHKEY_RESPONSE_LIMIT_BYTES = 1100 * 1024;
const GOV_POLICY_LIBRARY_URL = "https://sousuo.www.gov.cn/search-gov/data";
const SSE_FUND_ANNOUNCEMENT_URL =
  "https://query.sse.com.cn/search/getESSearchDoc.do";
const GOV_POLICY_CATEGORIES = Object.freeze({
  bumenfile: "evidence",
  gongwen: "evidence",
  gongbao: "evidence",
  otherfile: "discovery",
});
const HASHKEY_IR_URL = "https://group.hashkey.com/category/blog/news/feed/";
const FEDERAL_RESERVE_RSS_URL =
  "https://www.federalreserve.gov/feeds/press_all.xml";
const SEC_EDGAR_CIK = {
  ORCL: "0001341439",
  GOOGL: "0001652044",
};
const EVIDENCE_PROVIDERS = new Set([
  "gov-policy-library",
  "sse-fund-announcements",
  "hashkey-ir",
  "federal-reserve-rss",
  "sec-edgar-submissions",
  "sec-edgar-8k",
]);
export const ACTIVE_NEWS_PROVIDERS = Object.freeze([
  "eastmoney-search",
  "federal-reserve-rss",
  "google-news-rss",
  "gov-policy-library",
  "hashkey-ir",
  "sec-edgar-submissions",
  "yahoo-finance-rss",
]);
const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const TARGET_ALIASES = {
  "515880.SS": ["通信ETF", "通信 ETF", "光模块", "光通信", "通信设备", "5G", "6G"],
  "512480.SS": ["半导体ETF", "半导体 ETF", "半导体设备", "芯片产业", "集成电路"],
  "159995.SZ": ["芯片ETF", "芯片 ETF", "半导体ETF", "半导体 ETF", "芯片产业", "集成电路"],
  SOXX: ["iShares Semiconductor ETF", "SOXX ETF"],
  SMH: ["VanEck Semiconductor ETF", "VanEck Semiconductor"],
  NVDA: ["NVIDIA", "英伟达"],
  TSM: ["TSMC", "台积电"],
  AVGO: ["Broadcom", "博通"],
  AMD: ["Advanced Micro Devices", "AMD"],
  ASML: ["ASML"],
  ORCL: ["Oracle", "甲骨文", "Oracle Cloud"],
  GOOGL: ["Alphabet", "Google LLC", "Google Cloud", "谷歌", "GOOGL"],
  "3887.HK": [
    "HashKey Holdings",
    "HashKey Group",
    "HashKey Exchange",
    "HASHKEY HLDGS",
    "03887",
    "3887.HK",
  ],
};
const COMMUNICATIONS_TITLE =
  /(通信ETF|光模块|光通信|通信设备|5G|6G)/i;
const SEMICONDUCTOR_TITLE =
  /(半导体ETF|芯片ETF|半导体|芯片|集成电路)/i;
const POLICY_AUTHORITY =
  /(国务院|国家发展改革委|工信部|工业和信息化部|证监会|财政部(?!长))/i;
const POLICY_ACTION =
  /(发布|印发|通知|意见|办法|规划|公告|决定|征求意见|答记者问|政策)/i;

function decodeEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, number) =>
      String.fromCodePoint(Number.parseInt(number, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function cleanText(value, limit = 500) {
  return decodeEntities(value)
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6])(?:\s[^>]*)?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function tagValue(item, tag) {
  const match = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  ).exec(item);
  return match?.[1] ?? "";
}

function parseRssItems(xml, maxItems = RSS_LIMIT_PER_QUERY) {
  const items = [];
  let scanned = 0;
  for (const match of String(xml || "").matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    if (items.length >= maxItems || scanned >= RSS_SCAN_LIMIT) break;
    scanned += 1;
    const body = match[1];
    const title = cleanText(tagValue(body, "title"), 300);
    const url = cleanText(tagValue(body, "link"), 2000);
    const published = new Date(cleanText(tagValue(body, "pubDate"), 100));
    if (!title || !/^https?:\/\//i.test(url) || !Number.isFinite(published.valueOf())) {
      continue;
    }
    items.push({
      title,
      url,
      publishedAt: published.toISOString(),
      summary: cleanText(tagValue(body, "description"), 500),
      publisher: cleanText(tagValue(body, "source"), 120) || "未知发布者",
    });
  }
  return items;
}

export function parseGoogleNewsRss(xml) {
  return parseRssItems(xml);
}

export function parseEastmoneySearch(jsonp) {
  const source = String(jsonp || "").trim();
  const match = /^[^(]*\(([\s\S]*)\)\s*;?$/.exec(source);
  if (!match) return [];
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const rows = payload?.result?.cmsArticleWebOld;
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, RSS_LIMIT_PER_QUERY).flatMap((row) => {
    const title = cleanText(row?.title, 300);
    const summary = cleanText(row?.content, 500);
    const publisher = cleanText(row?.mediaName, 120) || "未知发布者";
    const sourceTime = String(row?.date || "").trim().replace(" ", "T");
    const published = new Date(`${sourceTime}+08:00`);
    let url;
    try {
      const parsed = new URL(String(row?.url || ""));
      if (!["http:", "https:"].includes(parsed.protocol)) return [];
      if (parsed.protocol === "http:") parsed.protocol = "https:";
      url = parsed.toString();
    } catch {
      return [];
    }
    if (!title || !Number.isFinite(published.valueOf())) return [];
    return [{
      title,
      url,
      publishedAt: published.toISOString(),
      summary,
      publisher,
    }];
  });
}

function shanghaiDate(value) {
  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function parseGovPolicyLibrary(payload, {
  begin = null,
  end = null,
  now = null,
} = {}) {
  let response;
  try {
    response = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return [];
  }
  const categoryMap = response?.searchVO?.catMap;
  if (!categoryMap || typeof categoryMap !== "object") return [];
  const items = [];
  for (const [category, sourceTier] of Object.entries(GOV_POLICY_CATEGORIES)) {
    const rows = categoryMap?.[category]?.listVO;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const title = cleanText(row?.title, 300);
      const summary = cleanText(
        [row?.pcode || row?.fwzh, row?.summary].filter(Boolean).join(" "),
        500,
      );
      const dateText = String(row?.pubtimeStr || "").trim().replace(/\./g, "-");
      const published = /^\d{4}-\d{2}-\d{2}$/.test(dateText)
        ? new Date(`${dateText}T00:00:00+08:00`)
        : new Date(Number(row?.pubtime));
      let url;
      try {
        url = new URL(String(row?.url || ""));
        if (url.hostname !== "www.gov.cn") continue;
        if (!url.pathname.startsWith("/zhengce/") && !url.pathname.startsWith("/gongbao/")) {
          continue;
        }
        url.protocol = "https:";
      } catch {
        continue;
      }
      if (!title || !Number.isFinite(published.valueOf())) continue;
      const publishedDate = shanghaiDate(published);
      if (
        (now && published.valueOf() > now.valueOf())
        || (begin && publishedDate < begin)
        || (end && publishedDate > end)
      ) continue;
      items.push({
        title,
        url: url.toString(),
        publishedAt: published.toISOString(),
        summary,
        publisher: cleanText(row?.puborg, 120) || "中国政府网",
        _sourceTier: sourceTier,
        _policyCategory: category,
      });
    }
  }
  return items
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .slice(0, RSS_LIMIT_PER_QUERY);
}

export function parseSseFundAnnouncements(payload, symbol, {
  begin = null,
  end = null,
  now = null,
  targetSymbol = symbol,
} = {}) {
  const source = String(payload || "").trim();
  const match = /^TradingWorkbenchSse\((\{[\s\S]*\})\)\s*;?$/.exec(source);
  if (!match) return [];
  let response;
  try {
    response = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const legacyRows = Array.isArray(response?.result) ? response.result : null;
  const searchRows = Array.isArray(response?.data?.knowledgeList)
    ? response.data.knowledgeList
    : null;
  const rows = legacyRows || searchRows || [];
  const items = [];
  for (const row of rows) {
    if (items.length >= RSS_LIMIT_PER_QUERY) break;
    const extension = Object.fromEntries(
      (Array.isArray(row?.extend) ? row.extend : [])
        .filter(({ name }) => typeof name === "string")
        .map(({ name, value }) => [name, value]),
    );
    const rawPath = String(row?.URL || extension.CURL || "");
    if (
      (legacyRows && String(row?.SECURITY_CODE || "") !== symbol)
      || (searchRows && !new RegExp(`/${symbol}_[^/]+\\.pdf$`, "i").test(rawPath))
    ) continue;
    const title = cleanText(row?.TITLE || row?.title, 300);
    const dateText = String(row?.SSEDATE || row?.createTime || "")
      .trim()
      .slice(0, 10);
    const published = /^\d{4}-\d{2}-\d{2}$/.test(dateText)
      ? new Date(`${dateText}T00:00:00+08:00`)
      : new Date(Number.NaN);
    let url;
    try {
      url = new URL(rawPath, "https://www.sse.com.cn");
      if (url.hostname !== "www.sse.com.cn") continue;
      if (!url.pathname.startsWith("/disclosure/fund/announcement/")) continue;
      url.protocol = "https:";
    } catch {
      continue;
    }
    if (!title || !Number.isFinite(published.valueOf())) continue;
    const publishedDate = shanghaiDate(published);
    if (
      (now && published.valueOf() > now.valueOf())
      || (begin && publishedDate < begin)
      || (end && publishedDate > end)
    ) continue;
    items.push({
      title,
      url: url.toString(),
      publishedAt: published.toISOString(),
      summary: cleanText(
        [row?.BULLETIN_TYPE, row?.TITLE || row?.title].filter(Boolean).join(" · "),
        500,
      ),
      publisher: "上海证券交易所",
      _topicSymbols: [targetSymbol],
    });
  }
  return items;
}

function atomTagValue(item, tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const qualified = `(?:[A-Za-z_][\\w.-]*:)?${escaped}`;
  const match = new RegExp(
    `<${qualified}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${qualified}\\s*>`,
    "i",
  ).exec(item);
  return match?.[1] ?? "";
}

function attributeValue(attributes, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
    "i",
  ).exec(attributes);
  return decodeEntities(match?.[2] ?? "");
}

function atomAttributeValue(item, tag, attribute) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b([^>]*)\\/?>`,
    "i",
  ).exec(item);
  return attributeValue(match?.[1] ?? "", attribute);
}

function secFilingUrl(entry) {
  const contentUrl = cleanText(atomTagValue(entry, "filing-href"), 2000);
  const candidates = [];
  if (contentUrl) candidates.push(contentUrl);
  for (const match of entry.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?link\b([^>]*)\/?>/gi,
  )) {
    const href = attributeValue(match[1], "href");
    const rel = attributeValue(match[1], "rel");
    if (href && (!rel || rel.toLocaleLowerCase() === "alternate")) {
      candidates.push(href);
    }
  }
  return candidates.find((candidate) => {
    try {
      const url = new URL(candidate);
      return url.protocol === "https:"
        && ["sec.gov", "www.sec.gov"].includes(url.hostname.toLocaleLowerCase())
        && /^\/Archives\/edgar\/data\//i.test(url.pathname);
    } catch {
      return false;
    }
  }) || "";
}

export function parseSecEdgarAtom(xml, fallbackPublisher = "SEC EDGAR") {
  const value = String(xml || "");
  const publisher = cleanText(atomTagValue(value, "conformed-name"), 120)
    || cleanText(fallbackPublisher, 120)
    || "SEC EDGAR";
  const items = [];
  for (const match of value.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?entry(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?entry\s*>/gi,
  )) {
    const body = match[1];
    const filingType = cleanText(atomTagValue(body, "filing-type"), 30)
      || cleanText(atomAttributeValue(body, "category", "term"), 30);
    if (!/^8-K(?:\/A)?$/i.test(filingType)) continue;
    const filingTitle = cleanText(atomTagValue(body, "title"), 250);
    const url = secFilingUrl(body);
    const sourceTime = cleanText(atomTagValue(body, "updated"), 100)
      || cleanText(atomTagValue(body, "filing-date"), 30);
    const published = new Date(sourceTime);
    if (!filingTitle || !url || !Number.isFinite(published.valueOf())) continue;
    items.push({
      title: `${publisher} — ${filingTitle}`,
      url,
      publishedAt: published.toISOString(),
      summary: cleanText(atomTagValue(body, "summary"), 500),
      publisher,
    });
  }
  return items;
}

function secSubmissionDate(acceptedAt, filingDate) {
  const accepted = new Date(String(acceptedAt || ""));
  if (Number.isFinite(accepted.valueOf())) return accepted;
  return new Date(`${String(filingDate || "")}T00:00:00.000Z`);
}

export function parseSecEdgarSubmissions(
  payload,
  fallbackPublisher = "SEC EDGAR",
  { since = null, now = null } = {},
) {
  let response;
  try {
    response = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return [];
  }
  const recent = response?.filings?.recent;
  const forms = recent?.form;
  if (!recent || !Array.isArray(forms)) return [];
  const cik = String(response?.cik || "").replace(/^0+/, "");
  const publisher = cleanText(response?.name, 120)
    || cleanText(fallbackPublisher, 120)
    || "SEC EDGAR";
  if (!/^\d+$/.test(cik)) return [];
  const items = [];
  const scanLimit = Math.min(forms.length, SEC_SCAN_LIMIT);
  for (let index = 0; index < scanLimit; index += 1) {
    if (items.length >= RSS_LIMIT_PER_QUERY) break;
    const form = cleanText(forms[index], 30);
    if (!/^8-K(?:\/A)?$/i.test(form)) continue;
    const accessionNumber = String(
      recent.accessionNumber?.[index] || "",
    ).trim();
    const primaryDocument = String(
      recent.primaryDocument?.[index] || "",
    ).trim();
    if (
      !/^\d{10}-\d{2}-\d{6}$/.test(accessionNumber)
      || !/^[A-Za-z0-9._-]{1,255}$/.test(primaryDocument)
    ) {
      continue;
    }
    const filingDate = String(recent.filingDate?.[index] || "").trim();
    const published = secSubmissionDate(
      recent.acceptanceDateTime?.[index],
      filingDate,
    );
    if (!Number.isFinite(published.valueOf())) continue;
    if (
      (since && published.valueOf() < since.valueOf())
      || (now && published.valueOf() > now.valueOf())
    ) {
      continue;
    }
    const description = cleanText(
      recent.primaryDocDescription?.[index],
      180,
    ) || "Current report";
    const reportDate = String(recent.reportDate?.[index] || "").trim();
    const filingItems = cleanText(recent.items?.[index], 120);
    const summary = [
      filingDate ? `Filed: ${filingDate}` : "",
      reportDate ? `report period: ${reportDate}` : "",
      filingItems ? `items: ${filingItems}` : "",
    ].filter(Boolean).join("; ");
    items.push({
      title: `${publisher} — ${form} - ${description}`,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNumber.replaceAll("-", "")}/${primaryDocument}`,
      publishedAt: published.toISOString(),
      summary,
      publisher,
    });
  }
  return items;
}

export function parseFederalReserveRss(xml) {
  return parseRssItems(xml, RSS_SCAN_LIMIT).flatMap((item) => {
    try {
      const url = new URL(item.url);
      if (
        url.protocol !== "https:"
        || !["federalreserve.gov", "www.federalreserve.gov"].includes(
          url.hostname.toLocaleLowerCase(),
        )
        || !url.pathname.startsWith("/newsevents/pressreleases/")
      ) {
        return [];
      }
      const material = `${item.title} ${item.summary}`;
      if (
        /\b(?:enforcement action|civil money penalty|bank capital|banking regulation|supervision and regulation|consent order|finalizes? (?:a )?rule)\b/i
          .test(material)
        || !/\b(?:FOMC|Federal Open Market Committee|monetary policy|economic developments?|economic outlook|economic activity|Beige Book|federal funds rate)\b/i
          .test(material)
      ) {
        return [];
      }
      return [{
        ...item,
        publisher: "Board of Governors of the Federal Reserve System",
      }];
    } catch {
      return [];
    }
  }).slice(0, RSS_LIMIT_PER_QUERY);
}

export function parseHashKeyFeedPage(html) {
  const value = String(html || "");
  if (/<rss(?:\s[^>]*)?>/i.test(value) && /<channel(?:\s[^>]*)?>/i.test(value)) {
    return parseRssItems(value, RSS_SCAN_LIMIT).flatMap((item) => {
      try {
        const url = new URL(item.url);
        if (
          url.protocol !== "https:"
          || url.hostname.toLocaleLowerCase() !== "group.hashkey.com"
        ) {
          return [];
        }
        return [{ ...item, publisher: "HashKey Holdings" }];
      } catch {
        return [];
      }
    }).slice(0, RSS_LIMIT_PER_QUERY);
  }
  const marker = '\\"posts\\":{\\"posts\\":';
  const start = value.indexOf(marker);
  if (start < 0) return [];
  const bodyStart = start + marker.length;
  const bodyEnd = value.indexOf('],\\"metaData\\":', bodyStart);
  if (bodyEnd < bodyStart) return [];
  try {
    const encodedPosts = value.slice(bodyStart, bodyEnd + 1);
    const posts = JSON.parse(JSON.parse(`"${encodedPosts}"`));
    if (!Array.isArray(posts)) return [];
    return posts.slice(0, RSS_LIMIT_PER_QUERY).flatMap((post) => {
      const title = cleanText(post?.title, 300);
      const summary = cleanText(post?.excerpt, 500);
      const published = new Date(post?.firstPublishedDate || "");
      let url;
      try {
        const base = String(post?.url?.base || HASHKEY_IR_URL).replace(/\/+$/, "");
        const path = String(post?.url?.path || "").replace(/^\/?/, "/");
        url = new URL(`${base}${path}`).toString();
      } catch {
        return [];
      }
      if (
        !title
        || !Number.isFinite(published.valueOf())
        || new URL(url).hostname !== "group.hashkey.com"
      ) {
        return [];
      }
      return [{
        title,
        url,
        publishedAt: published.toISOString(),
        summary,
        publisher: "HashKey Holdings",
      }];
    });
  } catch {
    return [];
  }
}

function availableSymbols(profile, symbols) {
  const configured = new Set(
    (Array.isArray(profile?.targets) ? profile.targets : []).map(({ symbol }) => symbol),
  );
  return symbols.filter((symbol) => configured.has(symbol));
}

function queryPlans(profile) {
  const plans = [];
  const communication = availableSymbols(profile, ["515880.SS"]);
  if (communication.length) {
    plans.push({
      topic: "communications",
      symbols: communication,
      query: '("通信ETF" OR 光模块 OR 光通信 OR 通信设备 OR 5G OR 6G) when:7d',
      eastmoneyKeyword: "通信ETF",
      locale: "zh-CN",
    });
  }
  const cnSemiconductor = availableSymbols(profile, ["512480.SS", "159995.SZ"]);
  if (cnSemiconductor.length) {
    plans.push({
      topic: "cn-semiconductor",
      symbols: cnSemiconductor,
      query: '("半导体ETF" OR "芯片ETF" OR 半导体设备 OR 芯片产业 OR 集成电路) when:7d',
      eastmoneyKeyword: "半导体ETF",
      locale: "zh-CN",
    });
  }
  const usSemiconductor = availableSymbols(
    profile,
    ["SOXX", "SMH", "NVDA", "TSM", "AVGO", "AMD", "ASML"],
  );
  if (usSemiconductor.length) {
    plans.push({
      topic: "us-semiconductor",
      symbols: usSemiconductor,
      query: '("iShares Semiconductor ETF" OR "VanEck Semiconductor ETF" OR NVIDIA OR TSMC OR Broadcom OR "Advanced Micro Devices" OR ASML) semiconductor when:7d',
      locale: "en-US",
    });
  }
  const oracle = availableSymbols(profile, ["ORCL"]);
  if (oracle.length) {
    plans.push({
      topic: "oracle",
      symbols: oracle,
      query: '(Oracle OR "Oracle Cloud" OR 甲骨文) (cloud OR AI OR earnings) when:7d',
      locale: "en-US",
    });
  }
  const alphabet = availableSymbols(profile, ["GOOGL"]);
  if (alphabet.length) {
    plans.push({
      topic: "alphabet",
      symbols: alphabet,
      query: '(Alphabet OR "Google Cloud" OR GOOGL OR 谷歌) (cloud OR AI OR earnings) when:7d',
      locale: "en-US",
    });
  }
  const hashkey = availableSymbols(profile, ["3887.HK"]);
  if (hashkey.length) {
    plans.push({
      topic: "hashkey",
      symbols: hashkey,
      query: '("HashKey Holdings" OR "HashKey Group" OR "HashKey Exchange" OR 03887) (regulation OR exchange OR crypto OR earnings) when:30d',
      locale: "en-US",
    });
  }
  const policy = availableSymbols(profile, ["515880.SS", "512480.SS", "159995.SZ"]);
  if (policy.length) {
    plans.push({
      topic: "policy",
      symbols: policy,
      query: "site:miit.gov.cn (半导体 OR 芯片 OR 通信 OR 光模块) when:30d",
      eastmoneyKeyword: "半导体 通信 政策",
      locale: "zh-CN",
    });
  }
  return plans;
}

function rssUrl(plan) {
  const chinese = plan.locale === "zh-CN";
  const parameters = new URLSearchParams({
    q: plan.query,
    hl: chinese ? "zh-CN" : "en-US",
    gl: chinese ? "CN" : "US",
    ceid: chinese ? "CN:zh-Hans" : "US:en",
  });
  return `https://news.google.com/rss/search?${parameters}`;
}

function yahooRssUrl(symbol) {
  const parameters = new URLSearchParams({
    s: symbol,
    region: "US",
    lang: "en-US",
  });
  return `https://feeds.finance.yahoo.com/rss/2.0/headline?${parameters}`;
}

function eastmoneySearchUrl(keyword) {
  const payload = {
    uid: "",
    keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: {
        searchScope: "default",
        sort: "time",
        pageIndex: 1,
        pageSize: 20,
        preTag: "",
        postTag: "",
      },
    },
  };
  const parameters = new URLSearchParams({
    cb: "TradingWorkbenchNews",
    param: JSON.stringify(payload),
  });
  return `https://search-api-web.eastmoney.com/search/jsonp?${parameters}`;
}

function secEdgarSubmissionsUrl(symbol) {
  return `https://data.sec.gov/submissions/CIK${SEC_EDGAR_CIK[symbol]}.json`;
}

function govPolicySearchUrl(plan, now) {
  const chipSymbols = ["512480.SS", "159995.SZ"];
  const query = plan.topic === "communications"
    ? "通信"
    : plan.symbols.some((symbol) => chipSymbols.includes(symbol))
      ? "集成电路"
      : "通信";
  const window = {
    begin: shanghaiDate(new Date(now.valueOf() - 30 * DAY_MS)),
    end: shanghaiDate(now),
  };
  const parameters = new URLSearchParams({
    t: "zhengcelibrary",
    q: query,
    timetype: "timeqb",
    sort: "pubtime",
    sortType: "1",
    searchfield: "title",
    p: "1",
    n: "20",
    type: "gwyzcwjk",
  });
  return {
    url: `${GOV_POLICY_LIBRARY_URL}?${parameters}`,
    window,
  };
}

function sseFundAnnouncementUrl(symbol, now) {
  const window = {
    begin: shanghaiDate(new Date(now.valueOf() - 30 * DAY_MS)),
    end: shanghaiDate(now),
  };
  const parameters = new URLSearchParams({
    jsonCallBack: "TradingWorkbenchSse",
    keyword: symbol,
    spaceId: "3",
    siteName: "sse",
    keywordPosition: "title,paper_content",
    page: "0",
    limit: "10",
    publishTimeStart: `${window.begin} 00:00:00`,
    publishTimeEnd: `${window.end} 23:59:59`,
    channelId: "10001",
    searchMode: "preciseMulti",
  });
  return {
    url: `${SSE_FUND_ANNOUNCEMENT_URL}?${parameters}`,
    window,
  };
}

function providerCandidates(plan, now) {
  const candidates = [{
    source: "google-news-rss",
    url: rssUrl(plan),
    format: "rss",
    maxResponseBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
  }];
  if (plan.topic === "hashkey") {
    candidates.unshift({
      source: "hashkey-ir",
      url: HASHKEY_IR_URL,
      format: "hashkey-feed",
      maxResponseBytes: HASHKEY_RESPONSE_LIMIT_BYTES,
    });
  } else if (plan.topic === "oracle") {
    candidates.unshift({
      source: "sec-edgar-submissions",
      url: secEdgarSubmissionsUrl("ORCL"),
      format: "sec-submissions-json",
      publisher: "Oracle Corporation",
      since: new Date(now.valueOf() - 7 * DAY_MS),
      maxResponseBytes: SEC_RESPONSE_LIMIT_BYTES,
    });
  } else if (plan.topic === "alphabet") {
    candidates.unshift({
      source: "sec-edgar-submissions",
      url: secEdgarSubmissionsUrl("GOOGL"),
      format: "sec-submissions-json",
      publisher: "Alphabet Inc.",
      since: new Date(now.valueOf() - 7 * DAY_MS),
      maxResponseBytes: SEC_RESPONSE_LIMIT_BYTES,
    });
  } else if (plan.topic === "us-semiconductor") {
    candidates.unshift({
      source: "federal-reserve-rss",
      url: FEDERAL_RESERVE_RSS_URL,
      format: "federal-reserve-rss",
      supplementalEvidence: true,
      topicEvidence: true,
      symbolScope: "theme-etfs",
      maxResponseBytes: FED_RSS_RESPONSE_LIMIT_BYTES,
    });
  }
  if (["communications", "cn-semiconductor", "policy"].includes(plan.topic)) {
    candidates.push({
      source: "eastmoney-search",
      url: eastmoneySearchUrl(plan.eastmoneyKeyword),
      format: "eastmoney-jsonp",
      maxResponseBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
    });
    const policy = govPolicySearchUrl(plan, now);
    candidates.push({
      source: "gov-policy-library",
      url: policy.url,
      format: "gov-policy-json",
      policyWindow: policy.window,
      maxResponseBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
    });
  } else if (plan.topic === "us-semiconductor") {
    candidates.push({
      source: "yahoo-finance-rss",
      url: yahooRssUrl("SOXX"),
      format: "rss",
      maxResponseBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
    });
  } else if (plan.topic === "oracle") {
    candidates.push({
      source: "yahoo-finance-rss",
      url: yahooRssUrl("ORCL"),
      format: "rss",
      maxResponseBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
    });
  } else if (plan.topic === "alphabet") {
    candidates.push({
      source: "yahoo-finance-rss",
      url: yahooRssUrl("GOOGL"),
      format: "rss",
      maxResponseBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
    });
  } else if (plan.topic === "hashkey") {
    candidates.push({
      source: "yahoo-finance-rss",
      url: yahooRssUrl("3887.HK"),
      format: "rss",
      maxResponseBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
    });
  }
  return candidates;
}

function includesAlias(text, alias) {
  const value = String(text || "");
  const candidate = String(alias || "");
  if (/^[A-Za-z0-9][A-Za-z0-9.-]{1,15}$/.test(candidate)) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(value);
  }
  return value.toLocaleLowerCase().includes(candidate.toLocaleLowerCase());
}

function matchedSymbol(item, symbols) {
  const material = `${item.title} ${item.summary}`;
  for (const symbol of symbols) {
    if ((TARGET_ALIASES[symbol] || []).some((alias) => includesAlias(material, alias))) {
      return symbol;
    }
  }
  return null;
}

function matchedSymbols(item, plan) {
  if (Array.isArray(item._topicSymbols)) {
    return item._topicSymbols.length ? item._topicSymbols : [null];
  }
  const direct = matchedSymbol(item, plan.symbols);
  if (plan.topic === "cn-semiconductor") {
    return plan.symbols.filter((symbol) =>
      ["512480.SS", "159995.SZ"].includes(symbol));
  }
  if (plan.topic === "policy") {
    const material = `${item.title} ${item.summary}`;
    const matches = [];
    if (/(通信ETF|光模块|光通信|通信设备|5G|6G)/i.test(material)) {
      if (plan.symbols.includes("515880.SS")) matches.push("515880.SS");
    }
    if (/(半导体|芯片|集成电路)/i.test(material)) {
      for (const symbol of ["512480.SS", "159995.SZ"]) {
        if (plan.symbols.includes(symbol)) matches.push(symbol);
      }
    }
    return [...new Set(matches)];
  }
  return direct ? [direct] : plan.symbols.slice(0, 1);
}

function relevantToPlan(item, plan) {
  if (plan.topic === "policy") {
    if (COMMUNICATIONS_TITLE.test(item.title) || SEMICONDUCTOR_TITLE.test(item.title)) {
      return true;
    }
    return POLICY_AUTHORITY.test(item.title)
      && POLICY_ACTION.test(item.title)
      && (COMMUNICATIONS_TITLE.test(item.summary) || SEMICONDUCTOR_TITLE.test(item.summary));
  }
  if (plan.topic === "communications") return COMMUNICATIONS_TITLE.test(item.title);
  if (plan.topic === "cn-semiconductor") return SEMICONDUCTOR_TITLE.test(item.title);
  return matchedSymbol(item, plan.symbols) !== null;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|from$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}

async function sha256Hex(material) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function itemId(profileId, symbol, url, hashMaterial = sha256Hex) {
  const material = `${profileId}\n${symbol || ""}\n${canonicalUrl(url)}`;
  return `news-${await hashMaterial(material)}`;
}

async function itemClusterId(title, hashMaterial = sha256Hex) {
  const normalized = cleanText(title, 300)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `cluster-${await hashMaterial(normalized)}`;
}

class NewsFetchError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fetchErrorCode(error) {
  return typeof error?.code === "string"
    ? error.code
    : "NEWS_NETWORK_ERROR";
}

function validSecContactEmail(value) {
  const candidate = String(value || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return null;
  const [localPart, domain] = candidate.toLocaleLowerCase().split("@");
  if (
    /no-?reply/.test(localPart)
    || domain === "users.noreply.github.com"
  ) {
    return null;
  }
  return candidate;
}

function secUserAgent({ configuredUserAgent, organization, contactEmail } = {}) {
  const configured = String(configuredUserAgent || "").trim();
  const configuredEmail = validSecContactEmail(
    configured.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0],
  );
  if (
    configured.length <= 200
    && !/[\r\n]/.test(configured)
    && configuredEmail
    && configured.replace(configuredEmail, "").trim()
  ) {
    return configured;
  }
  const candidateEmail = validSecContactEmail(contactEmail);
  if (!candidateEmail) return null;
  const candidateOrganization = String(organization || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${candidateOrganization || "TradingWorkbench"} ${candidateEmail}`;
}

async function boundedResponseText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new NewsFetchError("NEWS_RESPONSE_TOO_LARGE");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const content = await response.text();
    if (new TextEncoder().encode(content).byteLength > maxBytes) {
      throw new NewsFetchError("NEWS_RESPONSE_TOO_LARGE");
    }
    return content;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new NewsFetchError("NEWS_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchContent(candidate, fetcher, requestConfig = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const userAgent = candidate.format === "sec-submissions-json"
      ? secUserAgent(requestConfig)
      : "TradingWorkbench/1.0 (+https://github.com/gaaiyun/TradingWorkbench)";
    if (!userAgent) throw new NewsFetchError("SEC_USER_AGENT_REQUIRED");
    const response = await fetcher(candidate.url, {
      signal: controller.signal,
      headers: {
        accept: candidate.format === "hashkey-feed"
          ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
          : candidate.format === "eastmoney-jsonp"
            ? "text/javascript,application/json,text/plain;q=0.9,*/*;q=0.5"
          : candidate.format === "gov-policy-json"
            ? "application/json,text/plain;q=0.8,*/*;q=0.5"
          : candidate.format === "sse-fund-jsonp"
            ? "text/javascript,application/json,text/plain;q=0.8,*/*;q=0.5"
          : candidate.format === "sec-submissions-json"
            ? "application/json,text/plain;q=0.8,*/*;q=0.5"
          : "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5",
        "user-agent": userAgent,
        ...(["gov-policy-json", "sse-fund-jsonp"].includes(candidate.format)
          ? { referer: candidate.referer || "https://sousuo.www.gov.cn/zcwjk/policyDocumentLibrary" }
          : {}),
      },
    });
    if (!response?.ok) {
      throw new NewsFetchError(`NEWS_HTTP_${Number(response?.status) || 0}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const supported = candidate.format === "hashkey-feed"
      ? /(?:text\/html|xml|rss)/i.test(contentType)
      : candidate.format === "eastmoney-jsonp"
        ? /(?:javascript|json|text\/plain)/i.test(contentType)
      : candidate.format === "gov-policy-json"
        ? /(?:application\/json|text\/plain)/i.test(contentType)
      : candidate.format === "sse-fund-jsonp"
        ? /(?:javascript|application\/json|text\/plain)/i.test(contentType)
      : candidate.format === "sec-submissions-json"
        ? /(?:application\/json|text\/plain)/i.test(contentType)
      : /(?:xml|rss|text\/plain)/i.test(contentType);
    if (!supported) {
      throw new NewsFetchError("NEWS_MALFORMED_RESPONSE");
    }
    return await boundedResponseText(
      response,
      candidate.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES,
    );
  } catch (error) {
    if (controller.signal.aborted) throw new NewsFetchError("NEWS_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cachedContent(candidate, fetcher, cache, requestConfig) {
  if (!cache.has(candidate.url)) {
    cache.set(candidate.url, fetchContent(candidate, fetcher, requestConfig));
  }
  return cache.get(candidate.url);
}

function validateEvidenceEnvelope(candidate, content) {
  const value = String(content || "");
  if (candidate.format === "gov-policy-json") {
    let payload;
    try {
      payload = JSON.parse(value);
    } catch {
      throw new NewsFetchError("NEWS_MALFORMED_RESPONSE");
    }
    if (
      String(payload?.code || "") !== "200"
      || !payload?.searchVO
      || !(payload.searchVO.catMap === null || typeof payload.searchVO.catMap === "object")
    ) {
      throw new NewsFetchError("NEWS_MALFORMED_RESPONSE");
    }
  } else if (candidate.format === "sse-fund-jsonp") {
    const match = /^TradingWorkbenchSse\((\{[\s\S]*\})\)\s*;?$/.exec(value.trim());
    let payload;
    try {
      payload = match ? JSON.parse(match[1]) : null;
    } catch {
      payload = null;
    }
    const validLegacy = Array.isArray(payload?.result);
    const validSearch = (
      String(payload?.code || "") === "0"
      && payload?.data?.originKeyword === candidate.symbol
      && Array.isArray(payload?.data?.knowledgeList)
    );
    if (!validLegacy && !validSearch) {
      throw new NewsFetchError("NEWS_MALFORMED_RESPONSE");
    }
  } else if (candidate.format === "sec-submissions-json") {
    let payload;
    try {
      payload = JSON.parse(value);
    } catch {
      throw new NewsFetchError("NEWS_MALFORMED_RESPONSE");
    }
    const recent = payload?.filings?.recent;
    if (
      !recent
      || !Array.isArray(recent.form)
      || !Array.isArray(recent.accessionNumber)
      || !Array.isArray(recent.primaryDocument)
    ) {
      throw new NewsFetchError("NEWS_MALFORMED_RESPONSE");
    }
  } else if (candidate.format === "federal-reserve-rss") {
    const rss = /<rss(?:\s[^>]*)?>/i.test(value);
    const channel = /<channel(?:\s[^>]*)?>/i.test(value);
    if (!rss || !channel) throw new NewsFetchError("NEWS_MALFORMED_RESPONSE");
  } else if (candidate.format === "hashkey-feed") {
    const start = value.indexOf('\\"posts\\":{\\"posts\\":');
    const end = value.indexOf('],\\"metaData\\":', Math.max(start, 0));
    const rss = /<rss(?:\s[^>]*)?>/i.test(value);
    const channel = /<channel(?:\s[^>]*)?>/i.test(value);
    if ((start < 0 || end < start) && (!rss || !channel)) {
      throw new NewsFetchError("NEWS_MALFORMED_RESPONSE");
    }
  }
}

async function fetchPlan(plan, fetcher, cache, requestConfig) {
  const trail = [];
  let firstSuccessfulSource = null;
  let discoverySatisfied = false;
  const collectedItems = [];
  const candidates = providerCandidates(plan, requestConfig.now);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const evidenceCandidate = EVIDENCE_PROVIDERS.has(candidate.source);
    if (discoverySatisfied && !evidenceCandidate) continue;
    try {
      const content = await cachedContent(candidate, fetcher, cache, requestConfig);
      if (evidenceCandidate) validateEvidenceEnvelope(candidate, content);
      const parsed = candidate.format === "hashkey-feed"
        ? parseHashKeyFeedPage(content)
        : candidate.format === "eastmoney-jsonp"
          ? parseEastmoneySearch(content)
        : candidate.format === "gov-policy-json"
          ? parseGovPolicyLibrary(content, {
            ...candidate.policyWindow,
            now: requestConfig.now,
          })
        : candidate.format === "sse-fund-jsonp"
          ? parseSseFundAnnouncements(content, candidate.symbol, {
            ...candidate.policyWindow,
            now: requestConfig.now,
            targetSymbol: candidate.targetSymbol,
          })
        : candidate.format === "sec-submissions-json"
          ? parseSecEdgarSubmissions(content, candidate.publisher, {
            since: candidate.since,
            now: requestConfig.now,
          })
        : candidate.format === "federal-reserve-rss"
          ? parseFederalReserveRss(content)
        : parseGoogleNewsRss(content);
      const items = parsed
        .filter((item) =>
          Array.isArray(item._topicSymbols)
          || candidate.topicEvidence
          || relevantToPlan(item, plan))
        .map((item) => candidate.symbolScope === "theme-etfs"
          ? {
            ...item,
            _topicSymbols: plan.symbols.filter((symbol) =>
              ["SOXX", "SMH"].includes(symbol)),
          }
          : item)
        .slice(0, RSS_LIMIT_PER_QUERY);
      trail.push({ source: candidate.source, status: "success", reason: null });
      firstSuccessfulSource ||= candidate.source;
      if (items.length) {
        const tagged = items.map((item) => ({
          ...item,
          _provider: candidate.source,
        }));
        if (
          evidenceCandidate
          && tagged.some(({ _sourceTier }) => _sourceTier !== "discovery")
          && !candidate.supplementalEvidence
          && collectedItems.length === 0
        ) {
          return { items: tagged, source: candidate.source, trail };
        }
        collectedItems.push(...tagged);
        if (candidate.supplementalEvidence) continue;
        if (!evidenceCandidate) discoverySatisfied = true;
        const hasRemainingEvidence = candidates
          .slice(index + 1)
          .some(({ source }) => EVIDENCE_PROVIDERS.has(source));
        if (!hasRemainingEvidence) {
          return {
            items: collectedItems,
            source: collectedItems[0]?._provider || candidate.source,
            trail,
          };
        }
      }
    } catch (error) {
      trail.push({
        source: candidate.source,
        status: "failed",
        reason: fetchErrorCode(error),
      });
    }
  }
  if (collectedItems.length) {
    return {
      items: collectedItems,
      source: collectedItems[0]._provider,
      trail,
    };
  }
  if (firstSuccessfulSource) {
    return { items: [], source: firstSuccessfulSource, trail };
  }
  throw new NewsFetchError(JSON.stringify(trail));
}

function itemSource(provider, item) {
  if (provider === "gov-policy-library") {
    return item._policyCategory === "otherfile"
      ? "中国政府网政策解读"
      : "中国政府网政策文件库";
  }
  if (provider === "sse-fund-announcements") return "上海证券交易所基金公告";
  if (provider === "hashkey-ir") return "HashKey Investor Relations";
  if (provider === "federal-reserve-rss") {
    return "Federal Reserve Board Press Releases";
  }
  if (provider === "sec-edgar-submissions") {
    return `SEC EDGAR Submissions / ${item.publisher}`;
  }
  if (provider === "sec-edgar-8k") return `SEC EDGAR 8-K / ${item.publisher}`;
  if (provider === "eastmoney-search") return `东方财富搜索 / ${item.publisher}`;
  if (provider === "yahoo-finance-rss") {
    let publisher = item.publisher;
    if (!publisher || publisher === "未知发布者") {
      try {
        publisher = new URL(item.url).hostname.replace(/^www\./, "");
      } catch {
        publisher = "未知发布者";
      }
    }
    return `Yahoo Finance RSS / ${publisher}`;
  }
  return `Google News / ${item.publisher}`;
}

export async function writeNewsItems(db, { items }) {
  if (!db || typeof db.prepare !== "function") throw new Error("DB_REQUIRED");
  if (!Array.isArray(items) || items.length === 0) return { written: 0 };
  await db.prepare(`
    INSERT INTO news_items (
      id, symbol, profile_id, topic, title, summary, url, published_at,
      source, source_tier, publisher, relevance, cluster_id,
      as_of, fetched_at, freshness, adjustment, quality, expires_at
    )
    SELECT
      json_extract(value, '$.id'),
      json_extract(value, '$.symbol'),
      json_extract(value, '$.profileId'),
      json_extract(value, '$.topic'),
      json_extract(value, '$.title'),
      json_extract(value, '$.summary'),
      json_extract(value, '$.url'),
      json_extract(value, '$.publishedAt'),
      json_extract(value, '$.source'),
      COALESCE(json_extract(value, '$.sourceTier'), 'discovery'),
      json_extract(value, '$.publisher'),
      json_extract(value, '$.relevance'),
      json_extract(value, '$.clusterId'),
      json_extract(value, '$.asOf'),
      json_extract(value, '$.fetchedAt'),
      json_extract(value, '$.freshness'),
      json_extract(value, '$.adjustment'),
      json_extract(value, '$.quality'),
      json_extract(value, '$.expiresAt')
    FROM json_each(?)
    WHERE 1
    ON CONFLICT(id) DO UPDATE SET
      symbol = excluded.symbol,
      topic = excluded.topic,
      title = excluded.title,
      summary = excluded.summary,
      url = excluded.url,
      published_at = excluded.published_at,
      source = excluded.source,
      source_tier = excluded.source_tier,
      publisher = excluded.publisher,
      relevance = excluded.relevance,
      cluster_id = excluded.cluster_id,
      as_of = excluded.as_of,
      fetched_at = excluded.fetched_at,
      freshness = excluded.freshness,
      quality = excluded.quality,
      expires_at = excluded.expires_at
  `).bind(JSON.stringify(items)).run();
  return { written: items.length };
}

export async function collectNewsForProfile({
  profile,
  db,
  env = {},
  fetcher = globalThis.fetch,
  writeItems = writeNewsItems,
  hashMaterial = sha256Hex,
  now = new Date(),
}) {
  const plans = queryPlans(profile);
  const responseCache = new Map();
  const outcomes = await Promise.allSettled(
    plans.map((plan) => fetchPlan(plan, fetcher, responseCache, {
      configuredUserAgent: env?.SEC_USER_AGENT,
      organization: env?.SEC_ORGANIZATION,
      contactEmail: env?.SEC_CONTACT_EMAIL,
      now,
    })),
  );
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.valueOf() + 180 * DAY_MS).toISOString();
  const byId = new Map();
  let succeeded = 0;
  let failed = 0;
  let coverageGaps = 0;
  const sources = [];

  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    const plan = plans[index];
    if (outcome.status === "rejected") {
      failed += 1;
      try {
        sources.push(...JSON.parse(outcome.reason?.message || "[]"));
      } catch {
        sources.push({
          source: "news-collector",
          status: "failed",
          reason: "NEWS_COLLECTION_ERROR",
        });
      }
      continue;
    }
    succeeded += 1;
    sources.push(...outcome.value.trail);
    if (outcome.value.trail.some(({ source, status }) =>
      EVIDENCE_PROVIDERS.has(source) && status === "failed")) {
      coverageGaps += 1;
    }
    for (const item of outcome.value.items) {
      const provider = item._provider || outcome.value.source;
      const symbols = matchedSymbols(item, plan);
      if (symbols.length === 0) continue;
      const clusterId = await itemClusterId(item.title, hashMaterial);
      const age = now.valueOf() - Date.parse(item.publishedAt);
      for (const symbol of symbols) {
        const id = await itemId(profile.id, symbol, item.url, hashMaterial);
        const row = {
          id,
          symbol,
          profileId: profile.id,
          topic: plan.topic,
          title: item.title,
          summary: item.summary,
          url: item.url,
          publishedAt: item.publishedAt,
          source: itemSource(provider, item),
          sourceTier: item._sourceTier || (
            EVIDENCE_PROVIDERS.has(provider) ? "evidence" : "discovery"
          ),
          publisher: item.publisher,
          relevance: 1,
          clusterId,
          asOf: item.publishedAt,
          fetchedAt,
          freshness: age >= 0 && age <= 36 * 60 * 60 * 1000 ? "fresh" : "stale",
          adjustment: null,
          quality: item._sourceTier || (
            EVIDENCE_PROVIDERS.has(provider) ? "evidence" : "discovery"
          ),
          expiresAt,
        };
        const existing = byId.get(id);
        if (!existing || (
          existing.sourceTier !== "evidence" && row.sourceTier === "evidence"
        )) {
          byId.set(id, row);
        }
      }
    }
  }

  const items = [...byId.values()]
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  if (items.length) await writeItems(db, { items });
  if (succeeded === 0) {
    return {
      status: "failed",
      errorCode: "NEWS_COLLECTION_UNAVAILABLE",
      written: 0,
      counts: { queries: plans.length, succeeded, failed, items: 0 },
      sources,
    };
  }
  const degraded = failed > 0 || coverageGaps > 0;
  return {
    status: degraded ? "degraded" : "completed",
    ...(degraded ? { errorCode: "NEWS_COLLECTION_PARTIAL" } : {}),
    written: items.length,
    counts: { queries: plans.length, succeeded, failed, items: items.length },
    sources,
  };
}
