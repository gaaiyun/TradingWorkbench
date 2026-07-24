const DAY_MS = 24 * 60 * 60 * 1000;
const RSS_LIMIT_PER_QUERY = 8;
const MIIT_RSS_URL = [
  "https://www.miit.gov.cn/api-gateway/jpaas-plugins-web-server/front/rss/getinfo",
  "?webId=8d828e408d90447786ddbe128d495e9e",
  "&columnIds=d3e2bede1bc045e2875fc7161c01db7d",
].join("");

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
  "3887.HK": ["Bitdeer", "Bitdeer Technologies", "比特小鹿", "03887", "3887.HK"],
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
      locale: "zh-CN",
    });
  }
  const cnSemiconductor = availableSymbols(profile, ["512480.SS", "159995.SZ"]);
  if (cnSemiconductor.length) {
    plans.push({
      topic: "cn-semiconductor",
      symbols: cnSemiconductor,
      query: '("半导体ETF" OR "芯片ETF" OR 半导体设备 OR 芯片产业 OR 集成电路) when:7d',
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
  const bitdeer = availableSymbols(profile, ["3887.HK"]);
  if (bitdeer.length) {
    plans.push({
      topic: "bitdeer",
      symbols: bitdeer,
      query: '("Bitdeer" OR "Bitdeer Technologies" OR 比特小鹿 OR 03887) when:30d',
      locale: "en-US",
    });
  }
  plans.push({
    topic: "policy",
    symbols: availableSymbols(profile, ["515880.SS", "512480.SS", "159995.SZ"]),
    query: "site:miit.gov.cn (半导体 OR 芯片 OR 通信 OR 光模块) when:30d",
    locale: "zh-CN",
  });
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

function providerCandidates(plan) {
  const candidates = [{
    source: "google-news-rss",
    url: rssUrl(plan),
  }];
  if (["communications", "cn-semiconductor", "policy"].includes(plan.topic)) {
    candidates.push({ source: "miit-rss", url: MIIT_RSS_URL });
  } else if (plan.topic === "us-semiconductor") {
    candidates.push({ source: "yahoo-finance-rss", url: yahooRssUrl("SOXX") });
  } else if (plan.topic === "oracle") {
    candidates.push({ source: "yahoo-finance-rss", url: yahooRssUrl("ORCL") });
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

async function itemId(profileId, symbol, url) {
  const material = `${profileId}\n${symbol || ""}\n${canonicalUrl(url)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `news-${hex}`;
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

async function fetchXml(url, fetcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: {
        accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5",
        "user-agent": "TradingWorkbench/1.0 (+https://github.com/gaaiyun/TradingWorkbench)",
      },
    });
    if (!response?.ok) {
      throw new NewsFetchError(`NEWS_HTTP_${Number(response?.status) || 0}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/(?:xml|rss|text\/plain)/i.test(contentType)) {
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

function cachedXml(url, fetcher, cache) {
  if (!cache.has(url)) cache.set(url, fetchXml(url, fetcher));
  return cache.get(url);
}

async function fetchPlan(plan, fetcher, cache) {
  const trail = [];
  let firstSuccessfulSource = null;
  for (const candidate of providerCandidates(plan)) {
    try {
      const parsed = parseGoogleNewsRss(
        await cachedXml(candidate.url, fetcher, cache),
      );
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
  if (provider === "miit-rss") return "工业和信息化部 RSS";
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
      source, source_tier, as_of, fetched_at, freshness, adjustment, quality, expires_at
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
  fetcher = globalThis.fetch,
  writeItems = writeNewsItems,
  now = new Date(),
}) {
  const plans = queryPlans(profile);
  const responseCache = new Map();
  const outcomes = await Promise.allSettled(
    plans.map((plan) => fetchPlan(plan, fetcher, responseCache)),
  );
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.valueOf() + 180 * DAY_MS).toISOString();
  const byId = new Map();
  let succeeded = 0;
  let failed = 0;
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
    for (const item of outcome.value.items) {
      const symbol = matchedSymbol(item, plan.symbols)
        || plan.symbols[0]
        || null;
      const id = await itemId(profile.id, symbol, item.url);
      if (byId.has(id)) continue;
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
        sourceTier: outcome.value.source === "miit-rss" ? "evidence" : "discovery",
        asOf: item.publishedAt,
        fetchedAt,
        freshness: age >= 0 && age <= 36 * 60 * 60 * 1000 ? "fresh" : "stale",
        adjustment: null,
        quality: "discovery",
        expiresAt,
      });
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
  return {
    status: failed > 0 ? "degraded" : "completed",
    ...(failed > 0 ? { errorCode: "NEWS_COLLECTION_PARTIAL" } : {}),
    written: items.length,
    counts: { queries: plans.length, succeeded, failed, items: items.length },
    sources,
  };
}
