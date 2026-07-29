import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseWorkbenchSettings } from "../functions/api/_workbench_settings.mjs";
import {
  parseSseFundAnnouncements,
  writeNewsItems,
} from "../workers/monitor/src/news-collector.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const SSE_RETRY_DELAYS_MS = Object.freeze([1_000, 3_000]);
const SYMBOLS = Object.freeze([
  { symbol: "515880.SS", code: "515880", topic: "communications" },
  { symbol: "512480.SS", code: "512480", topic: "cn-semiconductor" },
]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function sseSearchUrl(code, now = new Date()) {
  const begin = isoDate(new Date(now.valueOf() - 30 * DAY_MS));
  const end = isoDate(now);
  const parameters = new URLSearchParams({
    jsonCallBack: "TradingWorkbenchSse",
    keyword: code,
    spaceId: "3",
    siteName: "sse",
    keywordPosition: "title,paper_content",
    page: "0",
    limit: "10",
    publishTimeStart: `${begin} 00:00:00`,
    publishTimeEnd: `${end} 23:59:59`,
    channelId: "10001",
    searchMode: "preciseMulti",
  });
  return {
    url: `https://query.sse.com.cn/search/getESSearchDoc.do?${parameters}`,
    begin,
    end,
  };
}

function assertSseEnvelope(content, code) {
  const match = /^TradingWorkbenchSse\((\{[\s\S]*\})\)\s*;?$/.exec(
    String(content || "").trim(),
  );
  let payload;
  try {
    payload = match ? JSON.parse(match[1]) : null;
  } catch {
    payload = null;
  }
  if (
    String(payload?.code || "") !== "0"
    || payload?.data?.originKeyword !== code
    || !Array.isArray(payload?.data?.knowledgeList)
  ) throw new Error(`SSE_RESPONSE_INVALID_${code}`);
}

function digest(material) {
  return createHash("sha256").update(material).digest("hex");
}

function databaseIdFromConfig(config) {
  const match = /^database_id\s*=\s*"([0-9a-f-]{36})"\s*$/im.exec(config);
  if (!match) throw new Error("D1_DATABASE_ID_NOT_FOUND");
  return match[1];
}

function isRetryableSseError(error) {
  if (error instanceof TypeError || error?.name === "AbortError") return true;
  return /^SSE_HTTP_(429|5\d\d)_/.test(String(error?.message || ""))
    || /^SSE_RESPONSE_INVALID_/.test(String(error?.message || ""));
}

async function fetchSseDocument({
  target,
  request,
  fetchImpl,
  sleepImpl,
}) {
  for (let attempt = 0; attempt <= SSE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetchImpl(request.url, {
        headers: {
          accept: "text/javascript,application/json,text/plain;q=0.8,*/*;q=0.5",
          referer: `https://www.sse.com.cn/home/search/?webswd=${target.code}`,
          "user-agent": "TradingWorkbench/1.0 (+https://github.com/gaaiyun/TradingWorkbench)",
        },
      });
      if (!response.ok) {
        throw new Error(`SSE_HTTP_${response.status}_${target.code}`);
      }
      const content = await response.text();
      if (new TextEncoder().encode(content).byteLength > 256 * 1024) {
        throw new Error(`SSE_RESPONSE_TOO_LARGE_${target.code}`);
      }
      assertSseEnvelope(content, target.code);
      return content;
    } catch (error) {
      if (
        attempt >= SSE_RETRY_DELAYS_MS.length
        || !isRetryableSseError(error)
      ) {
        if (error instanceof TypeError || error?.name === "AbortError") {
          throw new Error(`SSE_NETWORK_ERROR_${target.code}`);
        }
        throw error;
      }
      await sleepImpl(SSE_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new Error(`SSE_NETWORK_ERROR_${target.code}`);
}

export async function collectSseFundNews({
  apiToken,
  accountId,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  sleepImpl = (delayMs) => new Promise((resolveSleep) =>
    setTimeout(resolveSleep, delayMs)),
} = {}) {
  if (!apiToken || !accountId) throw new Error("CLOUDFLARE_CREDENTIALS_REQUIRED");
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID_INVALID");
  }
  const config = await readFile(resolve(root, "wrangler.toml"), "utf8");
  const databaseId = databaseIdFromConfig(config);
  const d1Endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  async function d1Query(sql, params = []) {
    const response = await fetchImpl(d1Endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      throw new Error(`D1_QUERY_FAILED_${response.status}`);
    }
    return payload.result?.[0] ?? {};
  }

  const settingsResult = await d1Query(
    "SELECT settings_json FROM workbench_settings WHERE id = ?",
    [1],
  );
  const settingsRow = settingsResult.results?.[0];
  if (!settingsRow?.settings_json) throw new Error("WORKBENCH_SETTINGS_MISSING");
  const settings = parseWorkbenchSettings(JSON.parse(settingsRow.settings_json));
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.valueOf() + 180 * DAY_MS).toISOString();
  const parsedBySymbol = new Map();
  for (const target of SYMBOLS) {
    const request = sseSearchUrl(target.code, now);
    const content = await fetchSseDocument({
      target,
      request,
      fetchImpl,
      sleepImpl,
    });
    parsedBySymbol.set(target.symbol, parseSseFundAnnouncements(
      content,
      target.code,
      { begin: request.begin, end: request.end, now, targetSymbol: target.symbol },
    ));
  }

  const rows = [];
  for (const profile of settings.profiles.filter(({ enabled }) => enabled)) {
    const configured = new Set(profile.targets.map(({ symbol }) => symbol));
    for (const target of SYMBOLS.filter(({ symbol }) => configured.has(symbol))) {
      for (const item of parsedBySymbol.get(target.symbol) || []) {
        const age = now.valueOf() - Date.parse(item.publishedAt);
        rows.push({
          id: `news-${digest(`${profile.id}\n${target.symbol}\n${item.url}`)}`,
          symbol: target.symbol,
          profileId: profile.id,
          topic: target.topic,
          title: item.title,
          summary: item.summary,
          url: item.url,
          publishedAt: item.publishedAt,
          source: "上海证券交易所基金公告",
          sourceTier: "evidence",
          publisher: item.publisher,
          relevance: 1,
          clusterId: `cluster-${digest(item.title.normalize("NFKC"))}`,
          asOf: item.publishedAt,
          fetchedAt,
          freshness: age >= 0 && age <= 36 * 60 * 60 * 1000 ? "fresh" : "stale",
          adjustment: null,
          quality: "evidence",
          expiresAt,
        });
      }
    }
  }
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return { run: () => d1Query(sql, params) };
        },
      };
    },
  };
  if (rows.length) await writeNewsItems(db, { items: rows });
  return {
    status: "completed",
    fetchedAt,
    written: rows.length,
    symbols: Object.fromEntries(SYMBOLS.map(({ symbol }) => [
      symbol,
      (parsedBySymbol.get(symbol) || []).length,
    ])),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await collectSseFundNews({
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
