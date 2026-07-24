import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import * as workbenchData from "../public/assets/workbench-data.mjs";

const {
  DEFAULT_TARGETS,
  applySeriesBatch,
  buildChatHistory,
  compactThreads,
  computeNextRun,
  createLatestRequestGate,
  dailyHistoryLimit,
  filterFeedItems,
  mergeIncrementalBatch,
  mergeIncrementalBars,
  normalizeEnvelope,
} = workbenchData;

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/assets/workbench.css", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/assets/workbench.js", import.meta.url), "utf8");
const dataScript = readFileSync(new URL("../public/assets/workbench-data.mjs", import.meta.url), "utf8");

test("research terminal exposes the continuous three-column workspace and indicator panes", () => {
  assert.match(html, /class="research-layout"/);
  assert.match(html, /id="watchlist"/);
  assert.match(html, /id="task-timeline"/);
  assert.match(html, /id="market-chart"/);
  assert.match(html, /id="macd-chart"/);
  assert.match(html, /id="rsi-chart"/);
  assert.match(html, /id="research-feed"/);
  assert.match(html, /id="cross-market-drivers"/);
  assert.match(html, /data-timeframe="5m"/);
  assert.match(html, /data-timeframe="15m"/);
  assert.match(html, /data-timeframe="1h"/);
  assert.match(html, /data-timeframe="1d"/);
});

test("default universe contains the full ETF and semiconductor driver set", () => {
  assert.deepEqual(
    DEFAULT_TARGETS.map(({ symbol }) => symbol),
    ["515880.SS", "512480.SS", "159995.SZ", "SOXX", "SMH", "NVDA", "TSM", "AVGO", "AMD", "ASML", "ORCL"],
  );
});

test("dynamic API envelopes retain provenance and expose an unavailable fallback", () => {
  const normalized = normalizeEnvelope({
    status: "stale",
    asOf: "2026-07-23T08:00:00.000Z",
    data: [{ symbol: "NVDA" }],
    sources: [{ source: "stooq", fetchedAt: "2026-07-23T08:01:00.000Z", freshness: "stale" }],
  });
  assert.equal(normalized.status, "stale");
  assert.equal(normalized.data[0].symbol, "NVDA");
  assert.equal(normalized.sources[0].freshness, "stale");

  const unavailable = normalizeEnvelope(null);
  assert.deepEqual(unavailable, { status: "unavailable", asOf: null, data: [], sources: [] });
});

test("market polling replaces only the matching last bar and appends a newer bar", () => {
  const bars = [
    { ts: "2026-07-23T01:00:00.000Z", close: 10 },
    { ts: "2026-07-23T01:05:00.000Z", close: 11 },
  ];
  const replaced = mergeIncrementalBars(bars, [
    { ts: "2026-07-23T01:05:00.000Z", close: 11.5 },
  ]);
  assert.deepEqual(replaced, [
    { ts: "2026-07-23T01:00:00.000Z", close: 10 },
    { ts: "2026-07-23T01:05:00.000Z", close: 11.5 },
  ]);
  assert.equal(replaced[0], bars[0]);

  const appended = mergeIncrementalBars(replaced, [
    { ts: "2026-07-23T01:10:00.000Z", close: 12 },
  ]);
  assert.equal(appended.length, 3);
  assert.equal(appended.at(-1).close, 12);
});

test("incremental batches identify revisions that require dependent indicator replay", () => {
  const current = [
    { ts: "2026-07-23T01:00:00.000Z", close: 10 },
    { ts: "2026-07-23T01:05:00.000Z", close: 11 },
    { ts: "2026-07-23T01:10:00.000Z", close: 12 },
  ];
  const revisedAndAppended = mergeIncrementalBatch(current, [
    { ts: "2026-07-23T01:10:00.000Z", close: 12.5 },
    { ts: "2026-07-23T01:15:00.000Z", close: 13 },
  ]);
  assert.equal(revisedAndAppended.changedFromIndex, 2);
  assert.equal(revisedAndAppended.strategy, "setData");
  assert.deepEqual(revisedAndAppended.bars.map(({ close }) => close), [10, 11, 12.5, 13]);

  const lastOnly = mergeIncrementalBatch(current, [
    { ts: "2026-07-23T01:10:00.000Z", close: 12.5 },
  ]);
  assert.equal(lastOnly.changedFromIndex, 2);
  assert.equal(lastOnly.strategy, "update");

  const appendOnly = mergeIncrementalBatch(current, [
    { ts: "2026-07-23T01:15:00.000Z", close: 13 },
    { ts: "2026-07-23T01:20:00.000Z", close: 14 },
  ]);
  assert.equal(appendOnly.changedFromIndex, 3);
  assert.equal(appendOnly.strategy, "update");
});

test("series batch application updates every affected point or replaces all dependent data", () => {
  const calls = [];
  const series = {
    candles: {
      update: (point) => calls.push(["candles.update", point.time]),
      setData: (points) => calls.push(["candles.setData", points.length]),
    },
    macd: {
      update: (point) => calls.push(["macd.update", point.time]),
      setData: (points) => calls.push(["macd.setData", points.length]),
    },
  };
  const dataSets = {
    candles: [{ time: 1 }, { time: 2 }, { time: 3 }],
    macd: [{ time: 1 }, { time: 2 }, { time: 3 }],
  };
  applySeriesBatch(series, dataSets, { strategy: "update", changedFromIndex: 1 });
  assert.deepEqual(calls, [
    ["candles.update", 2], ["macd.update", 2],
    ["candles.update", 3], ["macd.update", 3],
  ]);
  calls.length = 0;
  applySeriesBatch(series, dataSets, { strategy: "setData", changedFromIndex: 1 });
  assert.deepEqual(calls, [["candles.setData", 3], ["macd.setData", 3]]);
});

test("market request gate preserves an in-flight full load from same-context polling", () => {
  const gate = createLatestRequestGate();
  const full = gate.begin("512480.SS", "15m", "full");
  const skippedPoll = gate.begin("512480.SS", "15m", "incremental");
  assert.equal(skippedPoll, null);
  assert.equal(full.signal.aborted, false);
  assert.equal(gate.isCurrent(full, "512480.SS", "15m"), true);

  const switchedFull = gate.begin("NVDA", "1d", "full");
  assert.equal(full.signal.aborted, true);
  assert.equal(gate.isCurrent(switchedFull, "NVDA", "1d"), true);
  gate.finish(switchedFull);
  const poll = gate.begin("512480.SS", "15m", "incremental");
  const nextFull = gate.begin("NVDA", "1d", "full");
  assert.equal(poll.signal.aborted, true);
  assert.equal(gate.isCurrent(poll, "512480.SS", "15m"), false);
  assert.equal(gate.isCurrent(nextFull, "NVDA", "1h"), false);
  assert.equal(gate.isCurrent(nextFull, "NVDA", "1d"), true);
});

test("feed filtering supports symbol, source hierarchy, and minimum importance", () => {
  const items = [
    { symbol: "NVDA", source: "sec", importance: "high" },
    { symbol: "NVDA", source: "reuters", importance: "medium" },
    { symbol: "TSM", source: "reuters", importance: "critical" },
  ];
  assert.deepEqual(
    filterFeedItems(items, { symbol: "NVDA", source: "sec", importance: "medium" }),
    [items[0]],
  );
  assert.deepEqual(
    filterFeedItems(items, { symbol: "all", source: "reuters", importance: "high" }),
    [items[2]],
  );
});

test("next-run calculation uses enabled profile timezone schedule without inventing results", () => {
  const profile = {
    enabled: true,
    timezone: "Asia/Shanghai",
    schedules: {
      preMarketBrief: { enabled: true, time: "08:25" },
      closeDeepAnalysis: { enabled: true, time: "15:20" },
      usCloseSnapshot: { enabled: false, time: "05:35" },
    },
  };
  const next = computeNextRun(profile, new Date("2026-07-23T01:00:00.000Z"));
  assert.equal(next.label, "收盘深度分析");
  assert.match(next.at, /^2026-07-23T07:20:00/);
});

test("mobile layout switches usable regions instead of shrinking the desktop grid", () => {
  assert.match(html, /class="mobile-nav"/);
  assert.match(html, /data-mobile-section="watch"/);
  assert.match(html, /data-mobile-section="chart"/);
  assert.match(html, /data-mobile-section="feed"/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /body\[data-mobile-view="watch"\]/);
  assert.match(script, /setMobileView/);
});

test("chart uses vendored Lightweight Charts 5.2.0 with panes, axes, and incremental series updates", () => {
  const vendorUrl = new URL("../public/vendor/lightweight-charts.production.mjs", import.meta.url);
  const licenseUrl = new URL("../public/vendor/LICENSE-lightweight-charts", import.meta.url);
  const noticeUrl = new URL("../public/vendor/NOTICE-lightweight-charts", import.meta.url);
  assert.equal(existsSync(vendorUrl), true);
  assert.equal(existsSync(licenseUrl), true);
  assert.equal(existsSync(noticeUrl), true);
  assert.match(script, /lightweight-charts\.production\.mjs/);
  assert.match(script, /createChart/);
  assert.match(script, /addSeries\([^)]*,[^)]*,\s*1\)/);
  assert.match(script, /addSeries\([^)]*,[^)]*,\s*2\)/);
  assert.match(`${script}\n${dataScript}`, /\.update\(/);
  assert.doesNotMatch(script, /attributionLogo\s*:\s*false/);
});

test("scheduled refresh updates selected bars, watch quotes, feeds, and monitor without reloading the page", () => {
  assert.match(script, /function pollWorkbenchData/);
  assert.match(script, /loadMarket\(\{\s*incremental:\s*true\s*\}\)/);
  assert.match(script, /loadQuoteStrip\(\)/);
  assert.match(script, /loadFeeds\(\)/);
  assert.match(script, /loadMonitor\(\)/);
  assert.doesNotMatch(script, /location\.reload/);
});

test("US drivers use daily data for quote strips and switch to the available daily chart", () => {
  assert.match(script, /market === "US" \? "1d" : state\.timeframe/);
  assert.match(script, /target\?\.market === "US" && state\.timeframe !== "1d"/);
  assert.match(script, /state\.timeframe = "1d"/);
  assert.equal(dailyHistoryLimit("6m"), 126);
  assert.equal(dailyHistoryLimit("1y"), 252);
  assert.equal(dailyHistoryLimit("3y"), 756);
  assert.equal(dailyHistoryLimit("5y"), 1260);
  assert.equal(dailyHistoryLimit("unknown"), 1260);
  for (const range of ["6m", "1y", "3y", "5y"]) {
    assert.match(html, new RegExp(`data-history-range="${range}"`));
  }
  assert.match(html, /id="chart-coverage"/);
});

test("A-share ETF daily charts use the same range controls and coverage summary", () => {
  assert.match(
    script,
    /const isDaily = state\.timeframe === "1d"/,
  );
  assert.match(
    script,
    /const fullLimit = timeframe === "1d"\s*\?\s*dailyHistoryLimit\(state\.historyRange\)/,
  );
  assert.match(script, /history-range-tabs"\)\.hidden = !isDaily/);
  assert.match(script, /if \(isDaily && bars\.length\)/);
});

test("task timeline never maps source health rows to schedule slots by array position", () => {
  assert.equal(typeof workbenchData.buildTaskTimeline, "function");
  const profile = {
    schedules: {
      usCloseSnapshot: { enabled: true, time: "05:35" },
      preMarketBrief: { enabled: true, time: "08:25" },
      cnIntraday: { enabled: true, windows: [{ start: "09:30", end: "11:30" }] },
      closeDeepAnalysis: { enabled: true, time: "15:20" },
    },
  };
  const timeline = workbenchData.buildTaskTimeline(profile, [
    { source: "yahoo", status: "ok", detail: "healthy" },
  ]);
  assert.equal(timeline.length, 4);
  assert.equal(timeline.every((item) => item.status === "pending"), true);
  assert.equal(timeline.every((item) => item.detail === "任务结果接口未提供"), true);
});

test("current-symbol conclusion never falls back to a different symbol", () => {
  assert.equal(typeof workbenchData.selectConclusion, "function");
  const latest = { results: [{ ticker: "NVDA", rating: "Buy" }] };
  assert.equal(workbenchData.selectConclusion(latest, "515880.SS"), null);
  assert.equal(workbenchData.selectConclusion(latest, "NVDA"), latest.results[0]);
});

test("chat keeps persistent local threads and streams SSE with history context", () => {
  assert.match(script, /ta\.workbench\.threads\.v1/);
  assert.match(script, /function loadThreads/);
  assert.match(script, /function saveThreads/);
  assert.match(script, /history:\s*historyMessages/);
  assert.match(script, /requestId:\s*chatRequestId/);
  assert.match(script, /sessionId:\s*thread\.id/);
  assert.match(script, /profileId:\s*currentProfile\?\.id/);
  assert.match(script, /symbol:\s*state\.selectedSymbol/);
  assert.match(script, /x-request-id/);
  assert.match(script, /function recoverThread/);
  assert.match(script, /\/api\/chat-sessions\?sessionId=/);
  assert.match(script, /function recoverChatRequest/);
  assert.match(script, /stream:\s*true/);
  assert.match(script, /response\.body\.getReader\(\)/);
  assert.match(script, /event\s*===\s*"delta"/);
  assert.match(html, /id="thread-select"/);
  assert.match(html, /id="new-thread"/);
  assert.match(html, /id="delete-thread"/);
});

test("chat history excludes failed messages and local thread compaction enforces hard bounds", () => {
  const history = buildChatHistory([
    { role: "user", content: "正常问题" },
    { role: "assistant", content: "网络错误", error: true },
    { role: "assistant", content: "正常回答" },
  ]);
  assert.deepEqual(history, [
    { role: "user", content: "正常问题" },
    { role: "assistant", content: "正常回答" },
  ]);

  const threads = compactThreads([
    {
      id: "a", title: "A", updatedAt: "2026-07-24T00:00:00.000Z",
      messages: Array.from({ length: 6 }, (_, index) => ({
        id: `a${index}`, role: "user", content: "12345",
        at: `2026-07-24T00:00:0${index}.000Z`,
      })),
    },
    {
      id: "b", title: "B", updatedAt: "2026-07-23T00:00:00.000Z",
      messages: [{ id: "b1", role: "assistant", content: "12345", at: "2026-07-23T00:00:00.000Z" }],
    },
  ], {
    maxThreads: 2,
    maxMessagesPerThread: 4,
    maxCharsPerThread: 12,
    maxMessagesTotal: 4,
    maxCharsTotal: 12,
  });
  assert.equal(threads.length, 2);
  assert.equal(threads.flatMap(({ messages }) => messages).length <= 4, true);
  assert.equal(threads.flatMap(({ messages }) => messages).reduce((sum, message) => sum + message.content.length, 0) <= 12, true);
  assert.equal(threads[0].messages.length <= 4, true);
});

test("market rendering replays every changed point and storage quota failures are contained", () => {
  assert.match(dataScript, /for\s*\(let index = changedFromIndex; index < length; index \+= 1\)/);
  assert.match(script, /marketRequestGate\.begin\(symbol,\s*timeframe,\s*incremental\s*\?\s*"incremental"\s*:\s*"full"\)/);
  assert.match(script, /marketRequestGate\.isCurrent\(request,\s*state\.selectedSymbol,\s*state\.timeframe\)/);
  assert.match(script, /state\.chart\.hydrated/);
  assert.match(script, /catch\s*\(error\)\s*\{[\s\S]*本地会话无法继续持久化/);
});

test("mobile chart view keeps cross-market drivers accessible", () => {
  assert.doesNotMatch(css, /\.driver-deck\s*\{\s*display:\s*none/);
  assert.match(css, /body\[data-mobile-view="watch"\]\s+\.driver-deck/);
});

test("settings expose every schedule and PushPlus switch plus local credential clearing", () => {
  for (const id of [
    "enable-us-close", "enable-premarket", "enable-intraday", "enable-close-analysis",
    "alert-pushplus", "clear-credential",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function clearCredential/);
  assert.match(script, /localStorage\.removeItem\(STORAGE\.deviceKey\)/);
});

test("options risk and multi-agent analysis are first-class workspaces", () => {
  assert.match(html, /href="#agents"[^>]*data-route-link="agents"/);
  assert.match(html, /href="#options"[^>]*data-route-link="options"/);
  assert.match(html, /data-workspace="agents"/);
  assert.match(html, /data-workspace="options"/);
  assert.match(html, /id="deep-analysis-open"[^>]*>发起多智能体分析</);
  assert.match(html, /id="options-risk-metrics"/);
  assert.match(html, /id="options-exposure-metrics"/);
  assert.match(html, /id="options-chain"/);
  assert.match(script, /#deep-analysis-open/);
  assert.match(script, /filter\(\(\{ analysis \}\) => analysis === "full"\)/);
});

test("market direction follows A-share and US conventions without changing health colors", () => {
  assert.match(css, /--market-up:\s*#e05f68/);
  assert.match(css, /--market-down:\s*#38b788/);
  assert.match(css, /--us-market-up:\s*#38b788/);
  assert.match(css, /--us-market-down:\s*#e05f68/);
  assert.match(css, /\.market-up\s*\{\s*color:\s*var\(--market-up\)/);
  assert.match(css, /\.market-down\s*\{\s*color:\s*var\(--market-down\)/);
  assert.match(css, /\.us-market-up\s*\{\s*color:\s*var\(--us-market-up\)/);
  assert.match(css, /\.us-market-down\s*\{\s*color:\s*var\(--us-market-down\)/);
  assert.match(script, /function marketTone\(change,\s*market\)/);
  assert.match(script, /function marketPalette\(market\)/);
  assert.match(script, /series\.candles\.applyOptions/);
  assert.match(css, /--positive:\s*#38b788/);
  assert.match(css, /--negative:\s*#e05f68/);
});
