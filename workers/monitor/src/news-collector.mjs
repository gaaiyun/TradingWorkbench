const DAY_MS = 24 * 60 * 60 * 1000;
const RSS_LIMIT_PER_QUERY = 8;
const MIIT_POLICY_SEARCH_URL =
  "https://www.miit.gov.cn/search-front-server/api/search/info";
const MIIT_POLICY_COLUMN_IDS = new Set([
  "03b4fad2648149f0b9735dbb7300f34c", // 通告
  "cd969bf2ce7e4dd9a90f35e667f22255", // 公告
  "3e3ad1a3bec74939890a0d3e54815141", // 通知
  "f208042346424978bb16d077ca4c475b", // 意见
]);
const HASHKEY_IR_URL = "https://group.hashkey.com/en/news/categories/announcement-1";
const DEFAULT_SEC_CONTACT_EMAIL =
  "115156322+gaaiyun@users.noreply.github.com";
const SEC_EDGAR_CIK = {
  ORCL: "0001341439",
  GOOGL: "0001652044",
};
const EVIDENCE_PROVIDERS = new Set([
  "miit-policy-api",
  "hashkey-ir",
  "sec-edgar-8k",
]);

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

export function parseGoogleNewsRss(xml) {
  const items = [];
  for (const match of String(xml || "").matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
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
  return rows.flatMap((row) => {
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
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function parseMiitPolicySearch(payload, {
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
  const rows = response?.data?.searchResult?.dataResults;
  if (!Array.isArray(rows)) return [];
  const items = [];
  for (const row of rows) {
    if (items.length >= RSS_LIMIT_PER_QUERY) break;
    const data = row?.groupData?.[0]?.data || row?.data;
    if (!data || !MIIT_POLICY_COLUMN_IDS.has(String(data.columnid || ""))) {
      continue;
    }
    const title = cleanText(
      data.title_text || data.xxgkextend1 || data.title,
      300,
    );
    const summary = cleanText(
      data.infocontent || data.filenumbername || data.xxgkextend2,
      500,
    );
    const published = new Date(Number(data.deploytime));
    let url;
    try {
      url = new URL(String(data.url || ""), "https://www.miit.gov.cn");
      if (url.hostname !== "www.miit.gov.cn") continue;
      if (!url.pathname.startsWith("/zwgk/zcwj/wjfb/")) continue;
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
      publisher: cleanText(
        data.publishgroupname || data.xxgkextend2,
        120,
      ) || "工业和信息化部",
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

export function parseHashKeyFeedPage(html) {
  const value = String(html || "");
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
    return posts.flatMap((post) => {
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

function secEdgarAtomUrl(symbol) {
  const parameters = new URLSearchParams({
    action: "getcompany",
    CIK: SEC_EDGAR_CIK[symbol],
    type: "8-K",
    owner: "exclude",
    count: "40",
    output: "atom",
  });
  return `https://www.sec.gov/cgi-bin/browse-edgar?${parameters}`;
}

function miitPolicySearchUrl(plan, now) {
  const chipSymbols = ["512480.SS", "159995.SZ"];
  const query = plan.topic === "communications"
    ? "通信"
    : plan.symbols.some((symbol) => chipSymbols.includes(symbol))
      ? "芯片"
      : "通信";
  const window = {
    begin: shanghaiDate(new Date(now.valueOf() - 30 * DAY_MS)),
    end: shanghaiDate(now),
  };
  const parameters = new URLSearchParams({
    websiteid: "110000000000000",
    scope: "basic",
    q: query,
    pg: "10",
    cateid: "58",
    pos: "title_text,infocontent,titlepy",
    ...window,
    dateField: "deploytime",
    selectFields: [
      "title",
      "deploytime",
      "url",
      "columnname",
      "columnid",
      "filenumbername",
      "publishgroupname",
      "publishtime",
      "xxgkextend1",
      "xxgkextend2",
      "themename",
      "typename",
      "indexcode",
      "createdate",
    ].join(","),
    group: "distinct",
    level: "6",
    sortFields: JSON.stringify([{ name: "deploytime", type: "desc" }]),
    p: "1",
  });
  return {
    url: `${MIIT_POLICY_SEARCH_URL}?${parameters}`,
    window,
  };
}

function providerCandidates(plan, now) {
  const candidates = [{
    source: "google-news-rss",
    url: rssUrl(plan),
    format: "rss",
  }];
  if (plan.topic === "hashkey") {
    candidates.unshift({
      source: "hashkey-ir",
      url: HASHKEY_IR_URL,
      format: "hashkey-feed",
    });
  } else if (plan.topic === "oracle") {
    candidates.unshift({
      source: "sec-edgar-8k",
      url: secEdgarAtomUrl("ORCL"),
      format: "sec-edgar-atom",
      publisher: "Oracle Corporation",
    });
  } else if (plan.topic === "alphabet") {
    candidates.unshift({
      source: "sec-edgar-8k",
      url: secEdgarAtomUrl("GOOGL"),
      format: "sec-edgar-atom",
      publisher: "Alphabet Inc.",
    });
  }
  if (["communications", "cn-semiconductor", "policy"].includes(plan.topic)) {
    candidates.push({
      source: "eastmoney-search",
      url: eastmoneySearchUrl(plan.eastmoneyKeyword),
      format: "eastmoney-jsonp",
    });
    const miit = miitPolicySearchUrl(plan, now);
    candidates.push({
      source: "miit-policy-api",
      url: miit.url,
      format: "miit-policy-json",
      policyWindow: miit.window,
    });
  } else if (plan.topic === "us-semiconductor") {
    candidates.push({
      source: "yahoo-finance-rss",
      url: yahooRssUrl("SOXX"),
      format: "rss",
    });
  } else if (plan.topic === "oracle") {
    candidates.push({
      source: "yahoo-finance-rss",
      url: yahooRssUrl("ORCL"),
      format: "rss",
    });
  } else if (plan.topic === "alphabet") {
    candidates.push({
      source: "yahoo-finance-rss",
      url: yahooRssUrl("GOOGL"),
      format: "rss",
    });
  } else if (plan.topic === "hashkey") {
    candidates.push({
      source: "yahoo-finance-rss",
      url: yahooRssUrl("3887.HK"),
      format: "rss",
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
    return /(工信部|工业和信息化部|半导体|芯片|通信|光模块)/i
      .test(`${item.title} ${item.summary}`);
  }
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

async function itemId(profileId, symbol, url) {
  const material = `${profileId}\n${symbol || ""}\n${canonicalUrl(url)}`;
  return `news-${await sha256Hex(material)}`;
}

async function itemClusterId(title) {
  const normalized = cleanText(title, 300)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `cluster-${await sha256Hex(normalized)}`;
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

function secUserAgent(contactEmail) {
  const candidate = String(contactEmail || "").trim();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)
    ? candidate
    : DEFAULT_SEC_CONTACT_EMAIL;
  return `TradingWorkbench ${email}`;
}

async function fetchContent(candidate, fetcher, { secContactEmail } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetcher(candidate.url, {
      signal: controller.signal,
      headers: {
        accept: candidate.format === "hashkey-feed"
          ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
          : candidate.format === "eastmoney-jsonp"
            ? "text/javascript,application/json,text/plain;q=0.9,*/*;q=0.5"
          : candidate.format === "miit-policy-json"
            ? "application/json,text/plain;q=0.8,*/*;q=0.5"
          : candidate.format === "sec-edgar-atom"
            ? "application/atom+xml,application/xml,text/xml;q=0.9,text/html;q=0.8,*/*;q=0.5"
          : "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5",
        "user-agent": candidate.format === "sec-edgar-atom"
          ? secUserAgent(secContactEmail)
          : "TradingWorkbench/1.0 (+https://github.com/gaaiyun/TradingWorkbench)",
      },
    });
    if (!response?.ok) {
      throw new NewsFetchError(`NEWS_HTTP_${Number(response?.status) || 0}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const supported = candidate.format === "hashkey-feed"
      ? /text\/html/i.test(contentType)
      : candidate.format === "eastmoney-jsonp"
        ? /(?:javascript|json|text\/plain)/i.test(contentType)
      : candidate.format === "miit-policy-json"
        ? /(?:application\/json|text\/plain)/i.test(contentType)
      : candidate.format === "sec-edgar-atom"
        ? /(?:atom\+xml|xml|text\/html|text\/plain)/i.test(contentType)
      : /(?:xml|rss|text\/plain)/i.test(contentType);
    if (!supported) {
      throw new NewsFetchError("NEWS_MALFORMED_RESPONSE");
    }
    return await response.text();
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

async function fetchPlan(plan, fetcher, cache, requestConfig) {
  const trail = [];
  let firstSuccessfulSource = null;
  for (const candidate of providerCandidates(plan, requestConfig.now)) {
    try {
      const content = await cachedContent(candidate, fetcher, cache, requestConfig);
      const parsed = candidate.format === "hashkey-feed"
        ? parseHashKeyFeedPage(content)
        : candidate.format === "eastmoney-jsonp"
          ? parseEastmoneySearch(content)
        : candidate.format === "miit-policy-json"
          ? parseMiitPolicySearch(content, {
            ...candidate.policyWindow,
            now: requestConfig.now,
          })
        : candidate.format === "sec-edgar-atom"
          ? parseSecEdgarAtom(content, candidate.publisher)
        : parseGoogleNewsRss(content);
      const items = parsed
        .filter((item) => relevantToPlan(item, plan))
        .slice(0, RSS_LIMIT_PER_QUERY);
      trail.push({ source: candidate.source, status: "success", reason: null });
      firstSuccessfulSource ||= candidate.source;
      if (items.length) {
        return { items, source: candidate.source, trail };
      }
    } catch (error) {
      trail.push({
        source: candidate.source,
        status: "failed",
        reason: fetchErrorCode(error),
      });
    }
  }
  if (firstSuccessfulSource) {
    return { items: [], source: firstSuccessfulSource, trail };
  }
  throw new NewsFetchError(JSON.stringify(trail));
}

function itemSource(provider, item) {
  if (provider === "miit-policy-api") return "工业和信息化部政策文件库";
  if (provider === "hashkey-ir") return "HashKey Investor Relations";
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
  now = new Date(),
}) {
  const plans = queryPlans(profile);
  const responseCache = new Map();
  const outcomes = await Promise.allSettled(
    plans.map((plan) => fetchPlan(plan, fetcher, responseCache, {
      secContactEmail: env?.SEC_CONTACT_EMAIL,
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
    if (
      outcome.value.trail.some(({ source, status }) =>
        source === "sec-edgar-8k" && status === "failed")
    ) {
      coverageGaps += 1;
    }
    for (const item of outcome.value.items) {
      for (const symbol of matchedSymbols(item, plan)) {
        const id = await itemId(profile.id, symbol, item.url);
        if (byId.has(id)) continue;
        const clusterId = await itemClusterId(item.title);
        const age = now.valueOf() - Date.parse(item.publishedAt);
        byId.set(id, {
          id,
          symbol,
          profileId: profile.id,
          topic: plan.topic,
          title: item.title,
          summary: item.summary,
          url: item.url,
          publishedAt: item.publishedAt,
          source: itemSource(outcome.value.source, item),
          sourceTier: EVIDENCE_PROVIDERS.has(outcome.value.source)
            ? "evidence"
            : "discovery",
          publisher: item.publisher,
          relevance: 1,
          clusterId,
          asOf: item.publishedAt,
          fetchedAt,
          freshness: age >= 0 && age <= 36 * 60 * 60 * 1000 ? "fresh" : "stale",
          adjustment: null,
          quality: EVIDENCE_PROVIDERS.has(outcome.value.source)
            ? "evidence"
            : "discovery",
          expiresAt,
        });
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
