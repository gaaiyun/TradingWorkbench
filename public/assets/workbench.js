import {
  applySeriesBatch,
  buildChatHistory,
  buildTaskTimeline,
  compactThreads,
  computeIndicators,
  computeNextRun,
  createLatestRequestGate,
  dailyHistoryLimit,
  filterFeedItems,
  groupFeedItems,
  marketSessionStates,
  mergeIncrementalBatch,
  normalizeEnvelope,
  notificationDeliveryBadges,
  selectConclusion,
} from "./workbench-data.mjs";
import { renderMarkdown } from "./workbench-markdown.mjs";
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
  PROFILE_LIMIT,
  PROFILE_STORAGE_KEY,
  TARGET_LIMIT,
  createProfileRequestCoordinator,
  currentProfileFor,
  isSettingsRevisionConflict,
  marketForProfileTarget,
  normalizeProfileTargetSymbol,
  profileRequestUrl,
  resetProfileContext,
  resolveSelectedProfileId,
  selectedProfileAfterMutation,
  settingsSnapshotFromPayload,
} from "./workbench-profiles.mjs";
import {
  OPTIONS_FAST_REFRESH_MS,
  normalizeVolguardPayload,
} from "./workbench-options.mjs";
import {
  archiveChatContext,
  archiveEntriesMatch,
  archivedResearchAfterRun,
  archivedResearchForRequest,
  buildArchiveEntries,
  buildArchiveFileTabs,
  buildArchiveReportUrl,
  buildPipelineStages,
  buildTemporaryResearchRequest,
  createTemporaryResearchRequestId,
  defaultArchiveFileTab,
  filterAuditedResults,
  latestResearchRun,
  legacyAuditIndex,
  legacyHistoryEntries,
  researchRunForRequest,
  researchTickerLimit,
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
    pendingResearch: "ta.workbench.pending-research.v1",
    selectedProfileId: PROFILE_STORAGE_KEY,
  };
  const state = {
    settings: null,
    settingsUpdatedAt: null,
    settingsMode: "loading",
    settingsWritable: false,
    settingsError: "",
    selectedProfileId: null,
    selectedSymbol: "515880.SS",
    timeframe: "15m",
    historyRange: "5y",
    market: normalizeEnvelope(null),
    quotes: new Map(),
    feeds: [],
    feedEnvelope: normalizeEnvelope(null),
    feedLastRefreshedAt: null,
    monitor: normalizeEnvelope(null),
    latest: null,
    history: [],
    legacyHistory: [],
    runs: [],
    pendingResearch: null,
    adhocHistory: [],
    adhocRuns: [],
    adhocReportAudit: null,
    reportAudit: null,
    legacyReportAudit: null,
    showAuditReports: false,
    archiveEntries: [],
    selectedReportPath: null,
    selectedReportSection: null,
    selectedReportContent: "",
    selectedReportEntry: null,
    accessCode: "",
    rememberCode: false,
    chart: { bars: [], api: null, series: null, symbol: null, timeframe: null, hydrated: false },
    indicators: { volume: true, ma20: true, ma60: true },
    chatBusy: false,
    latestReport: null,
    latestReportIdentity: null,
    threads: [],
    threadId: null,
    threadStorageWarningShown: false,
    options: normalizeVolguardPayload(null),
    optionsNextAt: null,
  };
  const marketRequestGate = createLatestRequestGate();
  const profileRequests = createProfileRequestCoordinator();

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
      timeZone: currentProfile()?.timezone || "Asia/Shanghai",
      ...(full ? { month: "2-digit", day: "2-digit" } : {}),
      hour: "2-digit", minute: "2-digit", second: full ? "2-digit" : undefined, hour12: false,
    }).format(date);
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: currentProfile()?.timezone || "Asia/Shanghai",
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
    if (["US", "HK"].includes(market)) return Number(change) >= 0 ? "us-market-up" : "us-market-down";
    return Number(change) >= 0 ? "market-up" : "market-down";
  }

  function marketPalette(market) {
    return ["US", "HK"].includes(market)
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

  function currentProfile() {
    return currentProfileFor(state.settings, state.selectedProfileId);
  }

  function persistSelectedProfileId() {
    if (!state.selectedProfileId) return;
    try {
      localStorage.setItem(STORAGE.selectedProfileId, state.selectedProfileId);
    } catch {
      // Profile selection remains valid for the current page even if storage is full.
    }
  }

  function targets() {
    const profile = currentProfile();
    return profile?.targets || [];
  }

  function settingsTickers(settings) {
    const profile = currentProfileFor(settings, state.selectedProfileId);
    if (!profile) return Array.isArray(settings?.tickers) ? settings.tickers : [];
    return (profile.targets || [])
      .filter((target) => target.analysis === "full")
      .map((target) => target.symbol);
  }

  function renderProfileSelectors() {
    const profiles = state.settings?.profiles || [];
    const options = profiles.map((profile) =>
      `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}${profile.enabled ? "" : " · 已停用"}</option>`
    ).join("") || '<option value="">配置不可用</option>';
    for (const selector of ["#profile-selector", "#settings-profile-selector"]) {
      const select = $(selector);
      select.innerHTML = options;
      select.value = state.selectedProfileId || "";
    }
    $("#profile-count").textContent = `${profiles.length} / ${PROFILE_LIMIT} 组`;
    updateSettingsControlAvailability();
  }

  function updateSettingsControlAvailability() {
    const readOnly = !state.settingsWritable;
    const allowedWhileReadOnly = new Set([
      "settings-profile-selector",
      "settings-reload-remote",
      "settings-code",
      "toggle-code",
      "clear-credential",
    ]);
    $$("input, select, textarea, button", $("#settings-form")).forEach((control) => {
      control.disabled = readOnly && !allowedWhileReadOnly.has(control.id);
    });

    const profiles = state.settings?.profiles || [];
    $("#settings-profile-selector").disabled = profiles.length === 0;
    if (!readOnly) {
      $("#profile-create").disabled = profiles.length >= PROFILE_LIMIT;
      $("#profile-copy").disabled = profiles.length >= PROFILE_LIMIT || !currentProfile();
      $("#profile-delete").disabled = profiles.length <= 1 || !currentProfile();
    }
    $("#settings-reload-remote").hidden = state.settingsMode === "ready";
  }

  function renderSettingsAvailability() {
    const notice = $("#settings-notice");
    if (state.settingsMode === "degraded") {
      notice.className = "settings-notice is-error";
      notice.textContent = "远端设置不可用，当前使用静态灾备快照；此模式仅供查看，不能保存。";
    } else if (state.settingsMode === "unavailable") {
      notice.className = "settings-notice is-error";
      notice.textContent = `远端监控配置不可用：${state.settingsError || "请重试"}`;
    }
    updateSettingsControlAvailability();
  }

  function renderSettingsSummary() {
    renderProfileSelectors();
    const profile = currentProfile();
    if (!profile) {
      renderTargetEditor();
      renderWatchlist();
      renderInstrument();
      renderNextRun();
      renderTimeline();
      renderTaskBoard();
      renderSettingsWorkspace();
      renderSettingsAvailability();
      return;
    }
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
    renderSettingsAvailability();
  }

  function restoreSelectedProfile() {
    let storedId = null;
    try { storedId = localStorage.getItem(STORAGE.selectedProfileId); } catch { /* unavailable */ }
    state.selectedProfileId = resolveSelectedProfileId(
      state.settings?.profiles,
      state.selectedProfileId || storedId,
    );
    persistSelectedProfileId();
    const profile = currentProfile();
    if (profile && !profile.targets?.some(({ symbol }) => symbol === state.selectedSymbol)) {
      state.selectedSymbol = profile.targets?.[0]?.symbol || null;
    }
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
    const target = targets().find((item) => item.symbol === state.selectedSymbol) || targets()[0];
    if (!target) {
      $("#instrument-symbol").textContent = "—";
      $("#instrument-name").textContent = "当前监控组没有标的";
      $("#instrument-role").textContent = "空";
      $("#instrument-price").textContent = "—";
      $("#instrument-change").textContent = "—";
      $("#instrument-change").className = "neutral";
      for (const selector of ["#quote-open", "#quote-high", "#quote-low", "#quote-volume"]) {
        $(selector).textContent = "—";
      }
      $("#history-range-tabs").hidden = true;
      return;
    }
    const isDailyMarket = target.market !== "CN";
    const isDaily = state.timeframe === "1d";
    const bars = state.chart.bars;
    const bar = bars.at(-1);
    const previous = bars.at(-2);
    const change = bar && previous && Number(previous.close) !== 0 ? (Number(bar.close) / Number(previous.close) - 1) * 100 : null;
    $("#instrument-symbol").textContent = target.symbol;
    $("#instrument-name").textContent = `${target.name} · ${target.market === "CN" ? "A 股" : target.market === "HK" ? "港股" : "美股"}`;
    $("#instrument-role").textContent = roleLabels[target.role] || target.role;
    $("#instrument-price").textContent = formatNumber(bar?.close);
    $("#instrument-change").textContent = change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    $("#instrument-change").className = marketTone(change, target.market);
    $("#quote-open").textContent = formatNumber(bar?.open);
    $("#quote-high").textContent = formatNumber(bar?.high);
    $("#quote-low").textContent = formatNumber(bar?.low);
    $("#quote-volume").textContent = formatVolume(bar?.volume);
    $("#history-range-tabs").hidden = !isDaily;
    $$("[data-timeframe]").forEach((button) => {
      button.disabled = isDailyMarket && button.dataset.timeframe !== "1d";
    });
    if (isDaily && bars.length) {
      const first = bars[0];
      const source = state.market.sources?.[0];
      const degraded = state.market.status === "degraded" || state.market.status === "stale";
      const marketClosed = !marketSessionStates()[target.market]?.open;
      const stateLabel = state.market.status === "stale" && marketClosed
        ? " · 休市，沿用最近收盘"
        : degraded ? ` · ${source?.source || "来源"}降级` : "";
      $("#chart-coverage").textContent = `覆盖 ${formatDate(first.ts)}–${formatDate(bar.ts)} · ${bars.length} 日${stateLabel}`;
    } else {
      $("#chart-coverage").textContent = "覆盖 —";
    }
  }

  function updateFreshness(envelope) {
    const source = envelope.sources?.[0] || {};
    const selectedMarket = targets().find(({ symbol }) => symbol === state.selectedSymbol)?.market;
    const marketClosed = selectedMarket && !marketSessionStates()[selectedMarket]?.open;
    const closedSnapshot = envelope.status === "stale" && marketClosed;
    $("#freshness-status").textContent = closedSnapshot ? "CLOSED" : envelope.status.toUpperCase();
    $("#freshness-status").dataset.status = envelope.status;
    $("#freshness-asof").textContent = formatTime(envelope.asOf, true);
    $("#freshness-fetched").textContent = formatTime(source.fetchedAt, true);
    $("#freshness-source").textContent = source.source || "—";
    $("#freshness-detail").textContent = envelope.error || `${closedSnapshot ? "market closed · latest close" : `freshness ${source.freshness || "unknown"}`} · quality ${source.quality || "unknown"} · adjustment ${source.adjustment || "—"}`;
    const dot = $(".status-dot", $("#global-status"));
    dot.className = `status-dot is-${envelope.status}`;
    $("#global-status span").textContent = closedSnapshot
      ? "休市 · 最近收盘"
      : envelope.status === "ok" ? "数据正常" : envelope.status === "unavailable" ? "数据不可用" : `数据${envelope.status === "stale" ? "陈旧" : "降级"}`;
  }

  async function loadSettings() {
    let snapshot;
    try {
      const payload = await requestJson("/api/settings");
      snapshot = settingsSnapshotFromPayload(payload);
      if (snapshot.mode === "unavailable") throw new Error(snapshot.error);
    } catch (remoteError) {
      try {
        snapshot = settingsSnapshotFromPayload(
          await requestJson("./data/workbench-settings.json"),
          { source: "static" },
        );
      } catch {
        snapshot = {
          mode: "unavailable",
          settings: null,
          revision: null,
          writable: false,
          error: remoteError?.message || "请重试",
        };
      }
    }
    state.settings = snapshot.settings;
    state.settingsUpdatedAt = snapshot.revision;
    state.settingsMode = snapshot.mode;
    state.settingsWritable = snapshot.writable;
    state.settingsError = snapshot.error || "";
    restoreSelectedProfile();
    profileRequests.activate(state.selectedProfileId);
    renderSettingsSummary();
  }

  function marketUrl(symbol, timeframe, profileId, limit = 240) {
    return profileRequestUrl("/api/market", profileId, { symbol, timeframe, limit });
  }

  function sortBars(rows) {
    return rows.filter((bar) => bar?.ts).sort((a, b) => a.ts.localeCompare(b.ts));
  }

  function marketContext(profileId, symbol) {
    return `${profileId || "no-profile"}:${symbol || "no-symbol"}`;
  }

  async function loadMarket({ incremental = false } = {}) {
    const symbol = state.selectedSymbol;
    const timeframe = state.timeframe;
    const profileId = currentProfile()?.id;
    if (!symbol || !profileId) {
      state.chart.bars = [];
      state.chart.hydrated = false;
      state.market = normalizeEnvelope(null);
      $("#chart-empty").hidden = false;
      renderInstrument();
      syncChartData({ strategy: "setData" });
      return;
    }
    const requestContext = marketContext(profileId, symbol);
    const contextChanged = state.chart.symbol !== symbol || state.chart.timeframe !== timeframe;
    if (incremental && (contextChanged || !state.chart.hydrated)) return;
    const request = marketRequestGate.begin(requestContext, timeframe, incremental ? "incremental" : "full");
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
      const fullLimit = timeframe === "1d"
        ? dailyHistoryLimit(state.historyRange)
        : 240;
      const envelope = normalizeEnvelope(await requestJson(
        marketUrl(symbol, timeframe, currentProfile()?.id, incremental ? 2 : fullLimit),
        { signal: request.signal },
      ));
      if (!marketRequestGate.isCurrent(
        request,
        marketContext(currentProfile()?.id, state.selectedSymbol),
        state.timeframe,
      )) return;
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
      if (request.signal.aborted || !marketRequestGate.isCurrent(
        request,
        marketContext(currentProfile()?.id, state.selectedSymbol),
        state.timeframe,
      )) return;
      state.market = normalizeEnvelope(null);
      if (!incremental) {
        state.chart.bars = [];
        state.chart.hydrated = false;
      }
      updateFreshness(state.market);
    } finally {
      marketRequestGate.finish(request);
    }
    if (!marketRequestGate.isCurrent(
      request,
      marketContext(currentProfile()?.id, state.selectedSymbol),
      state.timeframe,
    )) return;
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
    const profileId = currentProfile()?.id;
    if (!profileId) return;
    const otherTargets = targets().filter(({ symbol }) => symbol !== state.selectedSymbol);
    await Promise.allSettled(otherTargets.map(async ({ symbol, market }) => {
      const quoteTimeframe = market === "CN" ? state.timeframe : "1d";
      const envelope = normalizeEnvelope(await requestJson(
        marketUrl(symbol, quoteTimeframe, profileId, 2),
      ));
      if (currentProfile()?.id !== profileId) return;
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
    const profileId = currentProfile()?.id;
    if (!profileId) return;
    const request = profileRequests.begin("feeds");
    try {
      const [newsResult, eventsResult] = await Promise.allSettled([
        requestJson(
          profileRequestUrl("/api/news", profileId, { limit: 200 }),
          { signal: request.signal },
        ),
        requestJson(
          profileRequestUrl("/api/events", profileId, { limit: 200 }),
          { signal: request.signal },
        ),
      ]);
      if (!profileRequests.isCurrent(request)) return;
      const news = normalizeEnvelope(newsResult.status === "fulfilled" ? newsResult.value : null);
      const events = normalizeEnvelope(eventsResult.status === "fulfilled" ? eventsResult.value : null);
      state.feeds = groupFeedItems([
        ...normalizeFeed(news, "news"),
        ...normalizeFeed(events, "event"),
      ])
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
      state.feedLastRefreshedAt = new Date().toISOString();
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
    } finally {
      profileRequests.finish(request);
    }
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
      const deliveryBadges = notificationDeliveryBadges(item.deliveries)
        .map(({ tone, text }) => `<span class="delivery-badge is-${escapeHtml(tone)}">${escapeHtml(text)}</span>`)
        .join("");
      return `<${tag} class="feed-item"${link}>
        <div class="feed-item-meta"><i class="importance ${escapeHtml(item.importance)}"></i><span>${escapeHtml(item.type === "event" ? "EVENT" : "NEWS")}</span><span>${escapeHtml((item.symbols || [item.symbol]).filter(Boolean).join(" · ") || "MARKET")}</span><span>${formatTime(item.at, true)}</span></div>
        <h3>${escapeHtml(item.title || "未命名事件")}</h3>
        <p>${escapeHtml(item.summary)}</p>
        ${deliveryBadges ? `<div class="delivery-badges">${deliveryBadges}</div>` : ""}
        <div class="feed-item-foot"><span>${escapeHtml(item.source)}</span><span>${escapeHtml(item.importance.toUpperCase())}</span></div>
      </${tag}>`;
    }).join("");
  }

  async function loadMonitor() {
    const profileId = currentProfile()?.id;
    if (!profileId) return;
    const request = profileRequests.begin("monitor");
    try {
      const monitor = normalizeEnvelope(await requestJson(
        profileRequestUrl("/api/monitor-status", profileId, { limit: 20 }),
        { signal: request.signal },
      ));
      if (!profileRequests.isCurrent(request)) return;
      state.monitor = monitor;
    }
    catch {
      if (!profileRequests.isCurrent(request)) return;
      state.monitor = normalizeEnvelope(null);
    } finally {
      profileRequests.finish(request);
    }
    renderTimeline();
    renderMonitorStatus();
  }

  function renderTimeline() {
    const profile = currentProfile();
    const schedules = buildTaskTimeline(profile);
    $("#task-timeline").innerHTML = schedules.map(({ time, label, status, detail }) => {
      return `<li class="is-${escapeHtml(status)}"><time>${escapeHtml(time)}</time><span><b>${escapeHtml(label)}</b><small>${escapeHtml(detail)}</small></span></li>`;
    }).join("") || (profile?.enabled === false
      ? '<li class="is-disabled"><time>—</time><span><b>监控组已停用</b><small>不会创建或等待计划任务</small></span></li>'
      : '<li class="is-disabled"><time>—</time><span><b>未启用计划</b><small>在设置中启用监控</small></span></li>');
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

  function renderSellerDesk(view) {
    const desk = view.sellerDesk || {};
    const statusLabels = {
      premium_positive: "IV 溢价",
      premium_negative: "补偿不足",
      neutral: "中性",
      insufficient_data: "数据不足",
    };
    $("#options-seller-status").textContent = statusLabels[desk.status] || "数据不足";
    const node = $("#options-seller-desk");
    node.className = `seller-desk ${
      desk.status === "premium_positive"
        ? "is-positive"
        : desk.status === "premium_negative"
          ? "is-caution"
          : ""
    }`;
    const candidate = (label, row) => {
      if (!row) return `${label}：暂无满足流动性条件的候选`;
      const greek = Number.isFinite(row.delta) ? `Δ ${row.delta.toFixed(2)}` : "Δ 未提供";
      return `${label}：${row.name || row.code || "合约"} · ${greek} · OI ${formatVolume(row.openInterest)}`;
    };
    const warnings = Array.isArray(desk.warnings) && desk.warnings.length
      ? desk.warnings.join("；")
      : "指标覆盖与盘口质量满足当前展示条件";
    node.innerHTML = `
      <strong>${escapeHtml(desk.recommendation || "暂不生成卖方方向建议")}</strong>
      <span>IV-HV ${escapeHtml(optionValue(desk.ivHvGap, { digits: 1, suffix: "pp", signed: true }))} · ${escapeHtml(candidate("认沽观察", desk.putCandidate))}</span>
      <span>${escapeHtml(candidate("认购观察", desk.callCandidate))}</span>
      <small>${escapeHtml(warnings)} · ${escapeHtml(desk.disclaimer || "研究提示，不是自动下单指令")}</small>
    `;
  }

  function renderOptions() {
    const view = state.options;
    renderSellerDesk(view);
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
    const totalContracts = view.contractCount || rows.length;
    const ivCount = view.options.filter((row) => Number.isFinite(row.iv)).length;
    const greekCount = view.options.filter((row) =>
      Number.isFinite(row.delta) &&
      Number.isFinite(row.gamma) &&
      Number.isFinite(row.vega) &&
      Number.isFinite(row.theta),
    ).length;
    $("#options-chain-coverage").textContent =
      `${totalContracts} 条合约 · IV ${ivCount}/${totalContracts} · Greeks ${greekCount}/${totalContracts}`;
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
    const depth = $("#agent-research-depth")?.value || "standard";
    $("#agent-input-status").textContent = `${depth} · 最多 ${researchTickerLimit(depth)} 个`;

    const pending = state.pendingResearch;
    const archivedBatch = pending
      ? archivedResearchForRequest(state.adhocHistory, pending.requestId)
      : null;
    const run = pending
      ? researchRunForRequest(state.adhocRuns, pending.requestId)
      : latestResearchRun(state.runs);
    const archivedAfterRun = pending
      ? Boolean(archivedBatch)
      : archivedResearchAfterRun(run, state.latest);
    const activeResult = archivedBatch || (pending ? null : state.latest);
    const pipelineRun = archivedAfterRun
      ? { ...(run || {}), status: "completed", conclusion: "success" }
      : run;
    const stageLabels = { pending: "待运行", queued: "已排队", running: "运行中", completed: "已完成", failed: "失败", unknown: "未确认" };
    for (const stage of buildPipelineStages(pipelineRun)) {
      const row = $(`[data-stage="${stage.id}"]`, $("#agent-pipeline"));
      row.className = `is-${stage.status}`;
      $("em", row).textContent = stageLabels[stage.status];
    }
    $("#agent-run-asof").textContent = run
      ? formatTime(run.created_at, true)
      : pending ? `请求 ${pending.requestId.slice(0, 8)}` : "没有运行记录";

    const resultCount = Array.isArray(activeResult?.results)
      ? activeResult.results.filter(({ error }) => !error).length
      : 0;
    if (pending && !run && !archivedBatch) {
      $("#agent-run-card").className = "panel-empty";
      $("#agent-run-card").innerHTML = `<b>已受理，等待进入队列</b><span>${escapeHtml(pending.tickers.join(" · "))} · 请求 ${escapeHtml(pending.requestId.slice(0, 8))}</span>`;
      return;
    }
    if (!run && !activeResult) {
      $("#agent-run-card").className = "panel-empty";
      $("#agent-run-card").innerHTML = "<b>尚未开始新的研究</b><span>运行后将记录输入时间、来源、降级情况、模型、耗时和未解决问题。</span>";
      return;
    }
    $("#agent-run-card").className = "run-card-grid";
    const runStatus = archivedAfterRun
      ? "分析已完成"
      : run?.status || activeResult?.status || "已归档";
    const runConclusion = archivedAfterRun
      ? "报告已归档 · 后续发布失败"
      : run?.conclusion || "等待结论";
    $("#agent-run-card").innerHTML = `
      <div><span>运行状态</span><b>${escapeHtml(runStatus)}</b><small>${escapeHtml(runConclusion)}</small></div>
      <div><span>研究日期</span><b>${escapeHtml(activeResult?.trade_date || "—")}</b><small>${escapeHtml(formatTime(activeResult?.generated_at || run?.created_at, true))}</small></div>
      <div><span>模型 / Provider</span><b>${escapeHtml(activeResult?.provider || "—")}</b><small>${escapeHtml((activeResult?.analysts || activeResult?.request?.analysts || []).join(" · ") || "未提供分析师清单")}</small></div>
      <div><span>研究结果</span><b>${resultCount}</b><small>${escapeHtml(run?.workflow || "归档结果")}</small>
        ${pending && archivedBatch ? '<button class="text-button" id="agent-open-adhoc-report" type="button">查看临时研究报告</button>' : ""}
      </div>`;
    $("#agent-open-adhoc-report")?.addEventListener("click", openAdhocReport);
  }

  function renderTaskBoard() {
    const profile = currentProfile();
    const rows = buildTaskTimeline(profile);
    $("#task-board").innerHTML = rows.map(({ time, label, status, detail }) => `<li class="is-${escapeHtml(status)}">
      <time>${escapeHtml(time)}</time>
      <div><b>${escapeHtml(label)}</b><small>${escapeHtml(detail)}</small></div>
      <span>${escapeHtml(status === "success" ? "成功" : status === "failed" ? "失败" : status === "running" ? "运行中" : "等待结果")}</span>
    </li>`).join("") || (profile?.enabled === false
      ? "<li class=\"is-disabled\"><time>—</time><div><b>监控组已停用</b><small>不会创建或等待计划任务。</small></div><span>已停用</span></li>"
      : "<li class=\"is-disabled\"><time>—</time><div><b>未启用研究计划</b><small>在设置中启用至少一个时段。</small></div><span>已停用</span></li>");
  }

  function renderArchiveList() {
    const combinedAudit = {
      reports: [
        ...(Array.isArray(state.reportAudit?.reports) ? state.reportAudit.reports : []),
        ...(Array.isArray(state.legacyReportAudit?.reports) ? state.legacyReportAudit.reports : []),
        ...(Array.isArray(state.adhocReportAudit?.reports) ? state.adhocReportAudit.reports : []),
      ],
    };
    state.archiveEntries = buildArchiveEntries(
      [...state.history, ...state.legacyHistory, ...state.adhocHistory],
      combinedAudit,
      { includeInvalidated: state.showAuditReports },
    );
    $("#archive-count").textContent = `${state.archiveEntries.length} 份${state.showAuditReports ? " · 历史审计" : ""}`;
    const auditToggle = $("#archive-show-audit");
    if (auditToggle) {
      auditToggle.textContent = state.showAuditReports ? "返回可用档案" : "历史审计";
      auditToggle.setAttribute("aria-pressed", String(state.showAuditReports));
    }
    if (!state.archiveEntries.length) {
      $("#archive-list").className = "panel-empty";
      $("#archive-list").innerHTML = state.showAuditReports
        ? "<b>没有历史审计档案</b><span>审计索引尚未返回可查看的旧报告。</span>"
        : "<b>没有可用研究档案</b><span>已失效报告默认隐藏；可切换“历史审计”查看原文。</span>";
      return;
    }
    $("#archive-list").className = "archive-list";
    const auditLabels = {
      verified: "已验证",
      legacy_unverified: "历史未验证",
      invalidated: "已失效",
      invalid_record: "记录无效",
      unverified: "未登记",
    };
    $("#archive-list").innerHTML = state.archiveEntries.map((entry, index) => `<button type="button" data-archive-index="${index}" data-report-scope="${escapeHtml(entry.identity?.scope || "invalid")}" data-report-profile="${escapeHtml(entry.identity?.profileId || "")}" data-report-request-id="${escapeHtml(entry.identity?.requestId || "")}" class="${archiveEntriesMatch(entry, state.selectedReportEntry) ? "is-active" : ""} is-audit-${escapeHtml(entry.auditStatus)}">
      <span><b>${escapeHtml(entry.ticker)}</b><em>${escapeHtml(entry.rating || "—")}</em></span>
      <small>${escapeHtml(entry.tradeDate || formatTime(entry.generatedAt, true))} · ${escapeHtml(entry.provider || "unknown")} · <strong class="audit-badge audit-${escapeHtml(entry.auditStatus)}">${escapeHtml(auditLabels[entry.auditStatus] || "未登记")}</strong></small>
    </button>`).join("");
    $$("[data-archive-index]", $("#archive-list")).forEach((button) => button.addEventListener("click", () => {
      loadArchiveReport(state.archiveEntries[Number(button.dataset.archiveIndex)]);
    }));
  }

  async function fetchReportText(entry, path, signal) {
    const response = await fetch(
      buildArchiveReportUrl(entry, path),
      { cache: "no-store", signal },
    );
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        detail = payload?.error ? `：${payload.error}` : "";
      } catch {
        // Non-JSON errors still retain the real HTTP response status.
      }
      throw new Error(`报告读取失败 (${response.status})${detail}`);
    }
    return response.text();
  }

  function archiveAuditNotice(entry) {
    if (entry.auditStatus === "invalidated" || entry.auditStatus === "invalid_record") {
      return "这份报告已失效，仅用于历史审计，不进入最新观点或问答上下文。";
    }
    if (entry.auditStatus === "legacy_unverified") {
      return "这份报告属于历史未验证档案，原文保留，但不能作为当前证据结论。";
    }
    if (entry.auditStatus && entry.auditStatus !== "verified") {
      return "这份报告尚未通过证据审计，请勿将其作为当前结论。";
    }
    return "";
  }

  function renderArchiveWarning(entry) {
    const warning = $("#archive-report-warning");
    const notice = archiveAuditNotice(entry)
      || (archiveChatContext(entry) ? "" : "这份报告的运行身份无法验证，不能进入问答上下文。");
    warning.hidden = !notice;
    warning.className = `report-warning audit-${escapeHtml(entry.auditStatus || "unverified")}`;
    warning.textContent = notice;
  }

  function renderArchiveTabs(tabs) {
    const nav = $("#archive-report-tabs");
    nav.hidden = !tabs.length;
    nav.setAttribute("role", "tablist");
    nav.innerHTML = tabs.map((tab) => {
      const selected = tab.id === state.selectedReportSection;
      return `<button type="button" role="tab" data-report-section="${escapeHtml(tab.id)}" class="${selected ? "is-active" : ""}" aria-selected="${selected}" tabindex="${selected ? "0" : "-1"}">${escapeHtml(tab.label)}</button>`;
    }).join("");
    const buttons = $$("[data-report-section]", nav);
    buttons.forEach((button, index) => {
      button.addEventListener("click", () => {
        const tab = tabs.find(({ id }) => id === button.dataset.reportSection);
        if (tab) loadArchiveFile(tab, tabs);
      });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const next = buttons[(index + direction + buttons.length) % buttons.length];
        const nextSection = next.dataset.reportSection;
        next.click();
        queueMicrotask(() => {
          $(`[data-report-section="${CSS.escape(nextSection)}"]`, nav)?.focus();
        });
      });
    });
  }

  async function loadArchiveFile(tab, tabs) {
    if (!tab?.path) return;
    const entry = state.selectedReportEntry;
    if (!entry) return;
    let reportUrl;
    try {
      reportUrl = buildArchiveReportUrl(entry, tab.path);
    } catch (error) {
      $("#archive-report-body").className = "panel-empty";
      $("#archive-report-body").innerHTML = `<b>报告暂不可用</b><span>${escapeHtml(error.message)}</span>`;
      return;
    }
    const request = profileRequests.begin("report", reportUrl);
    state.selectedReportSection = tab.id;
    state.selectedReportContent = "";
    renderArchiveTabs(tabs);
    $("#archive-report-body").className = "panel-empty";
    $("#archive-report-body").innerHTML = `<b>正在读取${escapeHtml(tab.label)}</b><span>${escapeHtml(tab.path)}</span>`;
    try {
      const content = await fetchReportText(entry, tab.path, request.signal);
      if (!profileRequests.isCurrent(request)) return;
      state.selectedReportContent = content;
      $("#archive-report-body").className = "archive-markdown";
      $("#archive-report-body").innerHTML = renderMarkdown(state.selectedReportContent);
    } catch (error) {
      if (!profileRequests.isCurrent(request)) return;
      $("#archive-report-body").className = "panel-empty";
      $("#archive-report-body").innerHTML = `<b>报告暂不可用</b><span>${escapeHtml(error.message)}</span><button class="button" id="archive-report-retry" type="button">重试</button>`;
      $("#archive-report-retry").addEventListener(
        "click",
        () => loadArchiveFile(tab, tabs),
      );
    } finally {
      profileRequests.finish(request);
    }
  }

  async function loadArchiveReport(entry) {
    if (!entry?.report) {
      toast("找不到带运行身份的研究档案", true);
      return;
    }
    const tabs = buildArchiveFileTabs(entry);
    const initialTab = defaultArchiveFileTab(tabs);
    state.selectedReportPath = entry.report;
    state.selectedReportEntry = entry;
    state.selectedReportSection = initialTab?.id || null;
    $("#archive-report-title").textContent = `${entry.ticker} · ${entry.tradeDate || "研究报告"}`;
    renderArchiveWarning(entry);
    renderArchiveList();
    $("#archive-ask").disabled = !archiveChatContext(entry);
    if (initialTab) await loadArchiveFile(initialTab, tabs);
  }

  async function loadResearchWorkspace() {
    const profileId = currentProfile()?.id;
    if (!profileId) return;
    const request = profileRequests.begin("research");
    try {
      const [
        historyResult,
        runsResult,
        auditResult,
        legacyHistoryResult,
        legacyAuditResult,
      ] = await Promise.allSettled([
        requestJson(profileRequestUrl("/api/history", profileId), { signal: request.signal }),
        requestJson(profileRequestUrl("/api/runs", profileId), { signal: request.signal }),
        requestJson(profileRequestUrl("/api/report-audit", profileId), { signal: request.signal }),
        requestJson("/api/history", { signal: request.signal }),
        requestJson("/api/report-audit", { signal: request.signal }),
      ]);
      if (!profileRequests.isCurrent(request)) return;
      if (historyResult.status === "fulfilled") {
        const payload = historyResult.value;
        state.history = Array.isArray(payload) ? payload : payload?.data || payload?.history || [];
      } else {
        state.history = [];
      }
      if (runsResult.status === "fulfilled") {
        const payload = runsResult.value;
        state.runs = payload?.runs || payload?.data || [];
      } else {
        state.runs = [];
      }
      if (auditResult.status === "fulfilled") {
        state.reportAudit = auditResult.value?.data || auditResult.value;
      } else {
        state.reportAudit = null;
      }
      if (legacyHistoryResult.status === "fulfilled") {
        const payload = legacyHistoryResult.value;
        state.legacyHistory = legacyHistoryEntries(
          Array.isArray(payload) ? payload : payload?.data || payload?.history || [],
        );
      } else {
        state.legacyHistory = [];
      }
      if (legacyAuditResult.status === "fulfilled") {
        state.legacyReportAudit = legacyAuditIndex(
          legacyAuditResult.value?.data || legacyAuditResult.value,
        );
      } else {
        state.legacyReportAudit = null;
      }
      if (state.latest) {
        state.latest = {
          ...state.latest,
          results: filterAuditedResults(
            state.latest.results,
            state.reportAudit,
            { verifiedOnly: true, identity: state.latest.identity },
          ),
        };
      }
      renderAgentWorkspace();
      renderTaskBoard();
      renderArchiveList();
    } finally {
      profileRequests.finish(request);
    }
  }

  async function loadPendingResearchWorkspace() {
    if (!state.pendingResearch?.requestId) return;
    const requestId = state.pendingResearch.requestId;
    const [historyResult, runsResult, auditResult] = await Promise.allSettled([
      requestJson(profileRequestUrl("/api/history", null, { requestId })),
      requestJson(profileRequestUrl("/api/runs", null, { requestId })),
      requestJson(profileRequestUrl("/api/report-audit", null, { requestId })),
    ]);
    if (state.pendingResearch?.requestId !== requestId) return;
    if (historyResult.status === "fulfilled") {
      const payload = historyResult.value;
      state.adhocHistory = Array.isArray(payload)
        ? payload
        : payload?.data || payload?.history || [];
    }
    if (runsResult.status === "fulfilled") {
      const payload = runsResult.value;
      state.adhocRuns = payload?.runs || payload?.data || [];
    }
    if (auditResult.status === "fulfilled") {
      state.adhocReportAudit = auditResult.value?.data || auditResult.value;
    }
    renderAgentWorkspace();
    renderArchiveList();
  }

  async function openAdhocReport() {
    const requestId = state.pendingResearch?.requestId;
    const batch = archivedResearchForRequest(state.adhocHistory, requestId);
    if (!batch) {
      toast("临时研究尚未生成可查看报告", true);
      return;
    }
    const [entry] = buildArchiveEntries([batch], state.adhocReportAudit, {
      includeInvalidated: true,
    });
    if (!entry) {
      toast("临时研究没有可查看的报告", true);
      return;
    }
    navigateRoute("archive");
    await loadArchiveReport(entry);
  }

  function renderNewsWorkspace() {
    $("#news-workspace-asof").textContent = `${state.feeds.length} 条 · 内容 ${formatTime(state.feedEnvelope.asOf, true)} · 刷新 ${formatTime(state.feedLastRefreshedAt)}`;
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
      const delivery = notificationDeliveryBadges(item.deliveries)
        .map(({ text }) => text)
        .join(" · ");
      return `<${tag} class="evidence-row"${link}>
        <time>${escapeHtml(formatTime(item.at, true))}</time>
        <div><span>${escapeHtml((item.symbols || [item.symbol]).filter(Boolean).join(" · ") || "MARKET")} · ${escapeHtml(tier)}</span><b>${escapeHtml(item.title || "未命名事件")}</b><small>${escapeHtml(item.summary || "没有可验证摘要")}${delivery ? ` · ${escapeHtml(delivery)}` : ""}</small></div>
        <em>${escapeHtml(item.source || "unknown")}</em>
        <strong>${escapeHtml(String(item.importance || "medium").toUpperCase())}</strong>
      </${tag}>`;
    }).join("");
  }

  function renderSettingsWorkspace() {
    const profile = currentProfile();
    if (!profile) {
      $("#settings-workspace-status").textContent = "配置不可用";
      $("#settings-workspace-summary").className = "panel-empty";
      $("#settings-workspace-summary").innerHTML = "<b>远端监控配置不可用</b><span>请打开设置并重试；系统不会生成默认监控组。</span>";
      return;
    }
    const enabledTargets = profile.targets || [];
    $("#settings-workspace-status").textContent = state.settingsMode === "degraded"
      ? "降级只读"
      : profile.enabled ? "已启用" : "已停用";
    $("#settings-workspace-summary").className = "settings-summary-grid";
    $("#settings-workspace-summary").innerHTML = `
      <div><span>研究目标</span><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.objective)}</small></div>
      <div><span>标的配置</span><b>${enabledTargets.length} 个</b><small>${escapeHtml(enabledTargets.map(({ symbol }) => symbol).join(" · "))}</small></div>
      <div><span>盘中频率</span><b>${escapeHtml(String(profile.schedules?.cnIntraday?.collectionIntervalMinutes || 5))} / ${escapeHtml(String(profile.schedules?.cnIntraday?.signalIntervalMinutes || 15))} 分钟</b><small>采集 / 信号</small></div>
      <div><span>提醒规则</span><b>${escapeHtml(profile.alerts?.pushMinSeverity || "high")}</b><small>${escapeHtml(`${profile.alerts?.quietHours?.start || "22:30"}–${profile.alerts?.quietHours?.end || "07:30"} 静默`)}</small></div>`;
  }

  function renderNextRun() {
    const next = computeNextRun(currentProfile());
    const text = next ? `${next.label} ${formatTime(next.at, true)}` : "下一次 —";
    $("#next-run").textContent = text;
    $("#next-run-compact").textContent = text;
  }

  async function loadLatest() {
    const profileId = currentProfile()?.id;
    if (!profileId) return;
    const request = profileRequests.begin("latest");
    try {
      const payload = await requestJson(
        profileRequestUrl("/api/latest", profileId),
        { signal: request.signal },
      );
      if (!profileRequests.isCurrent(request)) return;
      state.latest = payload?.data || payload;
    } catch {
      if (!profileRequests.isCurrent(request)) return;
      state.latest = null;
    } finally {
      profileRequests.finish(request);
    }
    if (state.latest) {
      state.latest = {
        ...state.latest,
        results: filterAuditedResults(
          state.latest.results,
          state.reportAudit,
          { verifiedOnly: true, identity: state.latest.identity },
        ),
      };
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
      state.latestReportIdentity = null;
      return;
    }
    state.latestReport = result.report;
    state.latestReportIdentity = state.latest?.identity
      ? { ...state.latest.identity }
      : null;
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
    if (target?.market !== "CN" && state.timeframe !== "1d") {
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

  function renderClearedProfileContext() {
    renderSettingsSummary();
    renderInstrument();
    renderConclusion();
    renderFeed();
    renderNewsWorkspace();
    renderMonitorStatus();
    renderArchiveList();
    updateFreshness(state.market);
    syncChartData({ strategy: "setData" });
    $("#archive-report-title").textContent = "选择一份报告";
    $("#archive-report-warning").hidden = true;
    $("#archive-report-tabs").hidden = true;
    $("#archive-ask").disabled = true;
    $("#archive-report-body").className = "panel-empty";
    $("#archive-report-body").innerHTML = "<b>尚未选择研究报告</b><span>报告原文、证据与运行记录将在此显示。</span>";
    $("#chat-context").textContent = "基于当前监控组的已归档研究资料回答；缺失信息会明确说明。";
  }

  async function loadProfileContext() {
    await Promise.allSettled([
      loadMarket(),
      loadQuoteStrip(),
      loadFeeds(),
      loadMonitor(),
      loadLatest(),
      loadResearchWorkspace(),
      loadPendingResearchWorkspace(),
    ]);
  }

  async function selectProfile(profileId, {
    forceReset = false,
    reload = true,
    newThread = true,
  } = {}) {
    const nextId = resolveSelectedProfileId(state.settings?.profiles, profileId);
    if (!nextId) return;
    const changed = nextId !== state.selectedProfileId;
    state.selectedProfileId = nextId;
    persistSelectedProfileId();
    if (!changed && !forceReset) {
      renderSettingsSummary();
      return;
    }

    profileRequests.activate(state.selectedProfileId);
    Object.assign(state, resetProfileContext(state, currentProfile()));
    state.selectedReportEntry = null;
    state.latestReportIdentity = null;
    const selectedTarget = targets().find(({ symbol }) => symbol === state.selectedSymbol);
    if (selectedTarget?.market !== "CN") state.timeframe = "1d";
    renderClearedProfileContext();
    if (newThread && state.threads.length) {
      createThread(`${currentProfile()?.name || "监控组"}问答`, currentProfile()?.id);
    }
    if (reload) await loadProfileContext();
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
    const previousRoute = document.body.dataset.route;
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
    if (previousRoute && previousRoute !== route) window.scrollTo(0, 0);
    window.dispatchEvent(new CustomEvent("workbench:routechange", { detail: { route } }));
  }

  const drawerFocusReturn = new WeakMap();
  const modalBackgroundSelectors = [
    ".product-sidebar",
    ".terminal-header",
    ".freshness-bar",
    ".workspace-stack",
    ".mobile-nav",
  ];

  function setBackgroundInert(inert) {
    for (const selector of modalBackgroundSelectors) {
      $$(selector).forEach((element) => { element.inert = inert; });
    }
  }

  function focusableDrawerElements(drawerElement) {
    return $$(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      drawerElement,
    ).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  }

  function trapDrawerFocus(event, drawerElement) {
    if (event.key !== "Tab") return;
    const focusable = focusableDrawerElements(drawerElement);
    if (!focusable.length) {
      event.preventDefault();
      drawerElement.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openDrawer(drawer, overlay) {
    const drawerElement = $(drawer);
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && !drawerElement.contains(activeElement)) {
      drawerFocusReturn.set(drawerElement, activeElement);
    }
    $(overlay).hidden = false;
    drawerElement.inert = false;
    drawerElement.classList.add("is-open");
    drawerElement.setAttribute("aria-hidden", "false");
    setBackgroundInert(true);
    requestAnimationFrame(() => {
      drawerElement.querySelector(
        "[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
      )?.focus();
    });
  }

  function closeDrawer(drawer, overlay) {
    const drawerElement = $(drawer);
    drawerElement.classList.remove("is-open");
    const anotherModalOpen = $(".settings-drawer.is-open, .assistant-drawer.is-open");
    if (!anotherModalOpen) setBackgroundInert(false);
    if (drawerElement.contains(document.activeElement)) {
      const returnTarget = drawerFocusReturn.get(drawerElement);
      if (returnTarget?.isConnected) returnTarget.focus();
      else document.activeElement?.blur();
    }
    drawerElement.setAttribute("aria-hidden", "true");
    drawerElement.inert = true;
    $(overlay).hidden = true;
  }

  function renderTargetEditor() {
    const profile = currentProfile();
    if (!profile) {
      $("#target-editor").innerHTML = '<div class="panel-empty"><b>配置不可用</b><span>重新载入远端配置后才能编辑标的。</span></div>';
      updateSettingsControlAvailability();
      return;
    }
    $("#target-editor").innerHTML = (profile.targets || []).map((target, index) => `<div class="target-row" data-target-index="${index}">
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
      profile.targets.splice(Number(button.closest("[data-target-index]").dataset.targetIndex), 1);
      if (!profile.targets.some((target) => target.symbol === state.selectedSymbol)) {
        state.selectedSymbol = profile.targets[0]?.symbol || null;
      }
      renderTargetEditor(); renderWatchlist(); renderInstrument();
    }));
    updateSettingsControlAvailability();
  }

  function addTarget() {
    const profile = currentProfile();
    if (!profile) return;
    const symbol = normalizeProfileTargetSymbol($("#target-search").value);
    if (!symbol) { toast("请输入支持的 A 股、港股或美股代码", true); return; }
    if (profile.targets.some((target) => target.symbol === symbol)) { toast("该标的已在研究目标中", true); return; }
    if (profile.targets.length >= TARGET_LIMIT) { toast(`每个监控组最多 ${TARGET_LIMIT} 个标的`, true); return; }
    profile.targets.push({ symbol, name: symbol, market: marketForProfileTarget(symbol), role: "comparison", analysis: "signal" });
    if (!state.selectedSymbol) state.selectedSymbol = symbol;
    $("#target-search").value = "";
    renderTargetEditor(); renderWatchlist();
  }

  function collectSettingsForm() {
    const profile = currentProfile();
    if (!profile) return null;
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
    const { id: _immutableId, ...patch } = structuredClone(profile);
    return patch;
  }

  async function submitAction(path, body, method = "POST") {
    if (!state.settingsWritable || !state.settingsUpdatedAt) {
      throw Object.assign(
        new Error("远端监控配置不可写，请重新载入后重试"),
        { status: 503, payload: { error_code: "SETTINGS_READ_ONLY" } },
      );
    }
    if (!state.accessCode) throw Object.assign(new Error("请先输入写操作访问码"), { status: 401 });
    return requestJson(path, {
      method,
      headers: { "content-type": "application/json", "x-access-code": state.accessCode },
      body: JSON.stringify(body),
    });
  }

  function updateAccessCodeFromSettings() {
    state.accessCode = $("#settings-code").value.trim() || state.accessCode;
    if (state.accessCode) sessionStorage.setItem(STORAGE.sessionCode, state.accessCode);
  }

  function acceptSettingsPayload(payload) {
    const snapshot = settingsSnapshotFromPayload(payload);
    if (!snapshot.writable) {
      throw new Error("服务端未返回最新监控配置");
    }
    state.settings = snapshot.settings;
    state.settingsUpdatedAt = snapshot.revision;
    state.settingsMode = snapshot.mode;
    state.settingsWritable = snapshot.writable;
    state.settingsError = "";
  }

  async function applyMutationPayload(payload, {
    requestContext,
    preferredProfileId,
  } = {}) {
    const selectedAtResponse = state.selectedProfileId;
    const selectionChanged = !profileRequests.matches(requestContext);
    acceptSettingsPayload(payload);
    const nextId = selectedProfileAfterMutation(state.settings.profiles, {
      selectedAtResponse,
      selectionChanged,
      preferredProfileId,
    });
    await selectProfile(nextId, { forceReset: true });
    return nextId;
  }

  function showSettingsConflict(error) {
    const notice = $("#settings-notice");
    notice.classList.add("is-error");
    if (isSettingsRevisionConflict(error)) {
      notice.textContent = "版本冲突：远端配置已变化。";
      $("#settings-reload-remote").hidden = false;
      return;
    }
    notice.textContent = error.message;
    if (error.status >= 500) $("#settings-reload-remote").hidden = false;
  }

  async function saveSettings(event) {
    event.preventDefault();
    const notice = $("#settings-notice");
    notice.textContent = "正在保存并核验版本…"; notice.className = "settings-notice";
    $("#settings-reload-remote").hidden = true;
    updateAccessCodeFromSettings();
    try {
      const profile = currentProfile();
      const requestContext = profileRequests.snapshot();
      const patch = collectSettingsForm();
      const payload = await submitAction(
        `/api/settings/profiles/${encodeURIComponent(profile.id)}`,
        { patch, expectedUpdatedAt: state.settingsUpdatedAt },
        "PATCH",
      );
      await applyMutationPayload(payload, {
        requestContext,
        preferredProfileId: profile.id,
      });
      notice.textContent = payload.message || "配置已保存";
      await persistCredential();
      toast("监控配置已保存");
    } catch (error) {
      showSettingsConflict(error);
    }
  }

  function nextProfileCopyId(sourceId) {
    const ids = new Set((state.settings?.profiles || []).map(({ id }) => id));
    for (let index = 1; index <= PROFILE_LIMIT; index += 1) {
      const suffix = index === 1 ? "-copy" : `-copy-${index}`;
      const candidate = `${sourceId.slice(0, 64 - suffix.length)}${suffix}`;
      if (!ids.has(candidate)) return candidate;
    }
    return null;
  }

  async function createProfile() {
    const id = $("#new-profile-id").value.trim();
    const name = $("#new-profile-name").value.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      toast("新组 ID 只能包含字母、数字、下划线和连字符", true);
      return;
    }
    if (!name) {
      toast("请输入新监控组名称", true);
      return;
    }
    if ((state.settings?.profiles || []).length >= PROFILE_LIMIT) {
      toast(`最多创建 ${PROFILE_LIMIT} 个监控组`, true);
      return;
    }
    updateAccessCodeFromSettings();
    try {
      const requestContext = profileRequests.snapshot();
      const payload = await submitAction("/api/settings/profiles", {
        profile: {
          id,
          name,
          objective: name,
          enabled: false,
          timezone: currentProfile()?.timezone || "Asia/Shanghai",
          targets: [],
        },
        expectedUpdatedAt: state.settingsUpdatedAt,
      });
      await applyMutationPayload(payload, {
        requestContext,
        preferredProfileId: id,
      });
      $("#new-profile-id").value = "";
      $("#new-profile-name").value = "";
      toast(`已创建监控组：${name}`);
    } catch (error) {
      showSettingsConflict(error);
    }
  }

  async function copyProfile() {
    const profile = currentProfile();
    const newId = nextProfileCopyId(profile?.id || "profile");
    if (!profile || !newId) {
      toast("无法生成唯一的监控组副本 ID", true);
      return;
    }
    updateAccessCodeFromSettings();
    try {
      const requestContext = profileRequests.snapshot();
      const payload = await submitAction(
        `/api/settings/profiles/${encodeURIComponent(profile.id)}/copy`,
        {
          options: {
            id: newId,
            name: `${profile.name} 副本`,
          },
          expectedUpdatedAt: state.settingsUpdatedAt,
        },
      );
      await applyMutationPayload(payload, {
        requestContext,
        preferredProfileId: newId,
      });
      toast(`已复制监控组：${profile.name}`);
    } catch (error) {
      showSettingsConflict(error);
    }
  }

  async function deleteProfile() {
    const profile = currentProfile();
    if (!profile || (state.settings?.profiles || []).length <= 1) {
      toast("至少保留一个监控组", true);
      return;
    }
    if (!window.confirm(`删除监控组“${profile.name}”？历史行情、报告和事件不会被删除。`)) return;
    updateAccessCodeFromSettings();
    try {
      const requestContext = profileRequests.snapshot();
      const payload = await submitAction(
        `/api/settings/profiles/${encodeURIComponent(profile.id)}`,
        { expectedUpdatedAt: state.settingsUpdatedAt },
        "DELETE",
      );
      await applyMutationPayload(payload, {
        requestContext,
        preferredProfileId: null,
      });
      toast(`已删除监控组：${profile.name}`);
    } catch (error) {
      showSettingsConflict(error);
    }
  }

  async function reloadRemoteSettings() {
    const notice = $("#settings-notice");
    notice.className = "settings-notice";
    notice.textContent = "正在重新载入远端配置…";
    try {
      const payload = await requestJson("/api/settings");
      const snapshot = settingsSnapshotFromPayload(payload);
      if (!snapshot.writable) throw new Error(snapshot.error || "远端配置仍不可写");
      state.settings = snapshot.settings;
      state.settingsUpdatedAt = snapshot.revision;
      state.settingsMode = snapshot.mode;
      state.settingsWritable = snapshot.writable;
      state.settingsError = "";
      const nextId = resolveSelectedProfileId(state.settings.profiles, state.selectedProfileId);
      $("#settings-reload-remote").hidden = true;
      await selectProfile(nextId, { forceReset: true });
      notice.textContent = "已重新载入远端配置";
    } catch (error) {
      notice.classList.add("is-error");
      notice.textContent = `重新载入失败：${error.message}`;
      $("#settings-reload-remote").hidden = false;
    }
  }

  async function submitTemporaryResearch(event) {
    event.preventDefault();
    const notice = $("#agent-research-notice");
    const submit = $("#agent-research-submit");
    const requestId = createTemporaryResearchRequestId();
    const analysts = $$('input[name="agent-analyst"]:checked', $("#agent-research-form"))
      .map(({ value }) => value);
    try {
      const body = buildTemporaryResearchRequest({
        requestId,
        tickers: $("#agent-research-tickers").value,
        analysts,
        researchDepth: $("#agent-research-depth").value,
      });
      state.accessCode = $("#agent-research-code").value.trim() || state.accessCode;
      if (!state.accessCode) throw new Error("请输入写操作访问码");
      sessionStorage.setItem(STORAGE.sessionCode, state.accessCode);
      submit.disabled = true;
      notice.className = "";
      notice.textContent = `正在提交 ${body.tickers.length} 个标的 · ${body.researchDepth}…`;
      const payload = await requestJson("/api/analyze", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-access-code": state.accessCode,
          "x-request-id": requestId,
        },
        body: JSON.stringify(body),
      });
      state.pendingResearch = {
        requestId: payload?.requestId || body.requestId,
        tickers: body.tickers,
        submittedAt: new Date().toISOString(),
      };
      state.adhocHistory = [];
      state.adhocRuns = [];
      state.adhocReportAudit = null;
      localStorage.setItem(
        STORAGE.pendingResearch,
        JSON.stringify(state.pendingResearch),
      );
      notice.textContent = payload?.message || "临时研究已受理";
      renderAgentWorkspace();
      toast(`临时研究已受理：${body.tickers.join("、")}`);
      setTimeout(loadPendingResearchWorkspace, 2500);
    } catch (error) {
      const errorCode = error.payload?.error_code || error.payload?.code;
      notice.className = "is-error";
      notice.textContent = errorCode
        ? `提交失败 [${errorCode}]：${error.message}`
        : `提交失败：${error.message}`;
    } finally {
      submit.disabled = false;
    }
  }

  async function runAnalysis() {
    state.accessCode = $("#settings-code").value.trim() || state.accessCode;
    const notice = $("#settings-notice");
    notice.textContent = "正在提交研究任务…"; notice.className = "settings-notice";
    try {
      const profile = currentProfile();
      if (!profile) throw new Error("当前没有可运行的监控组");
      const fullAnalysisTargets = targets().filter(({ analysis }) => analysis === "full");
      if (!fullAnalysisTargets.length) throw new Error("请先把至少一个标的的分析方式设为“深度”");
      const payload = await submitAction("/api/analyze", {
        profileId: profile.id,
        tickers: fullAnalysisTargets.map(({ symbol }) => symbol),
      });
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
    $("#agent-research-code").value = state.accessCode;
    $("#settings-remember").checked = state.rememberCode;
  }

  function clearCredential() {
    state.accessCode = "";
    state.rememberCode = false;
    sessionStorage.removeItem(STORAGE.sessionCode);
    localStorage.removeItem(STORAGE.encryptedCode);
    localStorage.removeItem(STORAGE.deviceKey);
    $("#settings-code").value = "";
    $("#agent-research-code").value = "";
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
    const profileId = currentProfile()?.id;
    return state.threads.find((thread) =>
      thread.id === state.threadId && thread.profileId === profileId
    ) || null;
  }

  function profileThreads() {
    const profileId = currentProfile()?.id;
    return state.threads.filter((thread) => thread.profileId === profileId);
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
    const visibleThreads = profileThreads();
    select.innerHTML = visibleThreads.map((thread) => `<option value="${escapeHtml(thread.id)}">${escapeHtml(thread.title || "新研究会话")}</option>`).join("");
    select.value = state.threadId || "";
    $("#delete-thread").disabled = visibleThreads.length <= 1;
    renderThread();
  }

  function createThread(title = "新研究会话", profileId = currentProfile()?.id) {
    const now = new Date().toISOString();
    const thread = {
      id: threadId(),
      profileId,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    state.threads.unshift(thread);
    state.threadId = thread.id;
    saveThreads();
    renderThreads();
    return thread;
  }

  function loadThreads() {
    const profileId = currentProfile()?.id;
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE.threads) || "[]");
      state.threads = compactThreads(Array.isArray(stored)
        ? stored.filter((thread) => thread && typeof thread.id === "string" && Array.isArray(thread.messages))
          .map((thread) => ({ ...thread, profileId: thread.profileId || profileId }))
        : []);
    } catch {
      state.threads = [];
    }
    const visibleThreads = profileThreads();
    if (!visibleThreads.length) {
      createThread("新研究会话", profileId);
      return;
    }
    state.threadId = visibleThreads[0].id;
    renderThreads();
  }

  function deleteCurrentThread() {
    const deletedId = state.threadId;
    if (state.accessCode && deletedId) {
      fetch("/api/chat-sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json", "x-access-code": state.accessCode },
        body: JSON.stringify({ sessionId: deletedId, profileId: currentProfile()?.id }),
      }).catch(() => {});
    }
    const visibleThreads = profileThreads();
    if (visibleThreads.length <= 1) {
      currentThread().messages = [];
      currentThread().updatedAt = new Date().toISOString();
      saveThreads();
      renderThread();
      return;
    }
    state.threads = state.threads.filter((thread) => thread.id !== state.threadId);
    state.threadId = profileThreads()[0]?.id || null;
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
    const thread = state.threads.find(({ id }) => id === targetThreadId);
    if (!thread?.profileId) return false;
    try {
      const payload = await requestJson(
        profileRequestUrl("/api/chat-sessions", thread.profileId, {
          sessionId: targetThreadId,
        }),
        { headers: { "x-access-code": state.accessCode } },
      );
      const remote = payload?.data;
      if (!Array.isArray(remote?.messages) || !remote.messages.length) return false;
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
    const profile = currentProfile();
    const reportEntry = state.selectedReportEntry
      || state.archiveEntries.find((entry) => (
        archiveEntriesMatch(entry, {
          report: state.latestReport,
          identity: state.latestReportIdentity,
        })
      ))
      || null;
    const reportContext = archiveChatContext(reportEntry);
    if (state.selectedReportPath && !reportContext) {
      toast("当前报告未通过身份与证据验证，不能用于问答", true);
      return;
    }
    const chatReportIdentity = reportContext || { profileId: profile?.id };
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
          profileId: chatReportIdentity.profileId,
          reportRequestId: chatReportIdentity.reportRequestId,
          symbol: state.selectedSymbol,
          question,
          history: historyMessages,
          report: reportEntry?.report || state.latestReport,
          reportSection: state.selectedReportSection,
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
    const entry = state.archiveEntries.find((candidate) => archiveEntriesMatch(candidate, {
      report: state.latestReport,
      identity: state.latestReportIdentity,
    }));
    if (!entry) {
      toast("当前最新报告尚未进入对应身份的档案索引", true);
      return;
    }
    navigateRoute("archive");
    await loadArchiveReport(entry);
  }

  function updateClock() {
    const now = new Date();
    $("#terminal-clock").textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);
    const sessions = marketSessionStates(now);
    const cnOpen = sessions.CN.open;
    const usOpen = sessions.US.open;
    $(".market-session:nth-child(1)", $(".session-strip")).classList.toggle("is-open", cnOpen);
    $(".market-session:nth-child(2)", $(".session-strip")).classList.toggle("is-open", usOpen);
    $("#cn-session").textContent = cnOpen ? "交易中" : "休市";
    $("#us-session").textContent = usOpen ? "交易中" : "休市";
  }

  async function refreshAll() {
    $("#refresh-all").disabled = true;
    const refreshes = [
      { label: "行情", load: () => loadMarket(), status: () => state.market.status },
      { label: "报价", load: () => loadQuoteStrip(), status: () => (state.quotes.size ? "ok" : "unavailable") },
      { label: "资讯", load: () => loadFeeds(), status: () => state.feedEnvelope.status },
      { label: "监控", load: () => loadMonitor(), status: () => state.monitor.status },
      {
        label: "研究",
        load: () => loadLatest(),
        status: () => state.latest?.status === "failed"
          ? "failed"
          : state.latest ? "ok" : "empty",
      },
    ];
    try {
      const results = await Promise.allSettled(refreshes.map(({ load }) => load()));
      const summary = results.map((result, index) => ({
        label: refreshes[index].label,
        settled: result.status,
        status: result.status === "fulfilled"
          ? refreshes[index].status()
          : "rejected",
      }));
      const rejected = summary.filter(({ settled }) => settled === "rejected");
      const unavailable = summary.filter(({ status }) => ["unavailable", "failed"].includes(status));
      const degraded = summary.filter(({ status }) => ["degraded", "stale"].includes(status));
      const fulfilled = summary.length - rejected.length;
      const selectedMarket = targets().find(({ symbol }) => symbol === state.selectedSymbol)?.market;
      const marketClosed = selectedMarket && !marketSessionStates()[selectedMarket]?.open;
      const statusLabels = {
        ok: "正常",
        degraded: "部分数据源降级",
        stale: "数据较旧",
        unavailable: "不可用",
        failed: "最近任务失败",
        empty: "当前监控组暂无报告",
        rejected: "请求失败",
      };
      const responseStatuses = summary
        .map(({ label, status }) => {
          if (label === "行情" && status === "stale" && marketClosed) {
            return "行情 休市，沿用最近收盘";
          }
          return `${label} ${statusLabels[status] || status}`;
        })
        .join("、");
      const actionableDegraded = degraded.filter(({ label, status }) => !(
        label === "行情" && status === "stale" && marketClosed
      ));
      toast(
        `数据核验：${fulfilled}/${summary.length} 请求完成；响应 ${responseStatuses}`,
        rejected.length > 0 || unavailable.length > 0 || actionableDegraded.length > 0,
      );
    } finally {
      $("#refresh-all").disabled = false;
    }
  }

  async function pollWorkbenchData() {
    if (document.hidden) return;
    await Promise.allSettled([
      loadMarket({ incremental: true }),
      loadQuoteStrip(),
      loadFeeds(),
      loadMonitor(),
      loadPendingResearchWorkspace(),
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
    $("#profile-selector").addEventListener("change", (event) => selectProfile(event.target.value));
    $("#settings-profile-selector").addEventListener("change", (event) => selectProfile(event.target.value));
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
    const focusTemporaryResearch = () => {
      $("#agent-research-form").scrollIntoView({ behavior: "smooth", block: "center" });
      $("#agent-research-tickers").focus();
    };
    $("#settings-open").addEventListener("click", () => navigateRoute("settings"));
    $("#deep-analysis-open").addEventListener("click", focusTemporaryResearch);
    $("#mobile-settings").addEventListener("click", () => navigateRoute("settings"));
    $("#settings-workspace-open").addEventListener("click", openSettings);
    $("#watchlist-edit").addEventListener("click", openSettings);
    $("#global-status").addEventListener("click", () => navigateRoute("settings"));
    $("#settings-close").addEventListener("click", () => closeDrawer("#settings-drawer", "#settings-overlay"));
    $("#settings-overlay").addEventListener("click", () => closeDrawer("#settings-drawer", "#settings-overlay"));
    $("#profile-create").addEventListener("click", createProfile);
    $("#profile-copy").addEventListener("click", copyProfile);
    $("#profile-delete").addEventListener("click", deleteProfile);
    $("#settings-reload-remote").addEventListener("click", reloadRemoteSettings);
    $("#target-add").addEventListener("click", addTarget);
    $("#target-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addTarget(); } });
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#agent-research-form").addEventListener("submit", submitTemporaryResearch);
    $("#agent-research-depth").addEventListener("change", renderAgentWorkspace);
    $("#run-analysis").addEventListener("click", runAnalysis);
    $("#run-analysis-left").addEventListener("click", runAnalysis);
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
    $("#archive-show-audit").addEventListener("click", () => {
      state.showAuditReports = !state.showAuditReports;
      renderArchiveList();
    });
    $("#archive-ask").addEventListener("click", () => {
      if (!state.selectedReportPath) {
        toast("请先选择一份研究报告", true);
        return;
      }
      if (!archiveChatContext(state.selectedReportEntry)) {
        toast("当前报告未通过身份与证据验证，不能用于问答", true);
        return;
      }
      $("#chat-context").textContent = `${state.selectedReportPath} · ${state.selectedReportSection || "完整报告"}`;
      openAssistant();
    });
    $("#news-workspace-refresh").addEventListener("click", loadFeeds);
    $("#tasks-run-now").addEventListener("click", runAnalysis);
    $("#options-refresh").addEventListener("click", () => loadOptions({ announce: true }));
    window.addEventListener("workbench:routechange", (event) => {
      if (event.detail?.route === "options") loadOptions();
      if (["agents", "tasks", "archive"].includes(event.detail?.route)) {
        renderAgentWorkspace();
        renderTaskBoard();
        renderArchiveList();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollWorkbenchData();
    });
    window.addEventListener("hashchange", applyRoute);
    window.addEventListener("keydown", (event) => {
      const activeDrawer = $(".settings-drawer.is-open, .assistant-drawer.is-open");
      if (activeDrawer && event.key === "Tab") trapDrawerFocus(event, activeDrawer);
      if (event.key === "Escape") {
        closeDrawer("#settings-drawer", "#settings-overlay");
        closeAssistant();
      }
    });
    initializeChart();
  }

  async function init() {
    try {
      const pending = JSON.parse(
        localStorage.getItem(STORAGE.pendingResearch) || "null",
      );
      if (
        pending
        && typeof pending.requestId === "string"
        && Array.isArray(pending.tickers)
      ) state.pendingResearch = pending;
    } catch {
      localStorage.removeItem(STORAGE.pendingResearch);
    }
    bindEvents();
    applyRoute();
    updateClock();
    setInterval(updateClock, 1000);
    await loadCredential();
    await loadSettings();
    loadThreads();
    await recoverThread(state.threadId);
    await loadProfileContext();
    setInterval(pollWorkbenchData, 60000);
    setInterval(refreshOptionsIfVisible, OPTIONS_FAST_REFRESH_MS);
    setInterval(renderOptionsCountdown, 1000);
  }

  init().catch((error) => {
    console.error(error);
    toast("研究终端初始化失败，请刷新重试", true);
  });
})();
