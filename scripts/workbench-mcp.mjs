#!/usr/bin/env node

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://tradingagents-board.pages.dev/";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.^=_/-]{0,23}$/;
const TIMEFRAMES = new Set(["5m", "15m", "1h", "1d"]);
const IMPORTANCE = new Set(["all", "low", "medium", "high", "critical"]);

export const TOOLS = Object.freeze([
  {
    name: "list_monitor_profiles",
    description: "列出 Trading Workbench 已保存的监控目标、标的角色和任务设置。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_monitor_snapshot",
    description: "读取指定监控目标的数据新鲜度、来源健康和下一任务时间。",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", minLength: 1, maxLength: 80 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_market_bars",
    description: "读取标准化 OHLCV 与指标；只返回有来源和时间戳的工作台行情。",
    inputSchema: {
      type: "object",
      required: ["symbol"],
      properties: {
        symbol: { type: "string", minLength: 1, maxLength: 24 },
        timeframe: { type: "string", enum: ["5m", "15m", "1h", "1d"] },
        limit: { type: "integer", minimum: 1, maximum: 1260 },
        profileId: { type: "string", minLength: 1, maxLength: 80 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_market_news",
    description: "按标的、主题和重要性搜索新闻证据与发现层条目。",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", minLength: 1, maxLength: 24 },
        topic: { type: "string", minLength: 1, maxLength: 80 },
        importance: {
          type: "string",
          enum: ["all", "low", "medium", "high", "critical"],
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        profileId: { type: "string", minLength: 1, maxLength: 80 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_research_run",
    description: "读取某标的最近一次或指定日期的研究结果、审计状态和报告链接。",
    inputSchema: {
      type: "object",
      required: ["symbol"],
      properties: {
        symbol: { type: "string", minLength: 1, maxLength: 24 },
        tradeDate: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        },
      },
      additionalProperties: false,
    },
  },
]);

function objectArgs(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("arguments must be an object");
  }
  return args;
}

function assertOnlyKeys(args, allowed) {
  const extra = Object.keys(args).filter((key) => !allowed.has(key));
  if (extra.length) throw new TypeError(`unsupported argument: ${extra[0]}`);
}

function optionalString(value, name, maxLength = 80) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function symbolValue(value, required = true) {
  const symbol = optionalString(value, "symbol", 24)?.toUpperCase();
  if (!symbol && required) throw new TypeError("symbol is required");
  if (symbol && !SYMBOL_RE.test(symbol)) throw new TypeError("symbol is invalid");
  return symbol;
}

function integerValue(value, name, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function runtimeOptions(options = {}) {
  const base = new URL(options.baseUrl || process.env.TRADING_WORKBENCH_URL || DEFAULT_BASE_URL);
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new TypeError("TRADING_WORKBENCH_URL must use HTTP or HTTPS");
  }
  return {
    baseUrl: base,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
  };
}

async function fetchJson(pathname, options) {
  const { baseUrl, fetchImpl, timeoutMs } = runtimeOptions(options);
  const url = new URL(pathname, baseUrl);
  let response;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok || response.status < 500 || attempt === 1) break;
    } catch (error) {
      lastError = error;
      if (attempt === 1) throw error;
    }
  }
  if (!response) throw lastError || new Error("workbench request failed");
  if (!response.ok) throw new Error(`workbench returned HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error("workbench response is too large");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("workbench response is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("workbench returned invalid JSON");
  }
}

function queryPath(pathname, values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

async function listMonitorProfiles(args, options) {
  assertOnlyKeys(args, new Set());
  return fetchJson("/api/settings", options);
}

async function getMonitorSnapshot(args, options) {
  assertOnlyKeys(args, new Set(["profileId"]));
  const profileId = optionalString(args.profileId, "profileId");
  return fetchJson(queryPath("/api/monitor-status", { profileId }), options);
}

async function getMarketBars(args, options) {
  assertOnlyKeys(args, new Set(["symbol", "timeframe", "limit", "profileId"]));
  const symbol = symbolValue(args.symbol);
  const timeframe = optionalString(args.timeframe, "timeframe", 3) || "1d";
  if (!TIMEFRAMES.has(timeframe)) throw new TypeError("timeframe is unsupported");
  const limit = integerValue(args.limit, "limit", timeframe === "1d" ? 260 : 240, 1, 1260);
  const profileId = optionalString(args.profileId, "profileId");
  return fetchJson(
    queryPath("/api/market", { symbol, timeframe, limit, profileId }),
    options,
  );
}

async function searchMarketNews(args, options) {
  assertOnlyKeys(
    args,
    new Set(["symbol", "topic", "importance", "limit", "profileId"]),
  );
  const symbol = symbolValue(args.symbol, false);
  const topic = optionalString(args.topic, "topic");
  const importance = optionalString(args.importance, "importance", 10) || "all";
  if (!IMPORTANCE.has(importance)) throw new TypeError("importance is unsupported");
  const limit = integerValue(args.limit, "limit", 30, 1, 100);
  const profileId = optionalString(args.profileId, "profileId");
  return fetchJson(
    queryPath("/api/news", { symbol, topic, importance, limit, profileId }),
    options,
  );
}

async function getResearchRun(args, options) {
  assertOnlyKeys(args, new Set(["symbol", "tradeDate"]));
  const symbol = symbolValue(args.symbol);
  const tradeDate = optionalString(args.tradeDate, "tradeDate", 10);
  if (tradeDate && !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new TypeError("tradeDate must use YYYY-MM-DD");
  }
  const [historyPayload, auditPayload] = await Promise.all([
    fetchJson("/data/history.json", options),
    fetchJson("/data/report-audit.json", options),
  ]);
  const runs = Array.isArray(historyPayload) ? historyPayload : [];
  const candidates = [];
  for (const run of runs) {
    if (tradeDate && run?.trade_date !== tradeDate) continue;
    for (const result of Array.isArray(run?.results) ? run.results : []) {
      if (String(result?.ticker || "").toUpperCase() !== symbol) continue;
      candidates.push({ run, result });
    }
  }
  candidates.sort((left, right) => (
    String(right.run.generated_at || "").localeCompare(String(left.run.generated_at || ""))
  ));
  const selected = candidates[0];
  if (!selected) throw new Error(`no research run found for ${symbol}`);
  const auditRows = Array.isArray(auditPayload?.reports) ? auditPayload.reports : [];
  const audit = auditRows.find((row) => (
    row?.ticker === symbol
    && row?.tradeDate === selected.run.trade_date
    && (!selected.result.report || row?.report === selected.result.report)
  )) || null;
  const { baseUrl } = runtimeOptions(options);
  return {
    run: {
      trade_date: selected.run.trade_date,
      generated_at: selected.run.generated_at,
      provider: selected.run.provider,
    },
    result: selected.result,
    audit,
    reportUrl: selected.result.report
      ? new URL(selected.result.report, baseUrl).toString()
      : null,
  };
}

const TOOL_HANDLERS = new Map([
  ["list_monitor_profiles", listMonitorProfiles],
  ["get_monitor_snapshot", getMonitorSnapshot],
  ["get_market_bars", getMarketBars],
  ["search_market_news", searchMarketNews],
  ["get_research_run", getResearchRun],
]);

export async function callTool(name, input, options = {}) {
  const handler = TOOL_HANDLERS.get(name);
  if (!handler) throw new Error(`unknown read-only tool: ${name}`);
  return handler(objectArgs(input), options);
}

function resultContent(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleJsonRpc(message, options = {}) {
  const id = message?.id ?? null;
  if (message?.method === "notifications/initialized") return null;
  if (message?.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: message?.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "trading-workbench-readonly", version: "1.0.0" },
      },
    };
  }
  if (message?.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (message?.method === "tools/call") {
    try {
      const value = await callTool(
        message?.params?.name,
        message?.params?.arguments,
        options,
      );
      return { jsonrpc: "2.0", id, result: resultContent(value) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: resultContent(error instanceof Error ? error.message : "tool failed", true),
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  };
}

async function startStdioServer() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try {
      response = await handleJsonRpc(JSON.parse(line));
    } catch {
      response = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startStdioServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "MCP server failed"}\n`);
    process.exitCode = 1;
  });
}
