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
  dailyQuoteFromBars,
  dailyHistoryLimit,
  filterFeedItems,
  groupFeedItems,
  marketSessionStates,
  mergeIncrementalBatch,
  mergeIncrementalBars,
  normalizeEnvelope,
  notificationDeliveryBadges,
} = workbenchData;

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/assets/workbench.css", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/assets/workbench.js", import.meta.url), "utf8");
const dataScript = readFileSync(new URL("../public/assets/workbench-data.mjs", import.meta.url), "utf8");
const profilesScript = readFileSync(new URL("../public/assets/workbench-profiles.mjs", import.meta.url), "utf8");

test("research terminal exposes the continuous three-column workspace and indicator panes", () => {
  assert.match(html, /class="research-layout"/);
  assert.match(html, /id="watchlist"/);
  assert.match(html, /id="task-timeline"/);
  assert.match(html, /id="market-chart"/);
  assert.match(html, /id="macd-chart"/);
  assert.match(html, /id="rsi-chart"/);
  assert.match(html, /id="research-feed"/);
  assert.match(html, /id="cross-market-drivers"/);
  assert.match(html, /最新 \/ 日涨跌/);
  assert.match(html, /data-timeframe="5m"/);
  assert.match(html, /data-timeframe="15m"/);
  assert.match(html, /data-timeframe="1h"/);
  assert.match(html, /data-timeframe="1d"/);
});

test("default universe contains the full ETF and semiconductor driver set", () => {
  assert.deepEqual(
    DEFAULT_TARGETS.map(({ symbol }) => symbol),
    ["515880.SS", "512480.SS", "159995.SZ", "SOXX", "SMH", "NVDA", "TSM", "AVGO", "AMD", "ASML", "ORCL", "GOOGL", "3887.HK"],
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
  assert.match(html, /id="enable-news-refresh"/);
  assert.match(html, /id="news-refresh-interval"/);
  assert.match(script, /profile\.schedules\.newsRefresh\.intervalMinutes/);
});

test("watch quotes always use daily bars while chart navigation keeps its own timeframe", () => {
  assert.match(script, /marketUrl\(symbol, "1d", profileId, 2\)/);
  assert.match(script, /marketUrl\(symbol, "5m", profileId, 1\)/);
  assert.match(script, /dailyQuoteFromBars\(dailyEnvelope\.data, \{[\s\S]*currentBar: intradayBar/);
  assert.doesNotMatch(script, /market === "CN" \? state\.timeframe : "1d"/);
  assert.match(script, /state\.quotes\.get\(target\.symbol\)\?\.change/);
  assert.match(script, /if \(timeframe === "1d"\)/);
  assert.match(script, /target\?\.market !== "CN" && state\.timeframe !== "1d"/);
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

test("daily watch quote computes day-over-day change even when rows arrive newest first", () => {
  const quote = dailyQuoteFromBars([
    { ts: "2026-07-28T00:00:00Z", close: 1.04 },
    { ts: "2026-07-27T00:00:00Z", close: 1.124 },
  ]);
  assert.equal(quote.close, 1.04);
  assert.equal(quote.ts, "2026-07-28T00:00:00Z");
  assert.ok(Math.abs(quote.change - (-7.473309608540935)) < 1e-12);
  assert.equal(dailyQuoteFromBars([{ ts: "2026-07-28T00:00:00Z", close: 1.04 }]).change, null);

  const precise = dailyQuoteFromBars([
    { ts: "2026-07-27T16:00:00Z", close: 1.04 },
    { ts: "2026-07-26T16:00:00Z", close: 1.124 },
  ], {
    currentBar: { ts: "2026-07-28T07:00:00Z", close: 1.041 },
    tradingDate: (value) => new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
  });
  assert.equal(precise.close, 1.041);
  assert.ok(Math.abs(precise.change - (-7.384341637010672)) < 1e-12);

  const staleIntraday = dailyQuoteFromBars([
    { ts: "2026-07-27T16:00:00Z", close: 1.04 },
    { ts: "2026-07-26T16:00:00Z", close: 1.124 },
  ], {
    currentBar: { ts: "2026-07-27T07:00:00Z", close: 1.03 },
    tradingDate: (value) => new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
  });
  assert.equal(staleIntraday.close, 1.04);
  assert.ok(Math.abs(staleIntraday.change - (-7.473309608540935)) < 1e-12);
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
  assert.equal(timeline.length, 5);
  assert.equal(timeline.every((item) => item.status === "pending"), true);
  assert.equal(timeline.every((item) => item.detail === "任务结果接口未提供"), true);
});

test("feed grouping collapses one article across related symbols and retains provenance", () => {
  const grouped = groupFeedItems([
    {
      type: "news",
      cluster_id: "cluster-same",
      symbol: "515880.SS",
      title: "同一篇新闻",
      url: "https://example.test/article",
      source: "东方财富",
      sourceTier: "discovery",
      importance: "medium",
      at: "2026-07-26T02:00:00Z",
    },
    {
      type: "news",
      cluster_id: "cluster-same",
      symbol: "512480.SS",
      title: "同一篇新闻",
      url: "https://example.test/article",
      source: "东方财富",
      sourceTier: "evidence",
      importance: "high",
      at: "2026-07-26T02:01:00Z",
    },
  ]);

  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].symbols, ["515880.SS", "512480.SS"]);
  assert.equal(grouped[0].sourceTier, "evidence");
  assert.equal(grouped[0].importance, "high");
  assert.equal(grouped[0].at, "2026-07-26T02:01:00Z");
  assert.deepEqual(
    filterFeedItems(grouped, { symbol: "512480.SS", source: "all", importance: "medium" }),
    grouped,
  );
});

test("feed grouping removes aggregator punctuation variants", () => {
  const grouped = groupFeedItems([
    { type: "news", symbol: "515880.SS", title: "芯片 行业：政策更新！", source: "A", at: "2026-07-26T02:00:00Z" },
    { type: "news", symbol: "512480.SS", title: "芯片行业-政策更新", source: "B", at: "2026-07-26T02:01:00Z" },
  ]);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].symbols, ["515880.SS", "512480.SS"]);
});

test("market session clock respects weekends and New York daylight saving time", () => {
  const sunday = marketSessionStates(new Date("2026-07-26T05:00:00Z"));
  assert.equal(sunday.CN.open, false);
  assert.equal(sunday.US.open, false);

  const monday = marketSessionStates(new Date("2026-07-27T14:00:00Z"));
  assert.equal(monday.CN.open, false);
  assert.equal(monday.US.open, true);
});

test("notification badges expose real shadow and failure state without claiming browser delivery", () => {
  assert.deepEqual(notificationDeliveryBadges([
    { channel: "web", status: "sent", reasonCode: "WEB_EVENT_PERSISTED" },
    { channel: "pushPlus", status: "skipped", reasonCode: "SHADOW_MODE" },
    { channel: "pushPlus", status: "deferred", reasonCode: "QUIET_HOURS" },
    { channel: "pushPlus", status: "failed", reasonCode: "PUSHPLUS_HTTP_500" },
    { channel: "pushPlus", status: "uncertain", reasonCode: "PUSHPLUS_TIMEOUT" },
  ]), [
    { tone: "ok", text: "网页可见" },
    { tone: "muted", text: "PushPlus · SHADOW" },
    { tone: "muted", text: "PushPlus · 静默延期" },
    { tone: "negative", text: "PushPlus · 失败" },
    { tone: "warning", text: "PushPlus · 结果不确定" },
  ]);
  assert.doesNotMatch(
    notificationDeliveryBadges([
      { channel: "web", status: "sent", reasonCode: "WEB_EVENT_PERSISTED" },
    ])[0].text,
    /系统通知|浏览器通知|已推送/,
  );
  assert.match(script, /notificationDeliveryBadges\(item\.deliveries\)/);
});

test("disabled profiles expose no pending scheduled work", () => {
  const timeline = workbenchData.buildTaskTimeline({
    enabled: false,
    schedules: {
      usCloseSnapshot: { enabled: true, time: "05:35" },
      preMarketBrief: { enabled: true, time: "08:25" },
      cnIntraday: { enabled: true, windows: [{ start: "09:30", end: "11:30" }] },
      closeDeepAnalysis: { enabled: true, time: "15:20" },
    },
  });
  assert.deepEqual(timeline, []);
  assert.match(script, /监控组已停用/);
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
  assert.match(script, /profileId:\s*profile\?\.id/);
  assert.match(script, /reportRequestId/);
  assert.doesNotMatch(script, /reportScope/);
  assert.match(script, /symbol:\s*state\.selectedSymbol/);
  assert.match(script, /x-request-id/);
  assert.match(script, /function recoverThread/);
  assert.match(script, /profileRequestUrl\("\/api\/chat-sessions"/);
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
  assert.match(script, /marketRequestGate\.begin\(requestContext,\s*timeframe,\s*incremental\s*\?\s*"incremental"\s*:\s*"full"\)/);
  assert.match(script, /marketContext\(currentProfile\(\)\?\.id,\s*state\.selectedSymbol\)/);
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

test("Agent workspace owns a temporary research form instead of opening monitor settings", () => {
  assert.match(html, /<form[^>]+id="agent-research-form"/);
  assert.match(html, /id="agent-research-tickers"/);
  assert.match(html, /id="agent-research-depth"/);
  assert.match(html, /id="agent-research-code"/);
  assert.match(html, /name="agent-analyst"[^>]+value="market"[^>]+checked/);
  assert.match(html, /name="agent-analyst"[^>]+value="news"[^>]+checked/);
  assert.match(html, /name="agent-analyst"[^>]+value="fundamentals"[^>]+checked/);
  const form = /<form[^>]+id="agent-research-form"[\s\S]*?<\/form>/.exec(html)?.[0] || "";
  assert.doesNotMatch(form, /value="(?:social|sentiment)"/);
  assert.match(script, /function submitTemporaryResearch/);
  assert.match(script, /buildTemporaryResearchRequest/);
  assert.match(script, /x-request-id/);
  assert.match(script, /requestId/);
  assert.match(script, /researchDepth/);
  const submitter = /async function submitTemporaryResearch[\s\S]*?\n  \}/.exec(script)?.[0] || "";
  assert.match(submitter, /\/api\/analyze/);
  assert.doesNotMatch(submitter, /\/api\/settings|method:\s*"PUT"|collectSettingsForm/);
  assert.doesNotMatch(script, /#deep-analysis-open"\)\.addEventListener\("click",\s*openDeepAnalysis/);
});

test("settings and task workspaces retain the configured monitor combination run", () => {
  assert.match(html, /id="run-analysis"[^>]*>立即运行</);
  assert.match(html, /id="tasks-run-now"[^>]*>立即运行</);
  assert.match(script, /#run-analysis"\)\.addEventListener\("click",\s*runAnalysis/);
  assert.match(script, /#tasks-run-now"\)\.addEventListener\("click",\s*runAnalysis/);
});

test("report archive uses the audit index and visibly labels unverified evidence", () => {
  assert.match(script, /\/api\/report-audit/);
  assert.match(script, /auditStatus/);
  assert.match(script, /invalidated/);
  assert.match(html, /历史审计/);
});

test("report archive exposes ordered file tabs with a persistent audit warning", () => {
  assert.match(html, /id="archive-report-tabs"/);
  assert.match(html, /id="archive-report-warning"/);
  assert.match(
    html,
    /id="archive-report-warning"[\s\S]*id="archive-report-tabs"[\s\S]*id="archive-report-body"/,
  );
  assert.match(script, /buildArchiveFileTabs/);
  assert.match(script, /defaultArchiveFileTab/);
  assert.match(script, /selectedReportSection/);
  assert.match(script, /reportSection:\s*state\.selectedReportSection/);
  assert.match(css, /\.archive-report-tabs[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.archive-report-tabs[^}]*white-space:\s*nowrap/);
});

test("market direction follows A-share and US/Hong Kong conventions without changing health colors", () => {
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
  assert.equal(
    (script.match(/\["US",\s*"HK"\]\.includes\(market\)/g) || []).length,
    2,
  );
  assert.match(script, /series\.candles\.applyOptions/);
  assert.match(css, /--positive:\s*#38b788/);
  assert.match(css, /--negative:\s*#e05f68/);
});

test("drawers move focus before becoming hidden and keep closed controls inert", () => {
  assert.match(html, /id="settings-drawer"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(html, /id="assistant"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(script, /drawerFocusReturn\s*=\s*new WeakMap/);
  assert.match(script, /drawerElement\.inert\s*=\s*false/);
  assert.match(
    script,
    /drawerElement\.contains\(document\.activeElement\)[\s\S]*?returnTarget\.focus\(\)[\s\S]*?drawerElement\.setAttribute\("aria-hidden",\s*"true"\)/,
  );
  assert.match(script, /drawerElement\.inert\s*=\s*true/);
  assert.match(script, /function trapDrawerFocus/);
  assert.match(script, /setBackgroundInert/);
});

test("one selected profile drives every profile-scoped view and request", () => {
  assert.match(script, /selectedProfileId/);
  assert.match(script, /function currentProfile\(\)/);
  assert.match(script, /localStorage\.setItem\(STORAGE\.selectedProfileId/);
  assert.doesNotMatch(script, /profiles\?\.\[0\]|profiles\[0\]/);
  assert.doesNotMatch(script, /\.find\(\(profile\) => profile\.enabled\)/);
  assert.match(script, /marketUrl\(symbol,\s*timeframe,\s*currentProfile\(\)\?\.id/);
  assert.match(script, /profileRequestUrl\("\/api\/news",\s*profileId/);
  assert.match(script, /profileRequestUrl\("\/api\/events",\s*profileId/);
  assert.match(script, /profileRequestUrl\("\/api\/monitor-status",\s*profileId/);
  assert.match(script, /profileId:\s*currentProfile\(\)\?\.id/);
  assert.match(script, /profileId:\s*profile\.id/);
});

test("settings expose profile CRUD, server conflict recovery, and documented limits", () => {
  for (const id of [
    "profile-selector",
    "settings-profile-selector",
    "new-profile-id",
    "new-profile-name",
    "profile-create",
    "profile-copy",
    "profile-delete",
    "settings-reload-remote",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /最多 8 组/);
  assert.match(html, /每组最多 14 个标的/);
  assert.match(script, /\/api\/settings\/profiles/);
  assert.match(script, /expectedUpdatedAt:\s*state\.settingsUpdatedAt/);
  assert.match(script, /"PATCH"/);
  assert.match(script, /method:\s*"DELETE"/);
  assert.match(script, /\/copy/);
  assert.match(script, /重新载入远端/);
  assert.match(profilesScript, /PROFILE_LIMIT\s*=\s*8/);
  assert.match(profilesScript, /TARGET_LIMIT\s*=\s*14/);
});

test("settings fail closed without a live revision and expose degraded read-only recovery", () => {
  assert.doesNotMatch(script, /function ensureSettings/);
  assert.match(script, /settingsSnapshotFromPayload/);
  assert.match(script, /settingsMode:\s*"loading"/);
  assert.match(script, /settingsWritable:\s*false/);
  assert.match(script, /静态灾备快照/);
  assert.match(script, /远端监控配置不可用/);
  assert.match(script, /if\s*\(!state\.settingsWritable\s*\|\|\s*!state\.settingsUpdatedAt\)/);
  assert.match(script, /settings-reload-remote/);
});

test("profile-scoped resources share one abortable generation gate", () => {
  for (const channel of ["feeds", "monitor", "latest", "research", "report"]) {
    assert.match(script, new RegExp(`profileRequests\\.begin\\("${channel}"`));
  }
  assert.match(script, /profileRequests\.activate\(state\.selectedProfileId\)/);
  assert.match(script, /profileRequests\.isCurrent\(request\)/);
  assert.match(script, /\{\s*signal:\s*request\.signal\s*\}/);
  assert.match(script, /applyMutationPayload/);
  assert.match(script, /selectionChanged/);
});

test("settings error mapping distinguishes revision conflicts and keeps failed refresh retryable", () => {
  assert.match(script, /isSettingsRevisionConflict\(error\)/);
  assert.match(script, /重新载入失败/);
  assert.match(script, /settings-reload-remote"\)\.hidden\s*=\s*false/);
});

test("target editor accepts A-share, Hong Kong, and US symbols with explicit market mapping", () => {
  assert.match(script, /请输入支持的 A 股、港股或美股代码/);
  assert.match(script, /marketForProfileTarget\(symbol\)/);
  assert.doesNotMatch(script, /symbol\.includes\("\.S"\)\s*\?\s*"CN"\s*:\s*"US"/);
});

test("profile switches reset scoped state without rebuilding VolGuard or temporary research", () => {
  assert.match(script, /resetProfileContext/);
  assert.match(script, /async function selectProfile/);
  assert.match(script, /createThread\([^)]*profile/);
  assert.doesNotMatch(script, /state\.options\s*=\s*normalizeVolguardPayload\(null\)[\s\S]*selectProfile/);
  assert.doesNotMatch(script, /agent-research-form"\)\.reset/);
  assert.doesNotMatch(profilesScript, /options:\s*null/);
  assert.doesNotMatch(profilesScript, /pendingResearch:\s*null/);
  assert.match(script, /const requestId = state\.pendingResearch\.requestId/);
  assert.match(script, /\/api\/history/);
  assert.match(script, /\/api\/runs/);
});

test("temporary research owns independent history and run state", () => {
  assert.match(script, /adhocHistory:\s*\[\]/);
  assert.match(script, /adhocRuns:\s*\[\]/);
  assert.match(script, /function loadPendingResearchWorkspace/);
  assert.match(script, /profileRequestUrl\("\/api\/history",\s*null,\s*\{\s*requestId/);
  assert.match(script, /profileRequestUrl\("\/api\/runs",\s*null,\s*\{\s*requestId/);
  const agentRenderer = /function renderAgentWorkspace\(\)[\s\S]*?\n  \}/.exec(script)?.[0] || "";
  assert.match(agentRenderer, /state\.adhocHistory/);
  assert.match(agentRenderer, /state\.adhocRuns/);
  assert.doesNotMatch(agentRenderer, /archivedResearchForRequest\(state\.history/);
  assert.doesNotMatch(agentRenderer, /researchRunForRequest\(state\.runs/);
});

test("report loading never bypasses identity-aware API errors", () => {
  const reportLoader = /async function fetchReportText[\s\S]*?\n  \}/.exec(script)?.[0] || "";
  assert.match(reportLoader, /buildArchiveReportUrl/);
  assert.doesNotMatch(reportLoader, /path\.replace|fetch\(\s*`\/\$\{/);
});

test("latest report and chat resolve archives by path plus identity selector", () => {
  assert.match(script, /latestReportIdentity/);
  assert.match(script, /archiveEntriesMatch/);
  assert.doesNotMatch(
    script,
    /state\.archiveEntries\.find\(\(\{\s*report\s*\}\)\s*=>\s*report\s*===\s*state\.latestReport\)/,
  );
  assert.doesNotMatch(script, /state\.latestReport\s*=\s*entry\.report/);
});

test("refresh-all reports settled and response statuses instead of unconditional success", () => {
  const refresher = /async function refreshAll\(\)[\s\S]*?\n  \}/.exec(script)?.[0] || "";
  assert.match(refresher, /Promise\.allSettled/);
  assert.match(refresher, /fulfilled/);
  assert.match(refresher, /rejected/);
  assert.match(refresher, /status/);
  assert.doesNotMatch(refresher, /toast\("数据核验完成"\)/);
});

test("threads load only after settings restore the selected profile", () => {
  const initBody = /async function init\(\) \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  init/.exec(script)?.[1] || "";
  assert.ok(initBody);
  assert.ok(initBody.indexOf("await loadSettings()") < initBody.indexOf("loadThreads()"));
  assert.match(script, /profileId:\s*thread\.profileId \|\| profileId/);
});

test("mobile profile and target controls meet narrow-screen and keyboard contracts", () => {
  assert.match(css, /\.switch input:focus-visible \+ span/);
  assert.match(css, /@media\s*\(max-width:\s*420px\)[\s\S]*\.target-row/);
  assert.match(css, /min-height:\s*44px/);
});
