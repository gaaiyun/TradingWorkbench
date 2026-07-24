import {
  DEFAULT_TARGETS,
  applySeriesBatch,
  buildChatHistory,
  buildTaskTimeline,
  compactThreads,
  computeIndicators,
  computeNextRun,
  createLatestRequestGate,
  dailyHistoryLimit,
  filterFeedItems,
  mergeIncrementalBatch,
  normalizeEnvelope,
  selectConclusion,
} from "./workbench-data.mjs";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
} from "../vendor/lightweight-charts.production.mjs";
import {
  PRIMARY_ROUTES,
  normalizeRoute,
  routeHref,
} from "./workbench-router.mjs";
import {
  OPTIONS_FAST_REFRESH_MS,
  normalizeVolguardPayload,
} from "./workbench-options.mjs";
import {
  archivedResearchAfterRun,
  buildArchiveEntries,
  buildPipelineStages,
  latestResearchRun,
} from "./workbench-research.mjs";

(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const roleLabels = { core: "核心", comparison: "对比", driver: "驱动", benchmark: "基准" };
  const ratingLabels = { buy: "买入", overweight: "增持", hold: "持有", neutral: "中性", underweight: "减持", sell: "卖出" };
  const STORAGE = {
    sessionCode: "ta.workbench.access.session.v1",
    deviceKey: "ta.workbench.device-key.v1",
    encryptedCode: "ta.workbench.access.encrypted.v1",
    threads: "ta.workbench.threads.v1",
  };
  const state = {
    settings: null,
    settingsUpdatedAt: null,
    selectedSymbol: "515880.SS",
    timeframe: "15m",
    historyRange: "5y",
    market: normalizeEnvelope(null),
    quotes: new Map(),
    feeds: [],
    feedEnvelope: normalizeEnvelope(null),
    monitor: normalizeEnvelope(null),
    latest: null,
    history: [],
    runs: [],
    archiveEntries: [],
    selectedReportPath: null,
    selectedReportContent: "",
    accessCode: "",
    rememberCode: false,
    chart: { bars: [], api: null, series: null, symbol: null, timeframe: null, hydrated: false },
    indicators: { volume: true, ma20: true, ma60: true },
    chatBusy: false,
    latestReport: null,
    threads: [],
    threadId: null,
    threadStorageWarningShown: false,
    options: normalizeVolguardPayload(null),
    optionsNextAt: null,
  };
  const marketRequestGate = createLatestRequestGate();

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function inlineMarkdown(raw) {
    const links = [];
    let text = String(raw || "").replace(/\[([^\]]+)]\(([^)]+)\)/g, (_match, label, href) => {
      const url = safeUrl(href);
      if (!url) return label;
      const token = `\u0000L${links.length}\u0000`;
      links.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
      return token;
    });
    text = escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
    links.forEach((link, index) => { text = text.replace(`\u0000L${index}\u0000`, link); });
    return text;
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown || "").replaceAll("\r\n", "\n").split("\n");
    const output = [];
    let paragraph = [];
    let list = null;
    let code = false;
    let codeLines = [];
    const flush = () => {
      if (paragraph.length) output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (list) output.push(`</${list}>`);
      list = null;
    };
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        flush(); closeList();
        if (code) { output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`); codeLines = []; }
        code = !code; continue;
      }
      if (code) { codeLines.push(line); continue; }
      if (!line.trim()) { flush(); closeList(); continue; }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) { flush(); closeList(); output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); continue; }
      const item = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (item) {
        flush();
        if (list !== "ul") { closeList(); output.push("<ul>"); list = "ul"; }
        output.push(`<li>${inlineMarkdown(item[1])}</li>`); continue;
      }
      paragraph.push(line.trim());
    }
    if (codeLines.length) output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    flush(); closeList();
    return output.join("");
  }

  function plainText(value, limit = 280) {
    const text = String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/[#*_`>~-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
  }

  function formatTime(value, full = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: state.settings?.profiles?.[0]?.timezone || "Asia/Shanghai",
      ...(full ? { month: "2-digit", day: "2-digit" } : {}),
      hour: "2-digit", minute: "2-digit", second: full ? "2-digit" : undefined, hour12: false,
    }).format(date);
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: state.settings?.profiles?.[0]?.timezone || "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }

  function formatNumber(value, digits = 3) {
    const number = Number(value);
    return Number.isFinite(number)
      ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(number)
      : "—";
  }

  function formatVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    if (Math.abs(number) >= 1e8) return `${(number / 1e8).toFixed(2)}亿`;
    if (Math.abs(number) >= 1e4) return `${(number / 1e4).toFixed(1)}万`;
    return formatNumber(number, 0);
  }

  function marketTone(change, market) {
    if (!Number.isFinite(Number(change))) return "neutral";
    if (market === "US") return Number(change) >= 0 ? "us-market-up" : "us-market-down";
    return Number(change) >= 0 ? "market-up" : "market-down";
  }

  function marketPalette(market) {
    return market === "US"
      ? {
        up: "#38b788",
        down: "#e05f68",
        upSoft: "#38b78855",
        downSoft: "#e05f6855",
        upHistogram: "#38b78877",
        downHistogram: "#e05f6877",
      }
      : {
        up: "#e05f68",
        down: "#38b788",
        upSoft: "#e05f6855",
        downSoft: "#38b78855",
        upHistogram: "#e05f6877",
        downHistogram: "#38b78877",
      };
  }

  function toast(message, error = false) {
    const node = document.createElement("div");
    node.className = `toast${error ? " is-error" : ""}`;
    node.textContent = message;
    $("#toast-region").append(node);
    setTimeout(() => node.remove(), 3600);
  }

  async function requestJson(url, init = {}) {
    const response = await fetch(url, { cache: "no-store", ...init });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty response */ }
    if (!response.ok) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function targets() {
    return state.settings?.profiles?.find((profile) => profile.enabled)?.targets || DEFAULT_TARGETS;
  }

  function settingsTickers(settings) {
    const primaryProfile = (settings?.profiles || []).find((profile) => profile.enabled);
    if (!primaryProfile) return Array.isArray(settings?.tickers) ? settings.tickers : [];
    return (primaryProfile.targets || [])
      .filter((target) => target.analysis === "full")
      .map((target) => target.symbol);
  }

  function renderSettingsSummary() {
    const profile = state.settings?.profiles?.[0];
    if (!profile) return;
    const fullAnalysisTickers = settingsTickers(state.settings);
    $("#watchlist-count").title = `深度分析 ${fullAnalysisTickers.length} 个`;
    $("#profile-enabled").checked = profile.enabled;
    $("#profile-name").value = profile.name || "";
    $("#profile-objective").value = profile.objective || "";
    $("#profile-timezone").value = profile.timezone || "Asia/Shanghai";
    $("#enable-us-close").checked = profile.schedules?.usCloseSnapshot?.enabled !== false;
    $("#schedule-us-close").value = profile.schedules?.usCloseSnapshot?.time || "05:35";
    $("#enable-premarket").checked = profile.schedules?.preMarketBrief?.enabled !== false;
    $("#schedule-premarket").value = profile.schedules?.preMarketBrief?.time || "08:25";
    $("#enable-close-analysis").checked = profile.schedules?.closeDeepAnalysis?.enabled !== false;
    $("#schedule-close").value = profile.schedules?.closeDeepAnalysis?.time || "15:20";
    $("#enable-intraday").checked = profile.schedules?.cnIntraday?.enabled !== false;
    $("#window-am-start").value = profile.schedules?.cnIntraday?.windows?.[0]?.start || "09:30";
    $("#window-am-end").value = profile.schedules?.cnIntraday?.windows?.[0]?.end || "11:30";
    $("#window-pm-start").value = profile.schedules?.cnIntraday?.windows?.[1]?.start || "13:00";
    $("#window-pm-end").value = profile.schedules?.cnIntraday?.windows?.[1]?.end || "15:00";
    $("#collection-interval").value = String(profile.schedules?.cnIntraday?.collectionIntervalMinutes || 5);
    $("#signal-interval").value = String(profile.schedules?.cnIntraday?.signalIntervalMinutes || 15);
    $("#alert-severity").value = profile.alerts?.pushMinSeverity || "high";
    $("#quiet-start").value = profile.alerts?.quietHours?.start || "22:30";
    $("#quiet-end").value = profile.alerts?.quietHours?.end || "07:30";
    $("#alert-web").checked = profile.alerts?.channels?.web !== false;
    $("#alert-pushplus").checked = profile.alerts?.channels?.pushPlus !== false;
    renderTargetEditor();
    renderWatchlist();
    renderNextRun();
    renderTimeline();
    renderTaskBoard();
    renderAgentWorkspace();
    renderSettingsWorkspace();
  }

  function ensureSettings() {
    if (state.settings?.profiles?.length) return;
    state.settings = {
      version: 2,
      profiles: [{
        id: "cn-semi-comms",
        name: "A 股通信与半导体 ETF 传导监控",
        objective: "持续监控美股半导体、政策与流动性变化对 A 股 ETF 的传导影响。",
        enabled: true,
        timezone: "Asia/Shanghai",
        targets: structuredClone(DEFAULT_TARGETS),
        systemBenchmarks: [
          { id: "csi-300", name: "沪深300", market: "CN" },
          { id: "nasdaq-100", name: "纳指100", market: "US" },
          { id: "usd-cny", name: "美元人民币", market: "FX" },
        ],
        schedules: {
          usCloseSnapshot: { enabled: true, time: "05:35" },
          preMarketBrief: { enabled: true, time: "08:25" },
          cnIntraday: { enabled: true, windows: [{ start: "09:30", end: "11:30" }, { start: "13:00", end: "15:00" }], collectionIntervalMinutes: 5, signalIntervalMinutes: 15 },
          closeDeepAnalysis: { enabled: true, time: "15:20" },
        },
        alerts: { channels: { web: true, pushPlus: true }, pushMinSeverity: "high", quietHours: { start: "22:30", end: "07:30" } },
        agentBudget: { intradayLightSummariesPerDay: 3, fullAnalysesPerDay: 1 },
      }],
    };
  }

  function renderWatchlist() {
    const list = targets();
    $("#watchlist-count").textContent = `${list.length} 标的`;
    $("#feed-symbol").innerHTML = '<option value="all">全部标的</option>' + list
      .map((target) => `<option value="${escapeHtml(target.symbol)}">${escapeHtml(target.symbol)}</option>`).join("");
    $("#watchlist").innerHTML = list.map((target) => {
      const quote = state.quotes.get(target.symbol);
      const change = quote && Number.isFinite(Number(quote.change)) ? Number(quote.change) : null;
      const tone = marketTone(change, target.market);
      return `<button class="watch-row ${target.symbol === state.selectedSymbol ? "is-active" : ""}" type="button" role="option" aria-selected="${target.symbol === state.selectedSymbol}" data-symbol="${escapeHtml(target.symbol)}">
        <span class="watch-main"><span class="role-mark">${escapeHtml(roleLabels[target.role] || target.role)}</span><span><strong>${escapeHtml(target.symbol)}</strong><small>${escapeHtml(target.name || target.market)}</small></span></span>
        <span class="watch-quote"><b>${formatNumber(quote?.close)}</b><small class="${tone}">${change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</small></span>
      </button>`;
    }).join("");
    $$("[data-symbol]", $("#watchlist")).forEach((button) => button.addEventListener("click", () => selectSymbol(button.dataset.symbol)));
  }

  function renderInstrument() {
    const target = targets().find((item) => item.symbol === state.selectedSymbol) || DEFAULT_TARGETS[0];
    const isUsDaily = target.market === "US";
    const bars = state.chart.bars;
    const bar = bars.at(-1);
    const previous = bars.at(-2);
    const change = bar && previous && Number(previous.close) !== 0 ? (Number(bar.close) / Number(previous.close) - 1) * 100 : null;
    $("#instrument-symbol").textContent = target.symbol;
    $("#instrument-name").textContent = `${target.name} · ${target.market === "CN" ? "A 股" : "US"}`;
    $("#instrument-role").textContent = roleLabels[target.role] || target.role;
    $("#instrument-price").textContent = formatNumber(bar?.close);
    $("#instrument-change").textContent = change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    $("#instrument-change").className = marketTone(change, target.market);
    $("#quote-open").textContent = formatNumber(bar?.open);
    $("#quote-high").textContent = formatNumber(bar?.high);
    $("#quote-low").textContent = formatNumber(bar?.low);
    $("#quote-volume").textContent = formatVolume(bar?.volume);
    $("#history-range-tabs").hidden = !isUsDaily;
    $$("[data-timeframe]").forEach((button) => {
      button.disabled = isUsDaily && button.dataset.timeframe !== "1d";
    });
    if (isUsDaily && bars.length) {
      const first = bars[0];
      const source = state.market.sources?.[0];
      const degraded = state.market.status === "degraded" || state.market.status === "stale";
      $("#chart-coverage").textContent = `覆盖 ${formatDate(first.ts)}–${formatDate(bar.ts)} · ${bars.length} 日${degraded ? ` · ${source?.source || "来源"}降级` : ""}`;
    } else {
      $("#chart-coverage").textContent = "覆盖 —";
    }
  }

  function updateFreshness(envelope) {
    const source = envelope.sources?.[0] || {};
    $("#freshness-status").textContent = envelope.status.toUpperCase();
    $("#freshness-status").dataset.status = envelope.status;
    $("#freshness-asof").textContent = formatTime(envelope.asOf, true);
    $("#freshness-fetched").textContent = formatTime(source.fetchedAt, true);
    $("#freshness-source").textContent = source.source || "—";
    $("#freshness-detail").textContent = envelope.error || `freshness ${source.freshness || "unknown"} · quality ${source.quality || "unknown"} · adjustment ${source.adjustment || "—"}`;
    const dot = $(".status-dot", $("#global-status"));
    dot.className = `status-dot is-${envelope.status}`;
    $("#global-status span").textContent = envelope.status === "ok" ? "数据正常" : envelope.status === "unavailable" ? "数据不可用" : `数据${envelope.status === "stale" ? "陈旧" : "降级"}`;
  }

  async function loadSettings() {
    try {
      const payload = await requestJson("/api/settings");
      const data = payload?.data && !payload.profiles ? payload.data : payload;
      state.settings = data;
      state.settingsUpdatedAt = data?.updatedAt ?? payload?.updatedAt ?? null;
    } catch {
      try {
        state.settings = await requestJson("./data/workbench-settings.json");
        state.settingsUpdatedAt = null;
      } catch {
        state.settings = null;
      }
    }
    ensureSettings();
    renderSettingsSummary();
  }

  function marketUrl(symbol, timeframe, limit = 240) {
    return `/api/market?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}`;
  }

  function sortBars(rows) {
    return rows.filter((bar) => bar?.ts).sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async function loadMarket({ incremental = false } = {}) {
    const symbol = state.selectedSymbol;
    const timeframe = state.timeframe;
    const contextChanged = state.chart.symbol !== symbol || state.chart.timeframe !== timeframe;
    if (incremental && (contextChanged || !state.chart.hydrated)) return;
    const request = marketRequestGate.begin(symbol, timeframe, incremental ? "incremental" : "full");
    if (!request) return;
    if (!incremental && contextChanged) {
      state.chart.symbol = symbol;
      state.chart.timeframe = timeframe;
      state.chart.hydrated = false;
      state.chart.bars = [];
      state.market = normalizeEnvelope(null);
      $("#chart-empty").hidden = false;
      renderInstrument();
      syncChartData({ strategy: "setData" });
    }
    let chartUpdate = { changedFromIndex: 0, strategy: "setData" };
    try {
      const target = targets().find((item) => item.symbol === symbol);
      const fullLimit = target?.market === "US" && timeframe === "1d"
        ? dailyHistoryLimit(state.historyRange)
        : 240;
      const envelope = normalizeEnvelope(await requestJson(
        marketUrl(symbol, timeframe, incremental ? 2 : fullLimit),
        { signal: request.signal },
      ));
      if (!marketRequestGate.isCurrent(request, state.selectedSymbol, state.timeframe)) return;
      state.market = envelope;
      const incoming = sortBars(envelope.data);
      if (incremental) {
        chartUpdate = mergeIncrementalBatch(state.chart.bars, incoming);
        state.chart.bars = chartUpdate.bars;
      } else {
        state.chart.bars = incoming;
        state.chart.hydrated = incoming.length > 0;
      }
      const last = state.chart.bars.at(-1);
      const prior = state.chart.bars.at(-2);
      if (last) state.quotes.set(symbol, { close: Number(last.close), change: prior ? (Number(last.close) / Number(prior.close) - 1) * 100 : null });
      updateFreshness(envelope);
    } catch (error) {
      if (request.signal.aborted || !marketRequestGate.isCurrent(request, state.selectedSymbol, state.timeframe)) return;
      state.market = normalizeEnvelope(null);
      if (!incremental) {
        state.chart.bars = [];
        state.chart.hydrated = false;
      }
      updateFreshness(state.market);
    } finally {
      marketRequestGate.finish(request);
    }
    if (!marketRequestGate.isCurrent(request, state.selectedSymbol, state.timeframe)) return;
    $("#chart-empty").hidden = state.chart.bars.length > 0;
    renderInstrument();
    renderWatchlist();
    syncChartData({
      strategy: chartUpdate.strategy,
      changedFromIndex: chartUpdate.changedFromIndex ?? 0,
      fitContent: !incremental,
    });
  }

  async function loadQuoteStrip() {
    const otherTargets = targets().filter(({ symbol }) => symbol !== state.selectedSymbol);
    await Promise.allSettled(otherTargets.map(async ({ symbol, market }) => {
      const quoteTimeframe = market === "US" ? "1d" : state.timeframe;
      const envelope = normalizeEnvelope(await requestJson(marketUrl(symbol, quoteTimeframe, 2)));
      const bars = sortBars(envelope.data);
      const last = bars.at(-1);
      const previous = bars.at(-2);
      if (last) state.quotes.set(symbol, { close: Number(last.close), change: previous ? (Number(last.close) / Number(previous.close) - 1) * 100 : null });
    }));
    renderWatchlist();
    renderDrivers();
  }

  function normalizeFeed(envelope, type) {
    return envelope.data.map((item) => ({
      ...item,
      type,
      at: item.published_at || item.event_at || item.as_of,
      summary: item.summary || item.description || "",
      importance: item.importance || (type === "event" ? "high" : "medium"),
      source: item.source || "unknown",
    }));
  }

  async function loadFeeds() {
    const profile = state.settings?.profiles?.[0]?.id;
    const suffix = profile ? `?profile=${encodeURIComponent(profile)}&limit=200` : "?limit=200";
    const [newsResult, eventsResult] = await Promise.allSettled([
      requestJson(`/api/news${suffix}`),
      requestJson(`/api/events${suffix}`),
    ]);
    const news = normalizeEnvelope(newsResult.status === "fulfilled" ? newsResult.value : null);
    const events = normalizeEnvelope(eventsResult.status === "fulfilled" ? eventsResult.value : null);
    state.feeds = [...normalizeFeed(news, "news"), ...normalizeFeed(events, "event")]
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    const statuses = [news.status, events.status];
    state.feedEnvelope = {
      status: statuses.every((status) => status === "unavailable") ? "unavailable" : statuses.includes("degraded") || statuses.includes("unavailable") ? "degraded" : statuses.includes("stale") ? "stale" : "ok",
      asOf: [news.asOf, events.asOf].filter(Boolean).sort().at(-1) || null,
      data: state.feeds,
      sources: [...news.sources, ...events.sources],
    };
    renderFeedFilters();
    renderFeed();
    renderNewsWorkspace();
  }

  function renderFeedFilters() {
    const selected = $("#feed-source").value;
    const sources = [...new Set(state.feeds.map((item) => item.source).filter(Boolean))].sort();
    $("#feed-source").innerHTML = '<option value="all">全部来源</option>' + sources
      .map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("");
    if (sources.includes(selected)) $("#feed-source").value = selected;
  }

  function renderFeed() {
    const filtered = filterFeedItems(state.feeds, {
      symbol: $("#feed-symbol").value,
      source: $("#feed-source").value,
      importance: $("#feed-importance").value,
    });
    $("#feed-asof").textContent = `${filtered.length} 条 · ${formatTime(state.feedEnvelope.asOf, true)}`;
    if (!filtered.length) {
      $("#research-feed").innerHTML = `<div class="unavailable-block"><b>${state.feedEnvelope.status === "unavailable" ? "事件流暂不可用" : "没有符合筛选的内容"}</b><span>${state.feedEnvelope.status === "unavailable" ? "API 未返回可验证新闻或事件。" : "尝试降低重要性或切换来源。"}</span></div>`;
      return;
    }
    $("#research-feed").innerHTML = filtered.map((item) => {
      const href = safeUrl(item.url);
      const tag = href ? "a" : "article";
      const link = href ? ` href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"` : "";
      return `<${tag} class="feed-item"${link}>
        <div class="feed-item-meta"><i class="importance ${escapeHtml(item.importance)}"></i><span>${escapeHtml(item.type === "event" ? "EVENT" : "NEWS")}</span><span>${escapeHtml(item.symbol || "MARKET")}</span><span>${formatTime(item.at, true)}</span></div>
        <h3>${escapeHtml(item.title || "未命名事件")}</h3>
        <p>${escapeHtml(item.summary)}</p>
        <div class="feed-item-foot"><span>${escapeHtml(item.source)}</span><span>${escapeHtml(item.importance.toUpperCase())}</span></div>
      </${tag}>`;
    }).join("");
  }

  async function loadMonitor() {
    try { state.monitor = normalizeEnvelope(await requestJson("/api/monitor-status?limit=20")); }
    catch { state.monitor = normalizeEnvelope(null); }
    renderTimeline();
    renderMonitorStatus();
  }

  function renderTimeline() {
    const profile = state.settings?.profiles?.[0];
    const schedules = buildTaskTimeline(profile);
    $("#task-timeline").innerHTML = schedules.map(({ time, label, status, detail }) => {
      return `<li class="is-${escapeHtml(status)}"><time>${escapeHtml(time)}</time><span><b>${escapeHtml(label)}</b><small>${escapeHtml(detail)}</small></span></li>`;
    }).join("") || '<li class="is-pending"><time>—</time><span><b>未启用计划</b><small>在设置中启用监控</small></span></li>';
  }

  function renderMonitorStatus() {
    const latest = state.monitor.data[0];
    $("#monitor-run-status").innerHTML = `<b>最近结果</b><span>${latest ? `${escapeHtml(latest.source || "monitor")} · ${escapeHtml(latest.status || "unknown")} · ${formatTime(latest.as_of, true)}${latest.detail ? ` · ${escapeHtml(latest.detail)}` : ""}` : "尚未从 /api/monitor-status 取得结果或失败原因"}</span>`;
  }

  function optionValue(value, {
    digits = 2,
    suffix = "",
    signed = false,
  } = {}) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const sign = signed && number > 0 ? "+" : "";
    return `${sign}${formatNumber(number, digits)}${suffix}`;
  }

  function renderOptionMetricGrid(selector, items) {
    $(selector).innerHTML = items.map(({ label, value, detail, tone = "" }) => `<div>
      <span>${escapeHtml(label)}</span>
      <strong class="${escapeHtml(tone)}">${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>`).join("");
  }

  function renderOptions() {
    const view = state.options;
    const statusLabels = {
      ok: view.sourceState === "market_closed"
        ? "市场休市 · 行情源正常"
        : view.mode === "live" ? "实时接口正常" : "数据正常",
      degraded: "部分降级",
      stale: view.mode === "snapshot" ? "快照降级" : "数据过期",
      unavailable: "数据不可用",
    };
    $("#options-status").textContent = statusLabels[view.status] || view.status;
    const dot = $(".option-status-strip .status-dot");
    dot.className = `status-dot is-${view.status}`;
    $("#options-quote-asof").textContent = formatTime(view.quoteAsOf, true);
    $("#options-model-asof").textContent = formatTime(view.modelAsOf, true);

    const change = view.market.changePct;
    const marketTone = Number.isFinite(change) ? (change >= 0 ? "market-up" : "market-down") : "";
    const ivGap = Number.isFinite(view.risk.ivAverage) && Number.isFinite(view.risk.hv30)
      ? view.risk.ivAverage - view.risk.hv30
      : null;
    renderOptionMetricGrid("#options-risk-metrics", [
      {
        label: view.market.symbol,
        value: optionValue(view.market.spot, { digits: 3 }),
        detail: Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "等待报价",
        tone: marketTone,
      },
      {
        label: "HV30 / IV",
        value: `${optionValue(view.risk.hv30, { digits: 1, suffix: "%" })} / ${optionValue(view.risk.ivAverage, { digits: 1, suffix: "%" })}`,
        detail: Number.isFinite(ivGap) ? `IV-HV ${ivGap >= 0 ? "+" : ""}${ivGap.toFixed(1)}pp` : "暂无可靠差值",
      },
      {
        label: "GARCH VaR 95%",
        value: optionValue(view.risk.var95, { digits: 2, suffix: "%" }),
        detail: view.risk.varMethod || view.risk.varQuality || "暂无可靠模型结果",
      },
      {
        label: "BSADF",
        value: optionValue(view.risk.bsadfStat, { digits: 2 }),
        detail: Number.isFinite(view.risk.bsadfCritical)
          ? `临界值 ${optionValue(view.risk.bsadfCritical, { digits: 2 })}${view.risk.bsadfTriggered ? " · 已触发" : " · 未触发"}`
          : "暂无可靠检验结果",
        tone: view.risk.bsadfTriggered ? "negative" : "",
      },
    ]);
    renderOptionMetricGrid("#options-exposure-metrics", [
      {
        label: "GEX",
        value: optionValue(view.exposure.gex, { digits: 2, signed: true }),
        detail: "净 Gamma 敞口",
      },
      {
        label: "DEX",
        value: optionValue(view.exposure.dex, { digits: 2, signed: true }),
        detail: "净 Delta 敞口",
      },
      {
        label: "PCR",
        value: optionValue(view.exposure.pcr, { digits: 2 }),
        detail: Number.isFinite(view.exposure.pcrOi) ? "持仓量口径" : Number.isFinite(view.exposure.pcrVolume) ? "成交量口径" : "暂无可靠口径",
      },
      {
        label: "Max Pain",
        value: optionValue(view.exposure.maxPain, { digits: 3 }),
        detail: view.exposure.nearExpiry ? `近月 ${view.exposure.nearExpiry}` : "近月最大痛点",
      },
    ]);

    const rows = view.options.slice(0, 80);
    $("#options-chain-coverage").textContent = `${view.contractCount || rows.length} 条合约`;
    if (!rows.length) {
      $("#options-chain").className = "table-empty";
      $("#options-chain").innerHTML = `<b>${view.status === "unavailable" ? "期权数据暂不可用" : "当前没有可展示合约"}</b><span>${view.fallbackReason ? `实时源失败：${escapeHtml(view.fallbackReason)}` : "不会用模拟期权链替代真实数据。"}</span>`;
      return;
    }
    $("#options-chain").className = "options-table-wrap";
    $("#options-chain").innerHTML = `<table class="options-table">
      <thead><tr><th>合约</th><th>类型</th><th>到期日</th><th>行权价</th><th>最新</th><th>IV</th><th>Delta</th><th>Gamma</th><th>Vega</th><th>Theta</th><th>成交量</th><th>持仓量</th><th>买 / 卖</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td><b>${escapeHtml(row.name || row.code)}</b><small>${escapeHtml(row.code)}</small></td>
        <td>${escapeHtml(row.type === "call" ? "认购" : row.type === "put" ? "认沽" : row.type || "—")}</td>
        <td>${escapeHtml(row.expiry || "—")}</td>
        <td>${escapeHtml(optionValue(row.strike, { digits: 3 }))}</td>
        <td>${escapeHtml(optionValue(row.last, { digits: 4 }))}</td>
        <td>${escapeHtml(optionValue(row.iv, { digits: 2, suffix: "%" }))}</td>
        <td>${escapeHtml(optionValue(row.delta, { digits: 3 }))}</td>
        <td>${escapeHtml(optionValue(row.gamma, { digits: 3 }))}</td>
        <td>${escapeHtml(optionValue(row.vega, { digits: 3 }))}</td>
        <td>${escapeHtml(optionValue(row.theta, { digits: 3 }))}</td>
        <td>${escapeHtml(formatVolume(row.volume))}</td>
        <td>${escapeHtml(formatVolume(row.openInterest))}</td>
        <td>${escapeHtml(`${optionValue(row.bid, { digits: 4 })} / ${optionValue(row.ask, { digits: 4 })}`)}</td>
      </tr>`).join("")}</tbody>
    </table>`;
  }

  function renderOptionsCountdown() {
    if (!state.optionsNextAt) {
      $("#options-next-refresh").textContent = "—";
      return;
    }
    const seconds = Math.max(0, Math.ceil((state.optionsNextAt - Date.now()) / 1000));
    $("#options-next-refresh").textContent = `${seconds}s`;
  }

  async function loadOptions({ announce = false } = {}) {
    $("#options-refresh").disabled = true;
    try {
      const response = await fetch("/api/volguard", { cache: "no-store" });
      let payload = null;
      try { payload = await response.json(); } catch { /* handled below */ }
      if (!response.ok) throw Object.assign(new Error(payload?.error || `HTTP ${response.status}`), { payload });
      state.options = normalizeVolguardPayload(payload, {
        mode: response.headers.get("x-volguard-mode") || "live",
        fallbackReason: response.headers.get("x-volguard-fallback") || "",
      });
      if (announce) toast(state.options.mode === "live" ? "期权数据已刷新" : "实时源不可用，已显示快照");
    } catch (error) {
      state.options = normalizeVolguardPayload(null, {
        mode: "unavailable",
        fallbackReason: error.message,
      });
      if (announce) toast(`期权数据不可用：${error.message}`, true);
    } finally {
      state.optionsNextAt = Date.now() + OPTIONS_FAST_REFRESH_MS;
      $("#options-refresh").disabled = false;
      renderOptions();
      renderOptionsCountdown();
    }
  }

  function refreshOptionsIfVisible() {
    if (document.body.dataset.route === "options") loadOptions();
    else state.optionsNextAt = null;
  }

  function renderAgentWorkspace() {
    const fullTargets = targets().filter(({ analysis }) => analysis === "full");
    $("#agent-input-status").textContent = `${fullTargets.length} 个深度标的`;
    $("#agent-targets-summary").className = fullTargets.length ? "agent-target-grid" : "panel-empty";
    $("#agent-targets-summary").innerHTML = fullTargets.length
      ? fullTargets.map((target) => `<div>
          <span>${escapeHtml(roleLabels[target.role] || target.role)}</span>
          <b>${escapeHtml(target.symbol)}</b>
          <small>${escapeHtml(target.name || target.market)} · 完整分析</small>
        </div>`).join("")
      : "<b>尚未指定深度分析标的</b><span>在设置中把至少一个标的的分析方式改为“深度”。</span>";

    const run = latestResearchRun(state.runs);
    const archivedAfterRun = archivedResearchAfterRun(run, state.latest);
    const pipelineRun = archivedAfterRun ? { ...run, conclusion: "success" } : run;
    const stageLabels = { pending: "待运行", queued: "已排队", running: "运行中", completed: "已完成", failed: "失败", unknown: "未确认" };
    for (const stage of buildPipelineStages(pipelineRun)) {
      const row = $(`[data-stage="${stage.id}"]`, $("#agent-pipeline"));
      row.className = `is-${stage.status}`;
      $("em", row).textContent = stageLabels[stage.status];
    }
    $("#agent-run-asof").textContent = run ? formatTime(run.created_at, true) : "没有运行记录";

    const resultCount = Array.isArray(state.latest?.results)
      ? state.latest.results.filter(({ error }) => !error).length
      : 0;
    if (!run && !state.latest) {
      $("#agent-run-card").className = "panel-empty";
      $("#agent-run-card").innerHTML = "<b>尚未开始新的研究</b><span>运行后将记录输入时间、来源、降级情况、模型、耗时和未解决问题。</span>";
      return;
    }
    $("#agent-run-card").className = "run-card-grid";
    const runStatus = archivedAfterRun
      ? "分析已完成"
      : run?.status || state.latest?.status || "已归档";
    const runConclusion = archivedAfterRun
      ? "报告已归档 · 后续发布失败"
      : run?.conclusion || "等待结论";
    $("#agent-run-card").innerHTML = `
      <div><span>运行状态</span><b>${escapeHtml(runStatus)}</b><small>${escapeHtml(runConclusion)}</small></div>
      <div><span>研究日期</span><b>${escapeHtml(state.latest?.trade_date || "—")}</b><small>${escapeHtml(formatTime(state.latest?.generated_at || run?.created_at, true))}</small></div>
      <div><span>模型 / Provider</span><b>${escapeHtml(state.latest?.provider || "—")}</b><small>${escapeHtml((state.latest?.analysts || []).join(" · ") || "未提供分析师清单")}</small></div>
      <div><span>研究结果</span><b>${resultCount}</b><small>${escapeHtml(run?.workflow || "归档结果")}</small></div>`;
  }

  function renderTaskBoard() {
    const profile = state.settings?.profiles?.[0];
    const rows = buildTaskTimeline(profile);
    $("#task-board").innerHTML = rows.map(({ time, label, status, detail }) => `<li class="is-${escapeHtml(status)}">
      <time>${escapeHtml(time)}</time>
      <div><b>${escapeHtml(label)}</b><small>${escapeHtml(detail)}</small></div>
      <span>${escapeHtml(status === "success" ? "成功" : status === "failed" ? "失败" : status === "running" ? "运行中" : "等待结果")}</span>
    </li>`).join("") || "<li><time>—</time><div><b>未启用研究计划</b><small>在设置中启用至少一个时段。</small></div><span>已停用</span></li>";
  }

  function renderArchiveList() {
    state.archiveEntries = buildArchiveEntries(state.history);
    $("#archive-count").textContent = `${state.archiveEntries.length} 份`;
    if (!state.archiveEntries.length) {
      $("#archive-list").className = "panel-empty";
      $("#archive-list").innerHTML = "<b>没有可用研究档案</b><span>历史接口与静态灾备均未返回报告索引。</span>";
      return;
    }
    $("#archive-list").className = "archive-list";
    $("#archive-list").innerHTML = state.archiveEntries.map((entry, index) => `<button type="button" data-archive-index="${index}" class="${entry.report === state.selectedReportPath ? "is-active" : ""}">
      <span><b>${escapeHtml(entry.ticker)}</b><em>${escapeHtml(entry.rating || "—")}</em></span>
      <small>${escapeHtml(entry.tradeDate || formatTime(entry.generatedAt, true))} · ${escapeHtml(entry.provider || "unknown")}</small>
    </button>`).join("");
    $$("[data-archive-index]", $("#archive-list")).forEach((button) => button.addEventListener("click", () => {
      loadArchiveReport(state.archiveEntries[Number(button.dataset.archiveIndex)]);
    }));
  }

  async function fetchReportText(path) {
    const encoded = encodeURIComponent(path);
    let response = await fetch(`/api/report?path=${encoded}`, { cache: "no-store" });
    if (!response.ok) response = await fetch(`/${path.replace(/^\/+/, "")}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`报告读取失败 (${response.status})`);
    return response.text();
  }

  async function loadArchiveReport(entryOrPath) {
    const entry = typeof entryOrPath === "string"
      ? state.archiveEntries.find(({ report }) => report === entryOrPath)
        || { report: entryOrPath, ticker: entryOrPath.split("/")[1] || "报告", rating: "" }
      : entryOrPath;
    if (!entry?.report) return;
    state.selectedReportPath = entry.report;
    state.latestReport = entry.report;
    state.selectedReportContent = "";
    $("#archive-report-title").textContent = `${entry.ticker} · ${entry.tradeDate || "研究报告"}`;
    $("#archive-report-body").className = "panel-empty";
    $("#archive-report-body").innerHTML = "<b>正在读取完整报告</b><span>同时核验报告路径和来源。</span>";
    renderArchiveList();
    try {
      state.selectedReportContent = await fetchReportText(entry.report);
      $("#archive-report-body").className = "archive-markdown";
      $("#archive-report-body").innerHTML = renderMarkdown(state.selectedReportContent);
    } catch (error) {
      $("#archive-report-body").className = "panel-empty";
      $("#archive-report-body").innerHTML = `<b>报告暂不可用</b><span>${escapeHtml(error.message)}</span>`;
    }
  }

  async function loadResearchWorkspace() {
    const [historyResult, runsResult] = await Promise.allSettled([
      requestJson("/api/history"),
      requestJson("/api/runs"),
    ]);
    if (historyResult.status === "fulfilled") {
      const payload = historyResult.value;
      state.history = Array.isArray(payload) ? payload : payload?.data || payload?.history || [];
    } else {
      try { state.history = await requestJson("./data/history.json"); }
      catch { state.history = []; }
    }
    if (runsResult.status === "fulfilled") {
      const payload = runsResult.value;
      state.runs = payload?.runs || payload?.data || [];
    } else {
      state.runs = [];
    }
    renderAgentWorkspace();
    renderTaskBoard();
    renderArchiveList();
  }

  function renderNewsWorkspace() {
    $("#news-workspace-asof").textContent = `${state.feeds.length} 条 · ${formatTime(state.feedEnvelope.asOf, true)}`;
    const rows = state.feeds.slice(0, 200);
    if (!rows.length) {
      $("#news-workspace-list").className = "panel-empty";
      $("#news-workspace-list").innerHTML = "<b>新闻与事件暂不可用</b><span>接口恢复前不会填充示例资讯。</span>";
      return;
    }
    $("#news-workspace-list").className = "evidence-ledger";
    $("#news-workspace-list").innerHTML = rows.map((item) => {
      const href = safeUrl(item.url);
      const tag = href ? "a" : "article";
      const link = href ? ` href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"` : "";
      const tier = item.sourceTier || item.source_tier || (item.type === "event" ? "evidence" : "discovery");
      return `<${tag} class="evidence-row"${link}>
        <time>${escapeHtml(formatTime(item.at, true))}</time>
        <div><span>${escapeHtml(item.symbol || "MARKET")} · ${escapeHtml(tier)}</span><b>${escapeHtml(item.title || "未命名事件")}</b><small>${escapeHtml(item.summary || "没有可验证摘要")}</small></div>
        <em>${escapeHtml(item.source || "unknown")}</em>
        <strong>${escapeHtml(String(item.importance || "medium").toUpperCase())}</strong>
      </${tag}>`;
    }).join("");
  }

  function renderSettingsWorkspace() {
    const profile = state.settings?.profiles?.[0];
    if (!profile) return;
    const enabledTargets = profile.targets || [];
    $("#settings-workspace-status").textContent = profile.enabled ? "已启用" : "已停用";
    $("#settings-workspace-summary").className = "settings-summary-grid";
    $("#settings-workspace-summary").innerHTML = `
      <div><span>研究目标</span><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.objective)}</small></div>
      <div><span>标的配置</span><b>${enabledTargets.length} 个</b><small>${escapeHtml(enabledTargets.map(({ symbol }) => symbol).join(" · "))}</small></div>
      <div><span>盘中频率</span><b>${escapeHtml(String(profile.schedules?.cnIntraday?.collectionIntervalMinutes || 5))} / ${escapeHtml(String(profile.schedules?.cnIntraday?.signalIntervalMinutes || 15))} 分钟</b><small>采集 / 信号</small></div>
      <div><span>提醒规则</span><b>${escapeHtml(profile.alerts?.pushMinSeverity || "high")}</b><small>${escapeHtml(`${profile.alerts?.quietHours?.start || "22:30"}–${profile.alerts?.quietHours?.end || "07:30"} 静默`)}</small></div>`;
  }

  function renderNextRun() {
    const next = computeNextRun(state.settings?.profiles?.[0]);
    const text = next ? `${next.label} ${formatTime(next.at, true)}` : "下一次 —";
    $("#next-run").textContent = text;
    $("#next-run-compact").textContent = text;
  }

  async function loadLatest() {
    try {
      const payload = await requestJson("/api/latest");
      state.latest = payload?.data || payload;
    } catch {
      try { state.latest = await requestJson("./data/latest.json"); }
      catch { state.latest = null; }
    }
    renderConclusion();
    renderAgentWorkspace();
    renderArchiveList();
  }

  function renderConclusion() {
    const result = selectConclusion(state.latest, state.selectedSymbol);
    if (!result) {
      $("#conclusion-asof").textContent = "尚无可验证研究结果";
      $("#conclusion-body").innerHTML = '<div class="conclusion-rating neutral">待研究</div><p>最新研究接口与静态归档均未返回可用结论。</p>';
      state.latestReport = null;
      return;
    }
    state.latestReport = result.report;
    const rating = String(result.rating || "neutral").toLowerCase();
    const tone = ["buy", "overweight"].includes(rating) ? "market-up" : ["sell", "underweight"].includes(rating) ? "market-down" : "neutral";
    $("#conclusion-asof").textContent = `${result.ticker} · ${state.latest.trade_date || formatTime(state.latest.generated_at, true)}`;
    $("#conclusion-body").innerHTML = `<div class="conclusion-rating ${tone}">${escapeHtml(ratingLabels[rating] || result.rating || "待研究")}</div><p>${escapeHtml(plainText(result.decision_excerpt) || "研究档案已生成，打开完整报告查看。")}</p>`;
  }

  function renderDrivers() {
    const drivers = targets().filter((target) => ["driver", "benchmark"].includes(target.role)).slice(0, 4);
    const cells = drivers.filter((target) => state.quotes.has(target.symbol)).map((target) => {
      const quote = state.quotes.get(target.symbol);
      const tone = marketTone(quote.change, target.market);
      return `<div class="driver-cell"><span>${escapeHtml(target.symbol)} / ${escapeHtml(roleLabels[target.role])}</span><strong class="${tone}">${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%</strong><small>${escapeHtml(target.name)} · 相关性 — · 最新 ${formatNumber(quote.close)}</small></div>`;
    });
    $("#driver-grid").innerHTML = cells.length ? cells.join("") : '<div class="driver-empty">没有足够真实数据计算跨市场驱动</div>';
    $("#correlation-asof").textContent = state.market.asOf ? `数据 ${formatTime(state.market.asOf, true)}` : "等待市场数据";
  }

  function barTime(bar) {
    return Math.floor(new Date(bar.ts).valueOf() / 1000);
  }

  function linePoint(time, value) {
    return Number.isFinite(value) ? { time, value } : { time };
  }

  function ensureChart() {
    if (state.chart.api) return;
    const chart = createChart($("#market-chart"), {
      autoSize: true,
      height: 486,
      layout: {
        background: { type: ColorType.Solid, color: "#0d0f11" },
        textColor: "#879197",
        fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
        fontSize: 11,
        panes: {
          separatorColor: "#2c3338",
          separatorHoverColor: "#495158",
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: "#20262a" },
        horzLines: { color: "#242a2e" },
      },
      rightPriceScale: {
        borderColor: "#343b40",
        minimumWidth: 58,
      },
      timeScale: {
        borderColor: "#343b40",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 8,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#667077", style: LineStyle.Dashed, labelBackgroundColor: "#343b40" },
        horzLine: { color: "#667077", style: LineStyle.Dashed, labelBackgroundColor: "#343b40" },
      },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#e05f68",
      downColor: "#38b788",
      borderVisible: false,
      wickUpColor: "#e05f68",
      wickDownColor: "#38b788",
      priceLineVisible: true,
      lastValueVisible: true,
    }, 0);
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
    }, 0);
    const ma20 = chart.addSeries(LineSeries, {
      color: "#bcc5c9",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "MA20",
    }, 0);
    const ma60 = chart.addSeries(LineSeries, {
      color: "#747f85",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "MA60",
    }, 0);
    const macd = chart.addSeries(LineSeries, {
      color: "#aab2b5",
      lineWidth: 1,
      priceLineVisible: false,
      title: "MACD",
    }, 1);
    const signal = chart.addSeries(LineSeries, {
      color: "#6c777d",
      lineWidth: 1,
      priceLineVisible: false,
      title: "SIGNAL",
    }, 1);
    const histogram = chart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false,
      title: "HIST",
    }, 1);
    const rsi = chart.addSeries(LineSeries, {
      color: "#b8c1c5",
      lineWidth: 1,
      priceLineVisible: false,
      title: "RSI",
    }, 2);
    rsi.createPriceLine({ price: 70, color: "#485158", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "70" });
    rsi.createPriceLine({ price: 30, color: "#485158", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "30" });
    chart.priceScale("volume", 0).applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    const panes = chart.panes();
    panes[0]?.setHeight(310);
    panes[1]?.setHeight(92);
    panes[2]?.setHeight(84);
    chart.subscribeCrosshairMove((param) => {
      const point = param.seriesData.get(candles);
      const readout = $("#crosshair-readout");
      if (!point || !param.time) {
        readout.hidden = true;
        return;
      }
      const bar = state.chart.bars.find((item) => barTime(item) === Number(param.time));
      if (!bar) {
        readout.hidden = true;
        return;
      }
      readout.hidden = false;
      readout.textContent = `${formatTime(bar.ts, true)}  O ${formatNumber(bar.open)}  H ${formatNumber(bar.high)}  L ${formatNumber(bar.low)}  C ${formatNumber(bar.close)}  V ${formatVolume(bar.volume)}`;
    });
    state.chart.api = chart;
    state.chart.series = { candles, volume, ma20, ma60, macd, signal, histogram, rsi };
  }

  function syncChartData({ strategy = "setData", changedFromIndex = 0, fitContent = false } = {}) {
    ensureChart();
    const bars = state.chart.bars;
    const series = state.chart.series;
    const indicators = computeIndicators(bars);
    const selectedMarket = targets().find(({ symbol }) => symbol === state.selectedSymbol)?.market || "CN";
    const palette = marketPalette(selectedMarket);
    $("#market-chart").setAttribute(
      "aria-label",
      `K 线、成交量、MACD 与 RSI 多窗格图；已加载 ${bars.length} 根 K 线；${bars.length >= 60 ? "MA60 历史充足" : "MA60 历史不足"}`,
    );
    series.volume.applyOptions({ visible: state.indicators.volume });
    series.ma20.applyOptions({ visible: state.indicators.ma20 });
    series.ma60.applyOptions({ visible: state.indicators.ma60 });
    series.candles.applyOptions({
      upColor: palette.up,
      downColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
    });
    if (strategy === "none") return;
    if (!bars.length) {
      Object.values(series).forEach((item) => item.setData([]));
      $("#crosshair-readout").hidden = true;
      return;
    }
    const candleData = bars.map((bar) => ({
      time: barTime(bar),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
    }));
    const volumeData = bars.map((bar) => ({
      time: barTime(bar),
      value: Number(bar.volume) || 0,
      color: Number(bar.close) >= Number(bar.open) ? palette.upSoft : palette.downSoft,
    }));
    const lineData = (values) => bars.map((bar, index) => linePoint(barTime(bar), values[index]));
    const histogramData = bars.map((bar, index) => ({
      time: barTime(bar),
      value: indicators.histogram[index],
      color: indicators.histogram[index] >= 0 ? palette.upHistogram : palette.downHistogram,
    }));
    const dataSets = {
      candles: candleData,
      volume: volumeData,
      ma20: lineData(indicators.ma20),
      ma60: lineData(indicators.ma60),
      macd: lineData(indicators.macd),
      signal: lineData(indicators.signal),
      histogram: histogramData,
      rsi: lineData(indicators.rsi),
    };
    applySeriesBatch(series, dataSets, { strategy, changedFromIndex });
    if (strategy === "setData" && fitContent) state.chart.api.timeScale().fitContent();
  }

  function initializeChart() {
    ensureChart();
  }

  async function selectSymbol(symbol) {
    state.selectedSymbol = symbol;
    const target = targets().find((item) => item.symbol === symbol);
    if (target?.market === "US" && state.timeframe !== "1d") {
      state.timeframe = "1d";
      $$("[data-timeframe]").forEach((button) => {
        const active = button.dataset.timeframe === "1d";
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
      });
    }
    renderWatchlist();
    renderConclusion();
    state.chart.bars = [];
    await loadMarket();
  }

  function setMobileView(view) {
    document.body.dataset.mobileView = view;
    $$("[data-mobile-section]").forEach((button) => button.classList.toggle("is-active", button.dataset.mobileSection === view));
  }

  function navigateRoute(route) {
    const href = routeHref(route);
    if (location.hash === href) {
      applyRoute();
      return;
    }
    location.hash = href;
  }

  function applyRoute() {
    const requested = String(location.hash || "").replace(/^#/, "");
    const route = normalizeRoute(requested);
    if (requested !== route) history.replaceState(null, "", routeHref(route));
    document.body.dataset.route = route;
    $$("[data-workspace]").forEach((workspace) => {
      workspace.hidden = workspace.dataset.workspace !== route;
    });
    $$("[data-route-link]").forEach((link) => {
      const active = link.dataset.routeLink === route;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    const descriptor = PRIMARY_ROUTES.find(({ id }) => id === route) || PRIMARY_ROUTES[0];
    $("#workspace-title").textContent = descriptor.label;
    document.title = `${descriptor.label} · Trading Workbench`;
    window.dispatchEvent(new CustomEvent("workbench:routechange", { detail: { route } }));
  }

  function openDrawer(drawer, overlay) {
    $(overlay).hidden = false;
    $(drawer).classList.add("is-open");
    $(drawer).setAttribute("aria-hidden", "false");
  }

  function closeDrawer(drawer, overlay) {
    $(drawer).classList.remove("is-open");
    $(drawer).setAttribute("aria-hidden", "true");
    $(overlay).hidden = true;
  }

  function renderTargetEditor() {
    const profile = state.settings?.profiles?.[0];
    if (!profile) return;
    $("#target-editor").innerHTML = profile.targets.map((target, index) => `<div class="target-row" data-target-index="${index}">
      <span class="target-symbol"><strong>${escapeHtml(target.symbol)}</strong><small>${escapeHtml(target.name)}</small></span>
      <select data-target-role aria-label="${escapeHtml(target.symbol)} 角色">${Object.entries(roleLabels).map(([value, label]) => `<option value="${value}" ${target.role === value ? "selected" : ""}>${label}</option>`).join("")}</select>
      <select data-target-analysis aria-label="${escapeHtml(target.symbol)} analysisDepth"><option value="full" ${target.analysis === "full" ? "selected" : ""}>深度</option><option value="signal" ${target.analysis === "signal" ? "selected" : ""}>信号</option></select>
      <button class="target-remove" data-target-remove type="button" aria-label="移除 ${escapeHtml(target.symbol)}">×</button>
    </div>`).join("");
    $$("[data-target-role]", $("#target-editor")).forEach((select) => select.addEventListener("change", () => {
      profile.targets[Number(select.closest("[data-target-index]").dataset.targetIndex)].role = select.value;
    }));
    $$("[data-target-analysis]", $("#target-editor")).forEach((select) => select.addEventListener("change", () => {
      profile.targets[Number(select.closest("[data-target-index]").dataset.targetIndex)].analysis = select.value;
    }));
    $$("[data-target-remove]", $("#target-editor")).forEach((button) => button.addEventListener("click", () => {
      if (profile.targets.length <= 1) { toast("研究目标至少保留一个标的", true); return; }
      profile.targets.splice(Number(button.closest("[data-target-index]").dataset.targetIndex), 1);
      if (!profile.targets.some((target) => target.symbol === state.selectedSymbol)) state.selectedSymbol = profile.targets[0].symbol;
      renderTargetEditor(); renderWatchlist();
    }));
  }

  function normalizeSymbol(raw) {
    const value = String(raw || "").trim().toUpperCase();
    if (/^\d{6}$/.test(value)) return `${value}.${"569".includes(value[0]) ? "SS" : "SZ"}`;
    if (/^\d{6}\.(?:SS|SZ)$/.test(value) || /^[A-Z]{1,5}(?:-[A-Z])?$/.test(value)) return value;
    return null;
  }

  function addTarget() {
    const profile = state.settings.profiles[0];
    const symbol = normalizeSymbol($("#target-search").value);
    if (!symbol) { toast("请输入支持的 A 股或美股代码", true); return; }
    if (profile.targets.some((target) => target.symbol === symbol)) { toast("该标的已在研究目标中", true); return; }
    if (profile.targets.length >= 12) { toast("每个研究目标最多 12 个标的", true); return; }
    profile.targets.push({ symbol, name: symbol, market: symbol.includes(".S") ? "CN" : "US", role: "comparison", analysis: "signal" });
    $("#target-search").value = "";
    renderTargetEditor(); renderWatchlist();
  }

  function collectSettingsForm() {
    const profile = state.settings.profiles[0];
    profile.enabled = $("#profile-enabled").checked;
    profile.name = $("#profile-name").value.trim();
    profile.objective = $("#profile-objective").value.trim();
    profile.timezone = $("#profile-timezone").value;
    profile.schedules.usCloseSnapshot.enabled = $("#enable-us-close").checked;
    profile.schedules.usCloseSnapshot.time = $("#schedule-us-close").value;
    profile.schedules.preMarketBrief.enabled = $("#enable-premarket").checked;
    profile.schedules.preMarketBrief.time = $("#schedule-premarket").value;
    profile.schedules.closeDeepAnalysis.enabled = $("#enable-close-analysis").checked;
    profile.schedules.closeDeepAnalysis.time = $("#schedule-close").value;
    profile.schedules.cnIntraday.enabled = $("#enable-intraday").checked;
    profile.schedules.cnIntraday.windows = [
      { start: $("#window-am-start").value, end: $("#window-am-end").value },
      { start: $("#window-pm-start").value, end: $("#window-pm-end").value },
    ];
    profile.schedules.cnIntraday.collectionIntervalMinutes = Number($("#collection-interval").value);
    profile.schedules.cnIntraday.signalIntervalMinutes = Number($("#signal-interval").value);
    profile.alerts.pushMinSeverity = $("#alert-severity").value;
    profile.alerts.quietHours.start = $("#quiet-start").value;
    profile.alerts.quietHours.end = $("#quiet-end").value;
    profile.alerts.channels.web = $("#alert-web").checked;
    profile.alerts.channels.pushPlus = $("#alert-pushplus").checked;
    return state.settings;
  }

  async function submitAction(path, body, method = "POST") {
    if (!state.accessCode) throw Object.assign(new Error("请先输入写操作访问码"), { status: 401 });
    return requestJson(path, {
      method,
      headers: { "content-type": "application/json", "x-access-code": state.accessCode },
      body: JSON.stringify(body),
    });
  }

  async function saveSettings(event) {
    event.preventDefault();
    const notice = $("#settings-notice");
    notice.textContent = "正在保存并核验版本…"; notice.className = "settings-notice";
    state.accessCode = $("#settings-code").value.trim();
    if (state.accessCode) sessionStorage.setItem(STORAGE.sessionCode, state.accessCode);
    try {
      collectSettingsForm();
      const payload = await submitAction("/api/settings", { settings: state.settings, expectedUpdatedAt: state.settingsUpdatedAt }, "PUT");
      state.settings = payload.settings;
      state.settingsUpdatedAt = payload.updatedAt;
      notice.textContent = payload.message || "配置已保存";
      renderSettingsSummary();
      await persistCredential();
      toast("监控配置已保存");
    } catch (error) {
      notice.classList.add("is-error");
      notice.textContent = error.status === 409 ? "版本冲突：远端配置已变化，请关闭设置并刷新后重试。" : error.message;
    }
  }

  async function runAnalysis() {
    state.accessCode = $("#settings-code").value.trim() || state.accessCode;
    const notice = $("#settings-notice");
    notice.textContent = "正在提交研究任务…"; notice.className = "settings-notice";
    try {
      const fullAnalysisTargets = targets().filter(({ analysis }) => analysis === "full");
      if (!fullAnalysisTargets.length) throw new Error("请先把至少一个标的的分析方式设为“深度”");
      const payload = await submitAction("/api/analyze", { tickers: fullAnalysisTargets.map(({ symbol }) => symbol) });
      notice.textContent = payload.message || "服务端已受理";
      toast(`多智能体分析已受理：${fullAnalysisTargets.map(({ symbol }) => symbol).join("、")}`);
      setTimeout(loadMonitor, 2500);
    } catch (error) {
      notice.classList.add("is-error");
      notice.textContent = `立即运行不可用：${error.message}`;
    }
  }

  function bytesToBase64(bytes) {
    let value = ""; bytes.forEach((byte) => { value += String.fromCharCode(byte); }); return btoa(value);
  }
  const base64ToBytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

  async function cryptoKey(create = false) {
    if (!crypto.subtle) return null;
    let raw = localStorage.getItem(STORAGE.deviceKey);
    if (!raw && create) {
      raw = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
      localStorage.setItem(STORAGE.deviceKey, raw);
    }
    return raw ? crypto.subtle.importKey("raw", base64ToBytes(raw), "AES-GCM", false, ["encrypt", "decrypt"]) : null;
  }

  async function persistCredential() {
    if (!state.accessCode) return;
    state.rememberCode = $("#settings-remember").checked;
    if (!state.rememberCode) { localStorage.removeItem(STORAGE.encryptedCode); return; }
    const key = await cryptoKey(true);
    if (!key) { toast("当前浏览器不支持设备加密，仅保留在本次会话", true); return; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(state.accessCode));
    localStorage.setItem(STORAGE.encryptedCode, JSON.stringify({ iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) }));
  }

  async function loadCredential() {
    state.accessCode = sessionStorage.getItem(STORAGE.sessionCode) || "";
    if (!state.accessCode) {
      try {
        const stored = JSON.parse(localStorage.getItem(STORAGE.encryptedCode) || "null");
        const key = stored && await cryptoKey();
        if (key) {
          const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(stored.iv) }, key, base64ToBytes(stored.data));
          state.accessCode = decoder.decode(decrypted);
          state.rememberCode = true;
        }
      } catch { localStorage.removeItem(STORAGE.encryptedCode); }
    }
    $("#settings-code").value = state.accessCode;
    $("#settings-remember").checked = state.rememberCode;
  }

  function clearCredential() {
    state.accessCode = "";
    state.rememberCode = false;
    sessionStorage.removeItem(STORAGE.sessionCode);
    localStorage.removeItem(STORAGE.encryptedCode);
    localStorage.removeItem(STORAGE.deviceKey);
    $("#settings-code").value = "";
    $("#settings-remember").checked = false;
    toast("本机访问码及设备密钥已清除");
  }

  function openAssistant() {
    openDrawer("#assistant", "#assistant-backdrop");
    $("#assistant-open").setAttribute("aria-expanded", "true");
    recoverThread(state.threadId);
  }

  function closeAssistant() {
    closeDrawer("#assistant", "#assistant-backdrop");
    $("#assistant-open").setAttribute("aria-expanded", "false");
  }

  function threadId() {
    return crypto.randomUUID?.() || `thread-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function saveThreads() {
    state.threads = compactThreads(state.threads);
    try {
      localStorage.setItem(STORAGE.threads, JSON.stringify(state.threads));
      state.threadStorageWarningShown = false;
      return true;
    } catch (error) {
      if (!state.threadStorageWarningShown) {
        toast("本地会话无法继续持久化；本次问答仍可继续。", true);
        state.threadStorageWarningShown = true;
      }
      return false;
    }
  }

  function currentThread() {
    return state.threads.find((thread) => thread.id === state.threadId) || null;
  }

  function renderThread() {
    const thread = currentThread();
    const log = $("#chat-log");
    if (!thread?.messages?.length) {
      log.innerHTML = '<div class="chat-empty"><b>从一条可验证的问题开始</b><span>可询问当前标的、最新研究结论、风险因子或数据缺口。</span></div>';
      return;
    }
    log.innerHTML = thread.messages.map((message) => `<div class="chat-message ${escapeHtml(message.role)}${message.error ? " is-error" : ""}" data-message-id="${escapeHtml(message.id)}">
      <div class="chat-message-meta">${message.role === "user" ? "我" : "研究助理"} · ${formatTime(message.at, true)}</div>
      <div class="chat-message-body">${message.role === "assistant" ? renderMarkdown(message.content) : escapeHtml(message.content)}</div>
    </div>`).join("");
    log.scrollTop = log.scrollHeight;
  }

  function renderThreads() {
    const select = $("#thread-select");
    select.innerHTML = state.threads.map((thread) => `<option value="${escapeHtml(thread.id)}">${escapeHtml(thread.title || "新研究会话")}</option>`).join("");
    select.value = state.threadId || "";
    $("#delete-thread").disabled = state.threads.length <= 1;
    renderThread();
  }

  function createThread(title = "新研究会话") {
    const now = new Date().toISOString();
    const thread = { id: threadId(), title, createdAt: now, updatedAt: now, messages: [] };
    state.threads.unshift(thread);
    state.threadId = thread.id;
    saveThreads();
    renderThreads();
    return thread;
  }

  function loadThreads() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE.threads) || "[]");
      state.threads = compactThreads(Array.isArray(stored)
        ? stored.filter((thread) => thread && typeof thread.id === "string" && Array.isArray(thread.messages))
        : []);
    } catch {
      state.threads = [];
    }
    if (!state.threads.length) {
      createThread();
      return;
    }
    state.threadId = state.threads[0].id;
    renderThreads();
  }

  function deleteCurrentThread() {
    const deletedId = state.threadId;
    if (state.accessCode && deletedId) {
      fetch("/api/chat-sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json", "x-access-code": state.accessCode },
        body: JSON.stringify({ sessionId: deletedId }),
      }).catch(() => {});
    }
    if (state.threads.length <= 1) {
      currentThread().messages = [];
      currentThread().updatedAt = new Date().toISOString();
      saveThreads();
      renderThread();
      return;
    }
    state.threads = state.threads.filter((thread) => thread.id !== state.threadId);
    state.threadId = state.threads[0].id;
    saveThreads();
    renderThreads();
  }

  function appendChat(role, content, error = false, metadata = {}) {
    const thread = currentThread() || createThread();
    const message = {
      id: threadId(),
      role,
      content,
      error,
      at: new Date().toISOString(),
      ...metadata,
    };
    thread.messages.push(message);
    thread.updatedAt = message.at;
    if (role === "user" && thread.messages.filter((item) => item.role === "user").length === 1) {
      thread.title = plainText(content, 28) || "新研究会话";
    }
    saveThreads();
    renderThreads();
    return $(`[data-message-id="${CSS.escape(message.id)}"]`, $("#chat-log"));
  }

  function serverMessageRequestId(message) {
    const suffix = `:${message.role}`;
    return String(message.id || "").endsWith(suffix)
      ? String(message.id).slice(0, -suffix.length)
      : "";
  }

  async function recoverThread(targetThreadId = state.threadId) {
    if (!state.accessCode || !targetThreadId) return false;
    try {
      const payload = await requestJson(
        `/api/chat-sessions?sessionId=${encodeURIComponent(targetThreadId)}`,
        { headers: { "x-access-code": state.accessCode } },
      );
      const remote = payload?.data;
      if (!Array.isArray(remote?.messages) || !remote.messages.length) return false;
      const thread = state.threads.find(({ id }) => id === targetThreadId);
      if (!thread) return false;
      for (const remoteMessage of remote.messages) {
        const recoveredRequestId = serverMessageRequestId(remoteMessage);
        const local = thread.messages.find((message) =>
          (recoveredRequestId
            && message.requestId === recoveredRequestId
            && message.role === remoteMessage.role)
          || message.id === remoteMessage.id,
        );
        if (local) {
          local.content = remoteMessage.content;
          local.at = remoteMessage.at;
          local.error = false;
          if (recoveredRequestId) local.requestId = recoveredRequestId;
        } else {
          thread.messages.push({
            id: remoteMessage.id,
            role: remoteMessage.role,
            content: remoteMessage.content,
            at: remoteMessage.at,
            error: false,
            ...(recoveredRequestId ? { requestId: recoveredRequestId } : {}),
          });
        }
      }
      thread.messages.sort((left, right) => String(left.at).localeCompare(String(right.at)));
      thread.title = remote.title || thread.title;
      thread.updatedAt = remote.updatedAt || thread.updatedAt;
      saveThreads();
      if (state.threadId === targetThreadId) renderThreads();
      return true;
    } catch {
      return false;
    }
  }

  async function recoverChatRequest(targetThreadId, targetRequestId) {
    for (const delay of [400, 900, 1800]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await recoverThread(targetThreadId);
      const thread = state.threads.find(({ id }) => id === targetThreadId);
      const answer = thread?.messages.find((message) =>
        message.requestId === targetRequestId
        && message.role === "assistant"
        && !message.error
        && message.content !== "正在连接已归档研究资料…",
      );
      if (answer) return true;
    }
    return false;
  }

  function updateChatMessage(node, content, error = false) {
    const message = currentThread()?.messages.find((item) => item.id === node?.dataset.messageId);
    if (!message || !node) return;
    message.content = content;
    message.error = error;
    currentThread().updatedAt = new Date().toISOString();
    node.classList.toggle("is-error", error);
    $(".chat-message-body", node).innerHTML = message.role === "assistant" ? renderMarkdown(content) : escapeHtml(content);
    saveThreads();
    $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  }

  function parseSseBlock(block) {
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return { event, payload: null };
    const raw = data.join("\n");
    try { return { event, payload: JSON.parse(raw) }; }
    catch { return { event, payload: { content: raw } }; }
  }

  async function readChatStream(response, answerNode) {
    const reader = response.body.getReader();
    let buffer = "";
    let answer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n");
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      if (done && buffer.trim()) blocks.push(buffer);
      for (const block of blocks) {
        if (!block.trim()) continue;
        const { event, payload } = parseSseBlock(block);
        if (event === "meta" && payload?.context) $("#chat-context").textContent = payload.context;
        if (event === "delta") {
          answer += payload?.content || payload?.delta || "";
          updateChatMessage(answerNode, answer || "上游未返回内容");
        }
        if (event === "error") throw new Error(payload?.error || payload?.message || "问答流中断");
        if (event === "done" && !answer && payload?.answer) {
          answer = payload.answer;
          updateChatMessage(answerNode, answer);
        }
      }
      if (done) break;
    }
    if (!answer) updateChatMessage(answerNode, "上游未返回内容", true);
  }

  async function sendChat(event) {
    event.preventDefault();
    if (state.chatBusy) return;
    const question = $("#chat-question").value.trim();
    if (!question) return;
    if (!state.accessCode) { openDrawer("#settings-drawer", "#settings-overlay"); toast("研究问答需要访问码", true); return; }
    const thread = currentThread() || createThread();
    const historyMessages = buildChatHistory(thread.messages);
    const currentProfile = state.settings?.profiles?.find((profile) => profile.enabled)
      || state.settings?.profiles?.[0];
    const chatRequestId = threadId();
    state.chatBusy = true;
    $("#chat-send").disabled = true;
    $("#chat-question").value = "";
    appendChat("user", question, false, { requestId: chatRequestId });
    const answer = appendChat(
      "assistant",
      "正在连接已归档研究资料…",
      false,
      { requestId: chatRequestId },
    );
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-access-code": state.accessCode,
          "x-request-id": chatRequestId,
        },
        body: JSON.stringify({
          requestId: chatRequestId,
          sessionId: thread.id,
          profileId: currentProfile?.id,
          symbol: state.selectedSymbol,
          question,
          history: historyMessages,
          report: state.latestReport,
          stream: true,
        }),
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { message = (await response.json()).error || message; } catch { /* non-JSON error */ }
        throw new Error(message);
      }
      if (response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
        await readChatStream(response, answer);
      } else {
        const payload = await response.json();
        updateChatMessage(answer, payload.answer || "上游未返回内容", !payload.answer);
      }
    } catch (error) {
      const recovered = await recoverChatRequest(thread.id, chatRequestId);
      if (!recovered) updateChatMessage(answer, error.message, true);
    } finally {
      state.chatBusy = false;
      $("#chat-send").disabled = false;
    }
  }

  async function openLatestReport() {
    if (!state.latestReport) { toast("当前没有可打开的研究档案", true); return; }
    navigateRoute("archive");
    await loadArchiveReport(state.latestReport);
  }

  function updateClock() {
    $("#terminal-clock").textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
    const hour = new Date().getHours();
    const minute = new Date().getMinutes();
    const minutes = hour * 60 + minute;
    const cnOpen = (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
    const usOpen = minutes >= 1290 || minutes <= 240;
    $(".market-session:nth-child(1)", $(".session-strip")).classList.toggle("is-open", cnOpen);
    $(".market-session:nth-child(2)", $(".session-strip")).classList.toggle("is-open", usOpen);
    $("#cn-session").textContent = cnOpen ? "交易中" : "休市";
    $("#us-session").textContent = usOpen ? "交易中" : "休市";
  }

  async function refreshAll() {
    $("#refresh-all").disabled = true;
    await Promise.allSettled([loadMarket(), loadQuoteStrip(), loadFeeds(), loadMonitor(), loadLatest()]);
    $("#refresh-all").disabled = false;
    toast("数据核验完成");
  }

  async function pollWorkbenchData() {
    await Promise.allSettled([
      loadMarket({ incremental: true }),
      loadQuoteStrip(),
      loadFeeds(),
      loadMonitor(),
    ]);
  }

  function bindEvents() {
    $$("[data-timeframe]").forEach((button) => button.addEventListener("click", async () => {
      if (button.disabled) return;
      state.timeframe = button.dataset.timeframe;
      $$("[data-timeframe]").forEach((item) => { item.classList.toggle("is-active", item === button); item.setAttribute("aria-selected", String(item === button)); });
      await loadMarket();
      loadQuoteStrip();
    }));
    $$("[data-history-range]").forEach((button) => button.addEventListener("click", async () => {
      state.historyRange = button.dataset.historyRange;
      $$("[data-history-range]").forEach((item) => item.classList.toggle("is-active", item === button));
      await loadMarket();
    }));
    $$("[data-indicator]").forEach((input) => input.addEventListener("change", () => {
      state.indicators[input.dataset.indicator] = input.checked;
      syncChartData({ strategy: "none" });
    }));
    $("#chart-reset").addEventListener("click", () => state.chart.api?.timeScale().fitContent());
    $("#refresh-all").addEventListener("click", refreshAll);
    $("#refresh-feed").addEventListener("click", loadFeeds);
    ["#feed-symbol", "#feed-source", "#feed-importance"].forEach((selector) => $(selector).addEventListener("change", renderFeed));
    $$("[data-mobile-section]").forEach((button) => button.addEventListener("click", () => setMobileView(button.dataset.mobileSection)));
    const openSettings = () => openDrawer("#settings-drawer", "#settings-overlay");
    const openDeepAnalysis = () => {
      openSettings();
      const fullSymbols = targets().filter(({ analysis }) => analysis === "full").map(({ symbol }) => symbol);
      $("#settings-notice").textContent = fullSymbols.length
        ? `本次将运行 TradingAgents 多智能体深度分析：${fullSymbols.join("、")}`
        : "请先把至少一个标的的分析方式设为“深度”。";
    };
    $("#settings-open").addEventListener("click", () => navigateRoute("settings"));
    $("#deep-analysis-open").addEventListener("click", openDeepAnalysis);
    $("#mobile-settings").addEventListener("click", () => navigateRoute("settings"));
    $("#settings-workspace-open").addEventListener("click", openSettings);
    $("#watchlist-edit").addEventListener("click", openSettings);
    $("#global-status").addEventListener("click", () => navigateRoute("settings"));
    $("#settings-close").addEventListener("click", () => closeDrawer("#settings-drawer", "#settings-overlay"));
    $("#settings-overlay").addEventListener("click", () => closeDrawer("#settings-drawer", "#settings-overlay"));
    $("#target-add").addEventListener("click", addTarget);
    $("#target-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addTarget(); } });
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#run-analysis").addEventListener("click", runAnalysis);
    $("#run-analysis-left").addEventListener("click", openDeepAnalysis);
    $("#toggle-code").addEventListener("click", () => { const input = $("#settings-code"); input.type = input.type === "password" ? "text" : "password"; $("#toggle-code").textContent = input.type === "password" ? "显示" : "隐藏"; });
    $("#clear-credential").addEventListener("click", clearCredential);
    $("#assistant-open").addEventListener("click", openAssistant);
    $("#assistant-close").addEventListener("click", closeAssistant);
    $("#assistant-backdrop").addEventListener("click", closeAssistant);
    $("#chat-form").addEventListener("submit", sendChat);
    $("#thread-select").addEventListener("change", (event) => {
      state.threadId = event.target.value;
      renderThread();
      recoverThread(state.threadId);
    });
    $("#new-thread").addEventListener("click", () => createThread());
    $("#delete-thread").addEventListener("click", deleteCurrentThread);
    $("#open-latest-report").addEventListener("click", openLatestReport);
    $("#archive-refresh").addEventListener("click", async () => {
      await Promise.allSettled([loadLatest(), loadResearchWorkspace()]);
      toast("研究档案已刷新");
    });
    $("#archive-ask").addEventListener("click", () => {
      if (!state.selectedReportPath) {
        toast("请先选择一份研究报告", true);
        return;
      }
      $("#chat-context").textContent = `${state.selectedReportPath} · 当前档案`;
      openAssistant();
    });
    $("#news-workspace-refresh").addEventListener("click", loadFeeds);
    $("#tasks-run-now").addEventListener("click", openDeepAnalysis);
    $("#options-refresh").addEventListener("click", () => loadOptions({ announce: true }));
    window.addEventListener("workbench:routechange", (event) => {
      if (event.detail?.route === "options") loadOptions();
      if (["agents", "tasks", "archive"].includes(event.detail?.route)) {
        renderAgentWorkspace();
        renderTaskBoard();
        renderArchiveList();
      }
    });
    window.addEventListener("hashchange", applyRoute);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeDrawer("#settings-drawer", "#settings-overlay");
        closeAssistant();
      }
    });
    initializeChart();
  }

  async function init() {
    loadThreads();
    bindEvents();
    applyRoute();
    updateClock();
    setInterval(updateClock, 1000);
    await loadCredential();
    await loadSettings();
    await recoverThread(state.threadId);
    await Promise.allSettled([loadMarket(), loadQuoteStrip(), loadFeeds(), loadMonitor(), loadLatest(), loadResearchWorkspace()]);
    setInterval(pollWorkbenchData, 60000);
    setInterval(refreshOptionsIfVisible, OPTIONS_FAST_REFRESH_MS);
    setInterval(renderOptionsCountdown, 1000);
  }

  init().catch((error) => {
    console.error(error);
    toast("研究终端初始化失败，请刷新重试", true);
  });
})();
