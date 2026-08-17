#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ENDPOINTS = [
  "https://82.push2.eastmoney.com/api/qt/clist/get",
  "https://push2.eastmoney.com/api/qt/clist/get",
];
const PAGE_SIZE = 100;
const ROOT = new URL("../", import.meta.url);

function listingDate(value) {
  const text = String(value || "");
  return /^\d{8}$/.test(text)
    ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
    : null;
}

export function suffixForCn(code, market) {
  if (Number(market) === 1) return "SS";
  return /^(?:4|8|92)/.test(String(code)) ? "BJ" : "SZ";
}

export function normalizeCnInstrument(row) {
  const code = String(row?.f12 || "").trim();
  const name = String(row?.f14 || "").trim();
  if (!/^\d{6}$/.test(code) || !name) return null;
  const suffix = suffixForCn(code, row.f13);
  return {
    symbol: `${code}.${suffix}`,
    name,
    market: "CN",
    exchange: suffix,
    instrumentType: "stock",
    industry: String(row.f100 || "").trim() || null,
    listDate: listingDate(row.f26),
    source: "eastmoney-clist",
    coverage: "current_listed_best_effort",
  };
}

async function fetchPage(page, fetchImpl) {
  let lastError = new Error("eastmoney universe unavailable");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const endpoint of ENDPOINTS) {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({
        pn: String(page), pz: String(PAGE_SIZE), po: "1", np: "2", fltt: "2", invt: "2",
        ut: "bd1d9ddb04089700cf9c27f6f7426281",
        fid: "f12",
        fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
        fields: "f12,f14,f13,f100,f26",
        _: String(Date.now()),
      });
      try {
        const response = await fetchImpl(url, {
          headers: {
            accept: "application/json,text/plain,*/*",
            referer: "https://quote.eastmoney.com/",
            "user-agent": "Mozilla/5.0 (compatible; TradingWorkbench/1.0)",
          },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`eastmoney universe HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload?.data?.diff)) throw new Error("eastmoney universe malformed data");
        return { total: Number(payload.data.total) || 0, rows: payload.data.diff };
      } catch (error) {
        lastError = error instanceof Error ? error : lastError;
      }
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastError;
}

export async function fetchCnUniverse(fetchImpl = globalThis.fetch) {
  const first = await fetchPage(1, fetchImpl);
  const pages = Math.max(1, Math.ceil(first.total / PAGE_SIZE));
  const rows = [...first.rows];
  for (let page = 2; page <= pages; page += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    rows.push(...(await fetchPage(page, fetchImpl)).rows);
  }
  const bySymbol = new Map();
  for (const row of rows) {
    const instrument = normalizeCnInstrument(row);
    if (instrument) bySymbol.set(instrument.symbol, instrument);
  }
  return [...bySymbol.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function configuredInstruments(settings) {
  const targets = settings?.profiles?.flatMap(({ targets = [] }) => targets) || [];
  const bySymbol = new Map();
  for (const target of targets) {
    const symbol = String(target.symbol || "").toUpperCase();
    if (!symbol) continue;
    const market = target.market || (symbol.endsWith(".HK") ? "HK" : symbol.endsWith(".SS") || symbol.endsWith(".SZ") ? "CN" : "US");
    bySymbol.set(symbol, {
      symbol,
      name: target.name || symbol,
      market,
      exchange: symbol.split(".")[1] || market,
      instrumentType: ["SOXX", "SMH"].includes(symbol) || market === "CN" ? "etf" : "stock",
      industry: null,
      listDate: null,
      source: "workbench-settings",
      coverage: "configured_core",
    });
  }
  return [...bySymbol.values()];
}

export function buildUniverseSnapshot(cnStocks, settings, now = new Date()) {
  const configured = configuredInstruments(settings);
  const bySymbol = new Map(cnStocks.map((item) => [item.symbol, item]));
  for (const item of configured) bySymbol.set(item.symbol, item);
  const instruments = [...bySymbol.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
  return {
    version: 1,
    generatedAt: now.toISOString(),
    status: "degraded",
    coverage: {
      policy: "current-listed-best-effort-plus-configured-core",
      cnCurrentListedStocks: cnStocks.length,
      cnConfiguredCore: configured.filter(({ market }) => market === "CN").length,
      usCore: configured.filter(({ market }) => market === "US").length,
      hkCore: configured.filter(({ market }) => market === "HK").length,
      historicalDelisted: "unavailable",
      note: "免费公开源快照；不等同于授权全市场历史股票池。",
    },
    sources: [
      {
        id: "eastmoney-clist",
        role: "CN current-listed discovery",
        quality: "best_effort",
        asOf: now.toISOString(),
      },
      {
        id: "workbench-settings",
        role: "configured HK/US/CN core instruments",
        quality: "declared",
        asOf: now.toISOString(),
      },
    ],
    instruments,
  };
}

async function main() {
  const settings = JSON.parse(await readFile(new URL("public/data/workbench-settings.json", ROOT), "utf8"));
  const snapshot = buildUniverseSnapshot(await fetchCnUniverse(), settings);
  await writeFile(
    new URL("public/data/universe.json", ROOT),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`universe ${snapshot.instruments.length} instruments\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "universe update failed"}\n`);
    process.exitCode = 1;
  });
}
