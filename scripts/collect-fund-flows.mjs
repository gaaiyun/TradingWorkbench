import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseWorkbenchSettings } from "../functions/api/_workbench_settings.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_YEARS_MS = 10 * 365 * DAY_MS;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const WRITE_CHUNK_SIZE = 250;
const MARGIN_PAGE_SIZE = 500;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const FUND_FLOW_TARGETS = Object.freeze([
  { symbol: "515880.SS", code: "515880", secid: "1.515880", sseHistory: true },
  { symbol: "512480.SS", code: "512480", secid: "1.512480", sseHistory: true },
  { symbol: "159995.SZ", code: "159995", secid: "0.159995", sseHistory: false },
]);

function sha256(material) {
  return createHash("sha256").update(material).digest("hex");
}

function databaseIdFromConfig(config) {
  const match = /^database_id\s*=\s*"([0-9a-f-]{36})"\s*$/im.exec(config);
  if (!match) throw new Error("D1_DATABASE_ID_NOT_FOUND");
  return match[1];
}

function shanghaiDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function tradeDateTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00+08:00`);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function providerHeaders(url) {
  const parsed = new URL(url);
  const headers = {
    accept: "application/json,text/plain,*/*",
    "user-agent": "TradingWorkbench/1.0 (+https://github.com/gaaiyun/TradingWorkbench)",
  };
  if (parsed.hostname.endsWith("sse.com.cn")) {
    // commonQuery rejects the repository-identifying bot user agent from
    // GitHub-hosted runners even though the same request succeeds locally.
    // Match the public ETF scale page request shape without adding cookies.
    headers.accept = "application/json, text/javascript, */*; q=0.01";
    headers.referer = "https://etf.sse.com.cn/fundlist/scalelist/index.shtml";
    headers["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36";
  } else if (parsed.hostname.endsWith("eastmoney.com")) {
    headers.referer = "https://quote.eastmoney.com/";
  }
  return headers;
}

export async function fetchBoundedJson(
  fetchImpl,
  url,
  {
    delayImpl = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
    randomImpl = Math.random,
    retries = 2,
  } = {},
) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: providerHeaders(url) });
      if (response.status === 403) throw new Error("UPSTREAM_BLOCKED");
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= retries) {
          throw new Error(`UPSTREAM_HTTP_${response.status}`);
        }
        lastError = new Error(`UPSTREAM_HTTP_${response.status}`);
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_RESPONSE_BYTES) {
          throw new Error("UPSTREAM_RESPONSE_TOO_LARGE");
        }
        try {
          return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new Error("UPSTREAM_SCHEMA");
        }
      }
    } catch (error) {
      if (error?.message === "UPSTREAM_BLOCKED") throw error;
      if (
        attempt >= retries
        || /^UPSTREAM_(?:SCHEMA|RESPONSE_TOO_LARGE)$/.test(error?.message || "")
        || (/^UPSTREAM_HTTP_4\d\d$/.test(error?.message || "") && error?.message !== "UPSTREAM_HTTP_429")
      ) {
        throw error?.message?.startsWith("UPSTREAM_") ? error : new Error("UPSTREAM_NETWORK");
      }
      lastError = error;
    }
    const delay = 1000 * (2 ** attempt) + Math.floor(randomImpl() * 250);
    await delayImpl(delay);
  }
  throw lastError || new Error("UPSTREAM_NETWORK");
}

export function marginUrl(code, pageNumber = 1, pageSize = MARGIN_PAGE_SIZE) {
  const parameters = new URLSearchParams({
    reportName: "RPTA_WEB_RZRQ_GGMX",
    columns: "ALL",
    filter: `(SCODE=\"${code}\")`,
    sortColumns: "DATE",
    sortTypes: "-1",
    pageSize: String(pageSize),
    pageNumber: String(pageNumber),
    source: "WEB",
    client: "WEB",
  });
  return `https://datacenter-web.eastmoney.com/api/data/v1/get?${parameters}`;
}

export function parseMarginPage(payload, code) {
  if (payload?.success !== true || Number(payload?.code) !== 0 || !Array.isArray(payload?.result?.data)) {
    if (Number(payload?.code) === 9201 && payload?.result === null) return { rows: [], pages: 0, count: 0 };
    throw new Error("UPSTREAM_SCHEMA");
  }
  const rows = [];
  for (const item of payload.result.data) {
    if (String(item?.SCODE || "") !== code) continue;
    const date = String(item?.DATE || "").slice(0, 10);
    const ts = tradeDateTimestamp(date);
    if (!ts) continue;
    const values = {
      margin_balance: finiteNonNegative(item.RZYE),
      margin_buy: finiteNonNegative(item.RZMRE),
      margin_net_buy: finiteNumber(item.RZJME),
    };
    if (Object.values(values).every((value) => value === null)) continue;
    rows.push({
      date,
      ts,
      values,
      close: finiteNonNegative(item.SPJ),
    });
  }
  if (payload.result.data.length > 0 && rows.length === 0) throw new Error("UPSTREAM_SCHEMA");
  return {
    rows,
    pages: Math.max(1, Number(payload.result.pages) || 1),
    count: Math.max(rows.length, Number(payload.result.count) || rows.length),
  };
}

export function sseScaleUrl(code, pageNumber = 1, { begin = "", end = "", pageSize = 25 } = {}) {
  const parameters = new URLSearchParams({
    isPagination: "true",
    sqlId: "COMMON_JJZWZ_JJLB_JJXQ_JJGM_CKLSGM_L",
    FUND_CODE: code,
    "pageHelp.cacheSize": "1",
    "pageHelp.pageSize": String(pageSize),
    "pageHelp.pageNo": String(pageNumber),
    "pageHelp.beginPage": String(pageNumber),
    "pageHelp.endPage": String(pageNumber),
    START_DATE: begin,
    END_DATE: end,
  });
  return `https://query.sse.com.cn/commonQuery.do?${parameters}`;
}

export function parseSseScalePage(payload, code) {
  if (!Array.isArray(payload?.result)) throw new Error("UPSTREAM_SCHEMA");
  const rows = payload.result.flatMap((item) => {
    if (String(item?.FUND_CODE || "") !== code) return [];
    const date = String(item?.TRADE_DATE || "").slice(0, 10);
    const ts = tradeDateTimestamp(date);
    const scaleYi = finiteNonNegative(item?.SCALE);
    if (!ts || scaleYi === null) return [];
    return [{ date, ts, scaleCny: Math.round(scaleYi * 100_000_000) }];
  });
  if (payload.result.length > 0 && rows.length === 0) throw new Error("UPSTREAM_SCHEMA");
  const pageInfo = payload.pageHelp || payload.pagehelp || {};
  return {
    rows,
    pages: Math.max(1, Number(pageInfo.pageCount) || Number(pageInfo.pageCounts) || 1),
    count: Math.max(rows.length, Number(pageInfo.total) || Number(pageInfo.totalCount) || rows.length),
  };
}

export function unadjustedCloseUrl(secid, limit = 2000) {
  const parameters = new URLSearchParams({
    secid,
    klt: "101",
    fqt: "0",
    beg: "0",
    end: "20500101",
    lmt: String(limit),
    fields1: "f1",
    fields2: "f51,f52,f53,f54,f55,f56",
  });
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?${parameters}`;
}

export function parseUnadjustedCloses(payload, code) {
  if (payload?.rc !== 0 || String(payload?.data?.code || "") !== code || !Array.isArray(payload?.data?.klines)) {
    throw new Error("UPSTREAM_SCHEMA");
  }
  const closes = new Map();
  for (const line of payload.data.klines) {
    const [date, , close] = String(line).split(",");
    const value = finiteNonNegative(close);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && value !== null && value > 0) closes.set(date, value);
  }
  return closes;
}

export function shareSnapshotUrl(secid) {
  const parameters = new URLSearchParams({
    secid,
    fields: "f43,f57,f58,f84,f85,f116,f117,f124",
  });
  return `https://push2delay.eastmoney.com/api/qt/stock/get?${parameters}`;
}

export function parseShareSnapshot(
  payload,
  code,
  observedAt,
  tradeDate = shanghaiDate(observedAt),
) {
  if (payload?.rc !== 0 || String(payload?.data?.f57 || "") !== code) throw new Error("UPSTREAM_SCHEMA");
  const shares = finiteNonNegative(payload.data.f84);
  const marketValue = finiteNonNegative(payload.data.f116);
  const rawPrice = finiteNonNegative(payload.data.f43);
  if (shares === null || shares <= 0 || marketValue === null || rawPrice === null) {
    throw new Error("UPSTREAM_SCHEMA");
  }
  return {
    date: tradeDate,
    ts: tradeDateTimestamp(tradeDate),
    shares,
    marketValue,
    price: rawPrice / 1000,
  };
}

function rowId(profileId, symbol, flowType, ts, source) {
  return `flow-${sha256(`${profileId}\n${symbol}\n${flowType}\n${ts}\n${source}`)}`;
}

function flowRow({
  profileId,
  symbol,
  flowType,
  ts,
  value,
  unit,
  currency = null,
  source,
  method,
  fetchedAt,
  freshness,
  quality,
  expiresAt,
}) {
  return {
    id: rowId(profileId, symbol, flowType, ts, source),
    profileId,
    symbol,
    flowType,
    period: "1d",
    ts,
    value,
    unit,
    currency,
    source,
    method,
    asOf: ts,
    fetchedAt,
    freshness,
    adjustment: "none",
    quality,
    expiresAt,
  };
}

function freshnessFor(ts, now) {
  const age = now.valueOf() - Date.parse(ts);
  return age >= 0 && age <= 4 * DAY_MS ? "fresh" : "stale";
}

async function collectMarginHistory(target, { fetchImpl, mode, requestOptions, delayImpl }) {
  const firstPayload = await fetchBoundedJson(fetchImpl, marginUrl(
    target.code,
    1,
    mode === "daily" ? 50 : MARGIN_PAGE_SIZE,
  ), { ...requestOptions, delayImpl });
  const first = parseMarginPage(firstPayload, target.code);
  const rows = [...first.rows];
  if (mode === "backfill") {
    for (let page = 2; page <= first.pages; page += 1) {
      await delayImpl(1000);
      const payload = await fetchBoundedJson(fetchImpl, marginUrl(target.code, page), {
        ...requestOptions,
        delayImpl,
      });
      rows.push(...parseMarginPage(payload, target.code).rows);
    }
  }
  return rows;
}

async function collectSseScaleHistory(target, { fetchImpl, mode, now, requestOptions, delayImpl }) {
  const end = shanghaiDate(now).replaceAll("-", "");
  const begin = mode === "daily"
    ? shanghaiDate(new Date(now.valueOf() - 14 * DAY_MS)).replaceAll("-", "")
    : "";
  const firstPayload = await fetchBoundedJson(fetchImpl, sseScaleUrl(target.code, 1, { begin, end }), {
    ...requestOptions,
    delayImpl,
  });
  const first = parseSseScalePage(firstPayload, target.code);
  const rows = [...first.rows];
  if (mode === "backfill") {
    for (let page = 2; page <= first.pages; page += 1) {
      await delayImpl(1000);
      const payload = await fetchBoundedJson(fetchImpl, sseScaleUrl(target.code, page, { begin, end }), {
        ...requestOptions,
        delayImpl,
      });
      rows.push(...parseSseScalePage(payload, target.code).rows);
    }
  }
  return rows;
}

function d1Writer(d1Query) {
  return async (items) => {
    for (let index = 0; index < items.length; index += WRITE_CHUNK_SIZE) {
      const chunk = items.slice(index, index + WRITE_CHUNK_SIZE);
      await d1Query(`
        INSERT INTO fund_flows (
          id, profile_id, symbol, flow_type, period, ts, value, unit, currency,
          source, method, as_of, fetched_at, freshness, adjustment, quality,
          expires_at
        )
        SELECT
          json_extract(value, '$.id'),
          json_extract(value, '$.profileId'),
          json_extract(value, '$.symbol'),
          json_extract(value, '$.flowType'),
          json_extract(value, '$.period'),
          json_extract(value, '$.ts'),
          json_extract(value, '$.value'),
          json_extract(value, '$.unit'),
          json_extract(value, '$.currency'),
          json_extract(value, '$.source'),
          json_extract(value, '$.method'),
          json_extract(value, '$.asOf'),
          json_extract(value, '$.fetchedAt'),
          json_extract(value, '$.freshness'),
          json_extract(value, '$.adjustment'),
          json_extract(value, '$.quality'),
          json_extract(value, '$.expiresAt')
        FROM json_each(?)
        WHERE 1
        ON CONFLICT(profile_id, symbol, flow_type, period, ts, source, adjustment)
        DO UPDATE SET
          value = excluded.value,
          unit = excluded.unit,
          currency = excluded.currency,
          method = excluded.method,
          as_of = excluded.as_of,
          fetched_at = excluded.fetched_at,
          freshness = excluded.freshness,
          quality = excluded.quality,
          expires_at = excluded.expires_at
        WHERE excluded.fetched_at >= fund_flows.fetched_at
      `, [JSON.stringify(chunk)]);
    }
  };
}

export async function collectFundFlows({
  apiToken,
  accountId,
  mode = "daily",
  now = new Date(),
  fetchImpl = globalThis.fetch,
  delayImpl = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  randomImpl = Math.random,
} = {}) {
  if (!apiToken || !accountId) throw new Error("CLOUDFLARE_CREDENTIALS_REQUIRED");
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID_INVALID");
  if (!new Set(["backfill", "daily"]).has(mode)) throw new Error("COLLECTION_MODE_INVALID");
  const config = await readFile(resolve(root, "wrangler.toml"), "utf8");
  const databaseId = databaseIdFromConfig(config);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  async function d1Query(sql, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) throw new Error(`D1_QUERY_FAILED_${response.status}`);
    return payload.result?.[0] || {};
  }
  const settingsResult = await d1Query("SELECT settings_json FROM workbench_settings WHERE id = ?", [1]);
  const settingsRow = settingsResult.results?.[0];
  if (!settingsRow?.settings_json) throw new Error("WORKBENCH_SETTINGS_MISSING");
  const settings = parseWorkbenchSettings(JSON.parse(settingsRow.settings_json));
  const profilesBySymbol = new Map(FUND_FLOW_TARGETS.map(({ symbol }) => [symbol, []]));
  for (const profile of settings.profiles.filter(({ enabled }) => enabled)) {
    const configured = new Set(profile.targets.map(({ symbol }) => symbol));
    for (const target of FUND_FLOW_TARGETS) {
      if (configured.has(target.symbol)) profilesBySymbol.get(target.symbol).push(profile.id);
    }
  }
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.valueOf() + TEN_YEARS_MS).toISOString();
  const requestOptions = { randomImpl };
  const rawBySymbol = new Map();
  const failures = [];
  for (const target of FUND_FLOW_TARGETS) {
    if ((profilesBySymbol.get(target.symbol) || []).length === 0) continue;
    const margin = await collectMarginHistory(target, {
      fetchImpl,
      mode,
      requestOptions,
      delayImpl,
    });
    rawBySymbol.set(target.symbol, { margin, scale: [], closes: new Map(), snapshot: null });
    if (target.sseHistory) {
      await delayImpl(1000);
      try {
        const scale = await collectSseScaleHistory(target, {
          fetchImpl,
          mode,
          now,
          requestOptions,
          delayImpl,
        });
        rawBySymbol.get(target.symbol).scale = scale;
        rawBySymbol.get(target.symbol).closes = new Map(margin.flatMap(({ date, close }) =>
          close !== null && close > 0 ? [[date, close]] : []));
      } catch (error) {
        failures.push({
          symbol: target.symbol,
          source: "sse-fund-scale-daily",
          reason: String(error?.message || "").startsWith("UPSTREAM_")
            ? error.message
            : "UPSTREAM_NETWORK",
        });
      }
    }
    await delayImpl(1000);
    try {
      const snapshotPayload = await fetchBoundedJson(fetchImpl, shareSnapshotUrl(target.secid), {
        ...requestOptions,
        delayImpl,
      });
      rawBySymbol.get(target.symbol).snapshot = parseShareSnapshot(
        snapshotPayload,
        target.code,
        now,
        rawBySymbol.get(target.symbol).margin[0]?.date || shanghaiDate(now),
      );
    } catch (error) {
      failures.push({
        symbol: target.symbol,
        source: "eastmoney-share-snapshot",
        reason: String(error?.message || "").startsWith("UPSTREAM_")
          ? error.message
          : "UPSTREAM_NETWORK",
      });
    }
  }
  const rows = [];
  for (const target of FUND_FLOW_TARGETS) {
    const raw = rawBySymbol.get(target.symbol);
    if (!raw) continue;
    for (const profileId of profilesBySymbol.get(target.symbol) || []) {
      for (const margin of raw.margin) {
        for (const [flowType, value] of Object.entries(margin.values)) {
          if (value === null) continue;
          rows.push(flowRow({
            profileId,
            symbol: target.symbol,
            flowType,
            ts: margin.ts,
            value,
            unit: "CNY",
            currency: "CNY",
            source: "eastmoney-margin-daily",
            method: "reported",
            fetchedAt,
            freshness: freshnessFor(margin.ts, now),
            quality: "reported",
            expiresAt,
          }));
        }
      }
      for (const scale of raw.scale) {
        rows.push(flowRow({
          profileId,
          symbol: target.symbol,
          flowType: "fund_scale",
          ts: scale.ts,
          value: scale.scaleCny,
          unit: "CNY",
          currency: "CNY",
          source: "sse-fund-scale-daily",
          method: "reported",
          fetchedAt,
          freshness: freshnessFor(scale.ts, now),
          quality: "evidence",
          expiresAt,
        }));
        const close = raw.closes.get(scale.date);
        if (Number.isFinite(close) && close > 0) {
          rows.push(flowRow({
            profileId,
            symbol: target.symbol,
            flowType: "shares_outstanding_derived",
            ts: scale.ts,
            value: Math.round(scale.scaleCny / close),
            unit: "shares",
            source: "sse-scale-eastmoney-close",
            method: "fund_scale_divided_by_unadjusted_close",
            fetchedAt,
            freshness: freshnessFor(scale.ts, now),
            quality: "derived",
            expiresAt,
          }));
        }
      }
      if (raw.snapshot) {
        rows.push(flowRow({
          profileId,
          symbol: target.symbol,
          flowType: "shares_outstanding_snapshot",
          ts: raw.snapshot.ts,
          value: raw.snapshot.shares,
          unit: "shares",
          source: "eastmoney-share-snapshot",
          method: "observed_without_source_timestamp",
          fetchedAt,
          freshness: "fresh",
          quality: "snapshot_unstamped",
          expiresAt,
        }));
      }
    }
  }
  await d1Writer(d1Query)(rows);
  const counts = {};
  for (const row of rows) {
    const key = `${row.symbol}:${row.flowType}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return {
    status: failures.length ? "degraded" : "completed",
    mode,
    fetchedAt,
    profiles: [...new Set(rows.map(({ profileId }) => profileId))],
    written: rows.length,
    counts,
    failures,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modeArgument = process.argv.find((argument) => argument.startsWith("--mode="));
  const result = await collectFundFlows({
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    mode: modeArgument?.slice("--mode=".length) || "daily",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
