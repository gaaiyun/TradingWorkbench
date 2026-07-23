import {
  DEFAULT_TARGETS,
  computeIndicators,
  computeNextRun,
  filterFeedItems,
  mergeIncrementalBars,
  normalizeEnvelope,
} from "./workbench-data.mjs";

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
  };
  const state = {
    settings: null,
    settingsUpdatedAt: null,
    selectedSymbol: "515880.SS",
    timeframe: "15m",
    market: normalizeEnvelope(null),
    quotes: new Map(),
    feeds: [],
    feedEnvelope: normalizeEnvelope(null),
    monitor: normalizeEnvelope(null),
    latest: null,
    accessCode: "",
    rememberCode: false,
    chart: { bars: [], visibleCount: 80, offset: 0, hoverIndex: null, dragging: false, dragX: 0, dragOffset: 0 },
    indicators: { volume: true, ma20: true, ma60: true },
    chatBusy: false,
    latestReport: null,
  };

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
    $("#schedule-us-close").value = profile.schedules?.usCloseSnapshot?.time || "05:35";
    $("#schedule-premarket").value = profile.schedules?.preMarketBrief?.time || "08:25";
    $("#schedule-close").value = profile.schedules?.closeDeepAnalysis?.time || "15:20";
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
    renderTargetEditor();
    renderWatchlist();
    renderNextRun();
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
      const tone = change == null ? "neutral" : change >= 0 ? "positive" : "negative";
      return `<button class="watch-row ${target.symbol === state.selectedSymbol ? "is-active" : ""}" type="button" role="option" aria-selected="${target.symbol === state.selectedSymbol}" data-symbol="${escapeHtml(target.symbol)}">
        <span class="watch-main"><span class="role-mark">${escapeHtml(roleLabels[target.role] || target.role)}</span><span><strong>${escapeHtml(target.symbol)}</strong><small>${escapeHtml(target.name || target.market)}</small></span></span>
        <span class="watch-quote"><b>${formatNumber(quote?.close)}</b><small class="${tone}">${change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</small></span>
      </button>`;
    }).join("");
    $$("[data-symbol]", $("#watchlist")).forEach((button) => button.addEventListener("click", () => selectSymbol(button.dataset.symbol)));
  }

  function renderInstrument() {
    const target = targets().find((item) => item.symbol === state.selectedSymbol) || DEFAULT_TARGETS[0];
    const bars = state.chart.bars;
    const bar = bars.at(-1);
    const previous = bars.at(-2);
    const change = bar && previous && Number(previous.close) !== 0 ? (Number(bar.close) / Number(previous.close) - 1) * 100 : null;
    $("#instrument-symbol").textContent = target.symbol;
    $("#instrument-name").textContent = `${target.name} · ${target.market === "CN" ? "A 股" : "US"}`;
    $("#instrument-role").textContent = roleLabels[target.role] || target.role;
    $("#instrument-price").textContent = formatNumber(bar?.close);
    $("#instrument-change").textContent = change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    $("#instrument-change").className = change == null ? "neutral" : change >= 0 ? "positive" : "negative";
    $("#quote-open").textContent = formatNumber(bar?.open);
    $("#quote-high").textContent = formatNumber(bar?.high);
    $("#quote-low").textContent = formatNumber(bar?.low);
    $("#quote-volume").textContent = formatVolume(bar?.volume);
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
    try {
      const envelope = normalizeEnvelope(await requestJson(marketUrl(state.selectedSymbol, state.timeframe, incremental ? 2 : 240)));
      state.market = envelope;
      const incoming = sortBars(envelope.data);
      state.chart.bars = incremental ? mergeIncrementalBars(state.chart.bars, incoming) : incoming;
      if (!incremental) { state.chart.visibleCount = Math.min(80, Math.max(20, incoming.length)); state.chart.offset = 0; }
      const last = state.chart.bars.at(-1);
      const prior = state.chart.bars.at(-2);
      if (last) state.quotes.set(state.selectedSymbol, { close: Number(last.close), change: prior ? (Number(last.close) / Number(prior.close) - 1) * 100 : null });
      updateFreshness(envelope);
    } catch {
      state.market = normalizeEnvelope(null);
      if (!incremental) state.chart.bars = [];
      updateFreshness(state.market);
    }
    $("#chart-empty").hidden = state.chart.bars.length > 0;
    renderInstrument();
    renderWatchlist();
    drawCharts();
  }

  async function loadQuoteStrip() {
    const otherTargets = targets().filter(({ symbol }) => symbol !== state.selectedSymbol);
    await Promise.allSettled(otherTargets.map(async ({ symbol }) => {
      const envelope = normalizeEnvelope(await requestJson(marketUrl(symbol, state.timeframe, 2)));
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
    const rows = state.monitor.data;
    const schedules = [
      [profile?.schedules?.usCloseSnapshot?.time || "05:35", "美股收盘快照", profile?.schedules?.usCloseSnapshot?.enabled],
      [profile?.schedules?.preMarketBrief?.time || "08:25", "盘前传导简报", profile?.schedules?.preMarketBrief?.enabled],
      [profile?.schedules?.cnIntraday?.windows?.[0]?.start || "09:30", "A 股盘中采集", profile?.schedules?.cnIntraday?.enabled],
      [profile?.schedules?.closeDeepAnalysis?.time || "15:20", "收盘深度分析", profile?.schedules?.closeDeepAnalysis?.enabled],
    ].filter((item) => item[2]);
    $("#task-timeline").innerHTML = schedules.map(([time, label], index) => {
      const row = rows[index];
      const status = row?.status || "pending";
      const detail = row?.detail || (state.monitor.status === "unavailable" ? "状态接口不可用" : "等待计划时间");
      return `<li class="is-${escapeHtml(status)}"><time>${time}</time><span><b>${escapeHtml(label)}</b><small>${escapeHtml(detail)}</small></span></li>`;
    }).join("") || '<li class="is-pending"><time>—</time><span><b>未启用计划</b><small>在设置中启用监控</small></span></li>';
  }

  function renderMonitorStatus() {
    const latest = state.monitor.data[0];
    $("#monitor-run-status").innerHTML = `<b>最近结果</b><span>${latest ? `${escapeHtml(latest.source || "monitor")} · ${escapeHtml(latest.status || "unknown")} · ${formatTime(latest.as_of, true)}${latest.detail ? ` · ${escapeHtml(latest.detail)}` : ""}` : "尚未从 /api/monitor-status 取得结果或失败原因"}</span>`;
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
  }

  function renderConclusion() {
    const results = state.latest?.results || [];
    const result = results.find((item) => item.ticker === state.selectedSymbol) || results[0];
    if (!result) {
      $("#conclusion-asof").textContent = "尚无可验证研究结果";
      $("#conclusion-body").innerHTML = '<div class="conclusion-rating neutral">待研究</div><p>最新研究接口与静态归档均未返回可用结论。</p>';
      state.latestReport = null;
      return;
    }
    state.latestReport = result.report;
    const rating = String(result.rating || "neutral").toLowerCase();
    const tone = ["buy", "overweight"].includes(rating) ? "positive" : ["sell", "underweight"].includes(rating) ? "negative" : "neutral";
    $("#conclusion-asof").textContent = `${result.ticker} · ${state.latest.trade_date || formatTime(state.latest.generated_at, true)}`;
    $("#conclusion-body").innerHTML = `<div class="conclusion-rating ${tone}">${escapeHtml(ratingLabels[rating] || result.rating || "待研究")}</div><p>${escapeHtml(plainText(result.decision_excerpt) || "研究档案已生成，打开完整报告查看。")}</p>`;
  }

  function renderDrivers() {
    const drivers = targets().filter((target) => ["driver", "benchmark"].includes(target.role)).slice(0, 4);
    const cells = drivers.filter((target) => state.quotes.has(target.symbol)).map((target) => {
      const quote = state.quotes.get(target.symbol);
      const tone = quote.change >= 0 ? "positive" : "negative";
      return `<div class="driver-cell"><span>${escapeHtml(target.symbol)} / ${escapeHtml(roleLabels[target.role])}</span><strong class="${tone}">${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%</strong><small>${escapeHtml(target.name)} · 相关性 — · 最新 ${formatNumber(quote.close)}</small></div>`;
    });
    $("#driver-grid").innerHTML = cells.length ? cells.join("") : '<div class="driver-empty">没有足够真实数据计算跨市场驱动</div>';
    $("#correlation-asof").textContent = state.market.asOf ? `数据 ${formatTime(state.market.asOf, true)}` : "等待市场数据";
  }

  function chartRange() {
    const length = state.chart.bars.length;
    const count = Math.min(state.chart.visibleCount, length);
    const end = Math.max(count, length - state.chart.offset);
    return { start: Math.max(0, end - count), end };
  }

  function setupCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width: rect.width, height: rect.height };
  }

  function drawGrid(context, width, height, rows = 4) {
    context.strokeStyle = "#242a2e";
    context.lineWidth = 1;
    context.beginPath();
    for (let index = 1; index < rows; index += 1) {
      const y = Math.round(height * index / rows) + .5;
      context.moveTo(0, y); context.lineTo(width, y);
    }
    context.stroke();
  }

  function drawPriceCanvas(bars, indicators, range) {
    const { context, width, height } = setupCanvas($("#market-chart"));
    context.clearRect(0, 0, width, height);
    drawGrid(context, width, height, 5);
    if (!bars.length) return;
    const plotHeight = state.indicators.volume ? height * .76 : height - 15;
    const prices = bars.flatMap((bar) => [Number(bar.high), Number(bar.low)]);
    const maValues = [...indicators.ma20, ...indicators.ma60].filter(Number.isFinite);
    const min = Math.min(...prices, ...maValues);
    const max = Math.max(...prices, ...maValues);
    const spread = max - min || 1;
    const xStep = width / bars.length;
    const x = (index) => (index + .5) * xStep;
    const y = (value) => 7 + (max - value) / spread * (plotHeight - 14);
    const maxVolume = Math.max(...bars.map((bar) => Number(bar.volume) || 0), 1);
    bars.forEach((bar, index) => {
      const rising = Number(bar.close) >= Number(bar.open);
      const color = rising ? "#38b788" : "#e05f68";
      const center = x(index);
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 1;
      context.beginPath(); context.moveTo(center, y(Number(bar.high))); context.lineTo(center, y(Number(bar.low))); context.stroke();
      const top = y(Math.max(Number(bar.open), Number(bar.close)));
      const bottom = y(Math.min(Number(bar.open), Number(bar.close)));
      context.fillRect(center - Math.max(1, xStep * .29), top, Math.max(2, xStep * .58), Math.max(1, bottom - top));
      if (state.indicators.volume) {
        const volumeHeight = (Number(bar.volume) || 0) / maxVolume * (height - plotHeight - 8);
        context.globalAlpha = .32;
        context.fillRect(center - Math.max(1, xStep * .3), height - volumeHeight, Math.max(2, xStep * .6), volumeHeight);
        context.globalAlpha = 1;
      }
    });
    const drawLine = (values, color) => {
      context.strokeStyle = color; context.lineWidth = 1.1; context.beginPath();
      let started = false;
      values.forEach((value, index) => {
        if (!Number.isFinite(value)) return;
        if (!started) { context.moveTo(x(index), y(value)); started = true; }
        else context.lineTo(x(index), y(value));
      });
      context.stroke();
    };
    if (state.indicators.ma20) drawLine(indicators.ma20, "#aab2b5");
    if (state.indicators.ma60) drawLine(indicators.ma60, "#707b81");
    drawCrosshair(context, width, height, bars, range);
  }

  function drawIndicatorCanvas(selector, bars, values, options = {}) {
    const { context, width, height } = setupCanvas($(selector));
    context.clearRect(0, 0, width, height);
    drawGrid(context, width, height, options.rows || 3);
    if (!bars.length) return;
    const series = Array.isArray(values[0]) ? values : [values];
    const finite = series.flat().filter(Number.isFinite);
    const min = options.fixedMin ?? Math.min(...finite, 0);
    const max = options.fixedMax ?? Math.max(...finite, 0);
    const spread = max - min || 1;
    const xStep = width / bars.length;
    const y = (value) => 5 + (max - value) / spread * (height - 10);
    if (options.thresholds) {
      context.strokeStyle = "#3a4248"; context.setLineDash([3, 4]);
      for (const threshold of options.thresholds) {
        context.beginPath(); context.moveTo(0, y(threshold)); context.lineTo(width, y(threshold)); context.stroke();
      }
      context.setLineDash([]);
    }
    series.forEach((line, lineIndex) => {
      context.strokeStyle = options.colors?.[lineIndex] || "#aab2b5";
      context.lineWidth = 1; context.beginPath(); let started = false;
      line.forEach((value, index) => {
        if (!Number.isFinite(value)) return;
        const pointX = (index + .5) * xStep;
        if (!started) { context.moveTo(pointX, y(value)); started = true; } else context.lineTo(pointX, y(value));
      });
      context.stroke();
    });
    drawCrosshair(context, width, height, bars, chartRange());
  }

  function drawCrosshair(context, width, height, bars) {
    if (state.chart.hoverIndex == null || !bars.length) return;
    const index = Math.max(0, Math.min(bars.length - 1, state.chart.hoverIndex));
    const x = (index + .5) * width / bars.length;
    context.strokeStyle = "#778086";
    context.setLineDash([3, 3]); context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); context.setLineDash([]);
  }

  function drawCharts() {
    const range = chartRange();
    const bars = state.chart.bars.slice(range.start, range.end);
    const indicators = computeIndicators(bars);
    drawPriceCanvas(bars, indicators, range);
    drawIndicatorCanvas("#macd-chart", bars, [indicators.macd, indicators.signal], { colors: ["#aab2b5", "#6c777d"] });
    drawIndicatorCanvas("#rsi-chart", bars, indicators.rsi, { fixedMin: 0, fixedMax: 100, thresholds: [30, 70], colors: ["#aab2b5"] });
    if (state.chart.hoverIndex != null && bars[state.chart.hoverIndex]) {
      const bar = bars[state.chart.hoverIndex];
      $("#crosshair-readout").hidden = false;
      $("#crosshair-readout").textContent = `${formatTime(bar.ts, true)}  O ${formatNumber(bar.open)}  H ${formatNumber(bar.high)}  L ${formatNumber(bar.low)}  C ${formatNumber(bar.close)}  V ${formatVolume(bar.volume)}`;
    } else {
      $("#crosshair-readout").hidden = true;
    }
  }

  function bindChartInteractions() {
    const canvases = ["#market-chart", "#macd-chart", "#rsi-chart"].map((selector) => $(selector));
    const updateHover = (event) => {
      const canvas = event.currentTarget;
      const range = chartRange();
      const count = range.end - range.start;
      const x = event.clientX - canvas.getBoundingClientRect().left;
      state.chart.hoverIndex = Math.max(0, Math.min(count - 1, Math.floor(x / canvas.clientWidth * count)));
      drawCharts();
    };
    canvases.forEach((canvas) => {
      canvas.addEventListener("pointermove", (event) => {
        if (state.chart.dragging) {
          const delta = Math.round((event.clientX - state.chart.dragX) / Math.max(5, canvas.clientWidth / Math.max(state.chart.visibleCount, 1)));
          state.chart.offset = Math.max(0, Math.min(state.chart.bars.length - state.chart.visibleCount, state.chart.dragOffset - delta));
        }
        updateHover(event);
      });
      canvas.addEventListener("pointerleave", () => { state.chart.hoverIndex = null; state.chart.dragging = false; drawCharts(); });
      canvas.addEventListener("pointerdown", (event) => { state.chart.dragging = true; state.chart.dragX = event.clientX; state.chart.dragOffset = state.chart.offset; canvas.setPointerCapture(event.pointerId); });
      canvas.addEventListener("pointerup", () => { state.chart.dragging = false; });
      canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        state.chart.visibleCount = Math.max(20, Math.min(state.chart.bars.length || 20, state.chart.visibleCount + (event.deltaY > 0 ? 10 : -10)));
        state.chart.offset = Math.min(state.chart.offset, Math.max(0, state.chart.bars.length - state.chart.visibleCount));
        drawCharts();
      }, { passive: false });
      canvas.addEventListener("keydown", (event) => {
        if (event.key === "+" || event.key === "=") state.chart.visibleCount = Math.max(20, state.chart.visibleCount - 10);
        else if (event.key === "-") state.chart.visibleCount = Math.min(state.chart.bars.length, state.chart.visibleCount + 10);
        else if (event.key === "ArrowLeft") state.chart.offset = Math.min(Math.max(0, state.chart.bars.length - state.chart.visibleCount), state.chart.offset + 1);
        else if (event.key === "ArrowRight") state.chart.offset = Math.max(0, state.chart.offset - 1);
        else return;
        event.preventDefault(); drawCharts();
      });
    });
  }

  async function selectSymbol(symbol) {
    state.selectedSymbol = symbol;
    renderWatchlist();
    renderConclusion();
    state.chart.bars = [];
    await loadMarket();
  }

  function setMobileView(view) {
    document.body.dataset.mobileView = view;
    $$("[data-mobile-section]").forEach((button) => button.classList.toggle("is-active", button.dataset.mobileSection === view));
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
    if (profile.targets.length >= 10) { toast("每个研究目标最多 10 个标的", true); return; }
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
    profile.schedules.usCloseSnapshot.time = $("#schedule-us-close").value;
    profile.schedules.preMarketBrief.time = $("#schedule-premarket").value;
    profile.schedules.closeDeepAnalysis.time = $("#schedule-close").value;
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
      const payload = await submitAction("/api/analyze", { tickers: targets().map(({ symbol }) => symbol) });
      notice.textContent = payload.message || "服务端已受理";
      toast("分析任务已受理");
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

  function openAssistant() {
    openDrawer("#assistant", "#assistant-backdrop");
    $("#assistant-open").setAttribute("aria-expanded", "true");
  }

  function closeAssistant() {
    closeDrawer("#assistant", "#assistant-backdrop");
    $("#assistant-open").setAttribute("aria-expanded", "false");
  }

  function appendChat(role, content, error = false) {
    const node = document.createElement("div");
    node.className = `chat-message ${role}${error ? " is-error" : ""}`;
    node.innerHTML = `<div class="chat-message-meta">${role === "user" ? "我" : "研究助理"} · ${formatTime(new Date().toISOString(), true)}</div><div class="chat-message-body">${role === "assistant" ? renderMarkdown(content) : escapeHtml(content)}</div>`;
    $("#chat-log").append(node);
    $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
    return node;
  }

  async function sendChat(event) {
    event.preventDefault();
    if (state.chatBusy) return;
    const question = $("#chat-question").value.trim();
    if (!question) return;
    if (!state.accessCode) { openDrawer("#settings-drawer", "#settings-overlay"); toast("研究问答需要访问码", true); return; }
    state.chatBusy = true; $("#chat-send").disabled = true; $("#chat-question").value = "";
    $(".chat-empty", $("#chat-log"))?.remove();
    appendChat("user", question);
    const answer = appendChat("assistant", "正在连接已归档研究资料…");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-access-code": state.accessCode },
        body: JSON.stringify({ question, report: state.latestReport, stream: false }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      $(".chat-message-body", answer).innerHTML = renderMarkdown(payload.answer || "上游未返回内容");
    } catch (error) {
      answer.classList.add("is-error");
      $(".chat-message-body", answer).textContent = error.message;
    } finally {
      state.chatBusy = false; $("#chat-send").disabled = false;
    }
  }

  async function openLatestReport() {
    if (!state.latestReport) { toast("当前没有可打开的研究档案", true); return; }
    openAssistant();
    $(".chat-empty", $("#chat-log"))?.remove();
    const node = appendChat("assistant", "正在读取完整报告…");
    try {
      const response = await fetch(`/${state.latestReport.replace(/^\/+/, "")}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`报告读取失败 (${response.status})`);
      $(".chat-message-body", node).innerHTML = renderMarkdown(await response.text());
      $("#chat-context").textContent = state.latestReport;
    } catch (error) {
      node.classList.add("is-error"); $(".chat-message-body", node).textContent = error.message;
    }
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

  function bindEvents() {
    $$("[data-timeframe]").forEach((button) => button.addEventListener("click", async () => {
      state.timeframe = button.dataset.timeframe;
      $$("[data-timeframe]").forEach((item) => { item.classList.toggle("is-active", item === button); item.setAttribute("aria-selected", String(item === button)); });
      await loadMarket();
      loadQuoteStrip();
    }));
    $$("[data-indicator]").forEach((input) => input.addEventListener("change", () => { state.indicators[input.dataset.indicator] = input.checked; drawCharts(); }));
    $("#chart-reset").addEventListener("click", () => { state.chart.visibleCount = Math.min(80, state.chart.bars.length); state.chart.offset = 0; drawCharts(); });
    $("#refresh-all").addEventListener("click", refreshAll);
    $("#refresh-feed").addEventListener("click", loadFeeds);
    ["#feed-symbol", "#feed-source", "#feed-importance"].forEach((selector) => $(selector).addEventListener("change", renderFeed));
    $$("[data-mobile-section]").forEach((button) => button.addEventListener("click", () => setMobileView(button.dataset.mobileSection)));
    const openSettings = () => openDrawer("#settings-drawer", "#settings-overlay");
    $("#settings-open").addEventListener("click", openSettings);
    $("#mobile-settings").addEventListener("click", openSettings);
    $("#watchlist-edit").addEventListener("click", openSettings);
    $("#global-status").addEventListener("click", openSettings);
    $("#settings-close").addEventListener("click", () => closeDrawer("#settings-drawer", "#settings-overlay"));
    $("#settings-overlay").addEventListener("click", () => closeDrawer("#settings-drawer", "#settings-overlay"));
    $("#target-add").addEventListener("click", addTarget);
    $("#target-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addTarget(); } });
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#run-analysis").addEventListener("click", runAnalysis);
    $("#run-analysis-left").addEventListener("click", () => { openSettings(); $("#settings-notice").textContent = "确认标的与访问码后，点击“立即运行”。"; });
    $("#toggle-code").addEventListener("click", () => { const input = $("#settings-code"); input.type = input.type === "password" ? "text" : "password"; $("#toggle-code").textContent = input.type === "password" ? "显示" : "隐藏"; });
    $("#assistant-open").addEventListener("click", openAssistant);
    $("#assistant-close").addEventListener("click", closeAssistant);
    $("#assistant-backdrop").addEventListener("click", closeAssistant);
    $("#chat-form").addEventListener("submit", sendChat);
    $("#open-latest-report").addEventListener("click", openLatestReport);
    window.addEventListener("resize", drawCharts);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeDrawer("#settings-drawer", "#settings-overlay");
        closeAssistant();
      }
    });
    bindChartInteractions();
  }

  async function init() {
    bindEvents();
    updateClock();
    setInterval(updateClock, 1000);
    await loadCredential();
    await loadSettings();
    await Promise.allSettled([loadMarket(), loadQuoteStrip(), loadFeeds(), loadMonitor(), loadLatest()]);
    setInterval(() => loadMarket({ incremental: true }), 60000);
    setInterval(loadMonitor, 60000);
  }

  init().catch((error) => {
    console.error(error);
    toast("研究终端初始化失败，请刷新重试", true);
  });
})();
