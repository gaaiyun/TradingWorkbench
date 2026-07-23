(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const PAGES = new Set(["overview", "tasks", "archive", "news", "options", "settings"]);
  const PAGE_META = {
    overview: ["工作台", "总览"],
    tasks: ["任务中心", "研究任务"],
    archive: ["历史研究", "研究档案"],
    news: ["新闻与事件", "新闻资讯"],
    options: ["风险监控", "期权"],
    settings: ["系统管理", "设置"],
  };
  const TAB_LABELS = {
    complete_report: "完整报告",
    fundamentals: "基本面",
    market: "市场",
    news: "新闻",
    bull: "多方",
    bear: "空方",
    manager: "研究经理",
    trader: "交易方案",
    aggressive: "激进风险",
    neutral: "中性风险",
    conservative: "保守风险",
    decision: "组合决策",
  };
  const STORAGE = {
    sessionCode: "ta.workbench.access.session.v1",
    deviceKey: "ta.workbench.device-key.v1",
    encryptedCode: "ta.workbench.access.encrypted.v1",
    threads: "ta.workbench.threads.v1",
  };
  const state = {
    page: "overview",
    latest: null,
    history: [],
    settings: null,
    runs: [],
    health: null,
    news: null,
    newsFilter: "all",
    options: null,
    optionsMode: "unknown",
    optionCountdown: 30,
    selectedArchiveIndex: 0,
    selectedTicker: null,
    selectedReport: null,
    selectedReportTab: null,
    accessCode: "",
    rememberCode: false,
    threads: [],
    threadId: null,
    chatBusy: false,
  };

  const html = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function inlineMarkdown(raw) {
    const tokens = [];
    let value = String(raw || "").replace(/\[([^\]]+)]\(([^)]+)\)/g, (_all, label, href) => {
      const url = safeUrl(href);
      if (!url) return label;
      const token = `\u0000LINK${tokens.length}\u0000`;
      tokens.push(`<a href="${html(url)}" target="_blank" rel="noopener noreferrer">${html(label)}</a>`);
      return token;
    });
    value = html(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
    tokens.forEach((token, index) => {
      value = value.replace(`\u0000LINK${index}\u0000`, token);
    });
    return value;
  }

  function renderMarkdown(markdown) {
    const localized = String(markdown || "")
      .replaceAll("**Rating:**", "**评级：**")
      .replaceAll("**Rating**:", "**评级**：")
      .replaceAll("**Executive Summary:**", "**执行摘要：**")
      .replaceAll("**Executive Summary**:", "**执行摘要**：")
      .replaceAll("**Investment Thesis:**", "**投资逻辑：**")
      .replaceAll("**Investment Thesis**:", "**投资逻辑**：")
      .replace(/(^|\n)Rating:\s*/g, "$1评级：")
      .replace(/(^|\n)Executive Summary:\s*/g, "$1执行摘要：")
      .replace(/(^|\n)Investment Thesis:\s*/g, "$1投资逻辑：");
    const lines = localized.replaceAll("\r\n", "\n").split("\n");
    const out = [];
    let list = null;
    let paragraph = [];
    let code = false;
    let codeLines = [];
    const flushParagraph = () => {
      if (paragraph.length) out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        flushParagraph();
        closeList();
        if (code) {
          out.push(`<pre><code>${html(codeLines.join("\n"))}</code></pre>`);
          codeLines = [];
        }
        code = !code;
        continue;
      }
      if (code) {
        codeLines.push(line);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        flushParagraph();
        closeList();
        out.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
        flushParagraph(); closeList(); out.push("<hr>"); continue;
      }
      if (line.startsWith(">")) {
        flushParagraph(); closeList(); out.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`); continue;
      }
      const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
      if (unordered || ordered) {
        flushParagraph();
        const type = ordered ? "ol" : "ul";
        if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
        out.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
        continue;
      }
      paragraph.push(line.trim());
    }
    if (codeLines.length) out.push(`<pre><code>${html(codeLines.join("\n"))}</code></pre>`);
    flushParagraph(); closeList();
    return out.join("");
  }

  function stripMarkdown(value, limit = 190) {
    const text = String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/[#*_`>~-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
  }

  function formatTime(value, withTime = true) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
    }).format(date);
  }

  function formatFullTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(date);
  }

  function formatNumber(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(number);
  }

  function ratingClass(rating) {
    const value = String(rating || "").toLowerCase();
    if (value.includes("buy") || value.includes("overweight")) return "positive";
    if (value.includes("sell") || value.includes("underweight")) return "negative";
    return "hold";
  }

  function ratingLabel(rating) {
    const labels = {
      buy: "买入",
      overweight: "增持",
      hold: "持有",
      neutral: "中性",
      underweight: "减持",
      sell: "卖出",
    };
    const value = String(rating || "").trim();
    return labels[value.toLowerCase()] || value || "—";
  }

  function decisionExcerpt(value) {
    return stripMarkdown(value, 260)
      .replace(/^Rating\s*:\s*[A-Za-z ]+?\s+Executive Summary\s*:\s*/i, "")
      .replace(/^Executive Summary\s*:\s*/i, "")
      .trim();
  }

  function sourceStatusLabel(value) {
    const labels = {
      ok: "正常",
      live: "实时",
      market_closed: "市场已收盘",
      closed: "已收盘",
      partial: "部分可用",
      snapshot: "历史快照",
      static_only: "仅静态数据",
      unavailable: "不可用",
    };
    return labels[String(value || "").toLowerCase()] || String(value || "未知");
  }

  function statusClass(run) {
    if (run.status === "queued") return "queued";
    if (run.status === "in_progress") return "running";
    if (run.conclusion === "success") return "success";
    return run.status === "completed" ? "failed" : "queued";
  }

  function statusLabel(run) {
    if (run.status === "queued") return "排队";
    if (run.status === "in_progress") return "运行中";
    if (run.conclusion === "success") return "完成";
    if (run.conclusion === "cancelled") return "已取消";
    return run.status === "completed" ? "失败" : "未知";
  }

  function toast(message, bad = false) {
    const node = document.createElement("div");
    node.className = `toast${bad ? " is-bad" : ""}`;
    node.textContent = message;
    $("#toast-region").append(node);
    window.setTimeout(() => node.remove(), 4200);
  }

  async function fetchJson(candidates, init = {}) {
    let lastError;
    for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
      try {
        const response = await fetch(candidate, { cache: "no-store", ...init });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.status = response.status;
          try { error.payload = await response.clone().json(); } catch { /* empty */ }
          throw error;
        }
        return { data: await response.json(), response, url: candidate };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("request failed");
  }

  function setPage(page, updateHash = true) {
    page = PAGES.has(page) ? page : "overview";
    state.page = page;
    $$(".page").forEach((node) => {
      const active = node.dataset.page === page;
      node.hidden = !active;
      node.classList.toggle("is-active", active);
    });
    $$('[data-view-target]').forEach((node) => node.classList.toggle("is-active", node.dataset.viewTarget === page));
    const [eyebrow, title] = PAGE_META[page];
    $("#page-eyebrow").textContent = eyebrow;
    $("#page-title-compact").textContent = title;
    closeNav();
    if (updateHash && location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
    if (page === "options" && !state.options) loadOptions();
    if (page === "news" && !state.news) loadNews();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function openNav() {
    $("#sidebar").classList.add("is-open");
    $("#nav-backdrop").classList.add("is-open");
    $("#nav-open").setAttribute("aria-expanded", "true");
  }
  function closeNav() {
    $("#sidebar").classList.remove("is-open");
    $("#nav-backdrop").classList.remove("is-open");
    $("#nav-open").setAttribute("aria-expanded", "false");
  }
  function openAssistant() {
    $("#assistant").classList.add("is-open");
    $("#assistant-backdrop").classList.add("is-open");
    $("#assistant-open").setAttribute("aria-expanded", "true");
  }
  function closeAssistant() {
    $("#assistant").classList.remove("is-open");
    $("#assistant-backdrop").classList.remove("is-open");
    $("#assistant-open").setAttribute("aria-expanded", "false");
  }

  function renderLatest() {
    const latest = state.latest;
    const grid = $("#latest-decisions");
    if (!latest || !Array.isArray(latest.results) || !latest.results.length) {
      grid.innerHTML = '<div class="empty-state"><b>暂无可用决策</b><span>定时分析完成后会在此显示。</span></div>';
      return;
    }
    $("#latest-asof").textContent = `研究日 ${latest.trade_date || "—"} · 生成 ${formatTime(latest.generated_at)}`;
    $("#global-freshness").textContent = `报告 ${formatTime(latest.generated_at)}`;
    $("#side-latest-asof").textContent = latest.trade_date || "—";
    grid.innerHTML = latest.results.map((result) => {
      const cls = ratingClass(result.rating);
      const market = result.ticker?.endsWith(".SS") || result.ticker?.endsWith(".SZ") ? "A 股" : "美股";
      return `<button class="decision-card ${cls}" type="button" data-decision-ticker="${html(result.ticker)}">
        <span class="decision-card-head"><span><strong class="decision-symbol">${html(result.ticker)}</strong><small class="decision-market">${market}</small></span><span class="rating-chip ${cls}">${html(ratingLabel(result.rating))}</span></span>
        <span class="decision-excerpt">${html(decisionExcerpt(result.decision_excerpt) || "已归档完整研究报告。")}</span>
        <span class="decision-card-foot"><span>${html(latest.trade_date || "")}</span><span>打开研究 →</span></span>
      </button>`;
    }).join("");
    $$('[data-decision-ticker]', grid).forEach((button) => button.addEventListener("click", () => {
      state.selectedArchiveIndex = 0;
      selectArchiveTicker(button.dataset.decisionTicker);
      setPage("archive");
    }));
    renderCoverage();
  }

  function settingsTickers(settings) {
    if (Array.isArray(settings?.tickers)) return settings.tickers;
    const seen = new Set();
    return (settings?.profiles || [])
      .filter((profile) => profile.enabled)
      .flatMap((profile) => profile.targets || [])
      .filter((target) => target.analysis === "full")
      .map((target) => target.symbol)
      .filter((symbol) => {
        if (seen.has(symbol)) return false;
        seen.add(symbol);
        return true;
      });
  }

  function renderSettingsSummary() {
    const tickers = settingsTickers(state.settings);
    const checklist = $("#daily-checklist");
    if (!tickers.length) {
      checklist.innerHTML = '<div class="empty-line">远端清单为空或暂时不可用</div>';
      return;
    }
    checklist.innerHTML = tickers.map((ticker, index) => `<div class="checklist-row"><span class="checklist-index">${String(index + 1).padStart(2, "0")}</span><b class="checklist-ticker">${html(ticker)}</b><small>每日</small></div>`).join("");
    $("#settings-tickers").value = tickers.join("\n");
    $("#settings-sync-label").textContent = `已同步 ${tickers.length} 个`;
    $("#daily-checklist-note").textContent = `自动任务将顺序分析 ${tickers.length} 个标的；网页保存后通常一分钟内生效。`;
  }

  function renderRuns() {
    const runs = state.runs || [];
    const active = runs.filter((run) => run.status === "queued" || run.status === "in_progress").length;
    $("#active-run-count").hidden = active === 0;
    $("#active-run-count").textContent = String(active);
    $("#side-run-status").textContent = active ? `${active} 个执行中` : (runs[0] ? statusLabel(runs[0]) : "未读取");
    const compact = $("#overview-runs");
    const full = $("#run-list");
    if (!runs.length) {
      compact.innerHTML = '<div class="empty-line">暂无运行记录或接口不可用</div>';
      full.innerHTML = '<div class="empty-state compact"><b>暂无运行记录</b><span>提交任务后可在此跟踪。</span></div>';
      return;
    }
    compact.innerHTML = runs.slice(0, 3).map((run) => `<a class="compact-run" href="${html(safeUrl(run.url))}" target="_blank" rel="noopener noreferrer"><span class="run-state ${statusClass(run)}">${statusLabel(run)}</span><span>${html(run.title || run.workflow)}</span><small>${formatTime(run.created_at)}</small></a>`).join("");
    full.innerHTML = runs.map((run) => `<a class="run-row" href="${html(safeUrl(run.url))}" target="_blank" rel="noopener noreferrer">
      <span class="run-time">${formatTime(run.created_at)}</span><span class="run-title">${html(run.title || "分析任务")}</span><span class="run-flow">${html(run.workflow || "")}</span>
      <span class="run-phase"><b class="run-state ${statusClass(run)}">${statusLabel(run)}</b><small>${run.conclusion ? `conclusion: ${html(run.conclusion)}` : "等待工作流更新"}</small></span><svg><use href="#i-chevron"></use></svg>
    </a>`).join("");
    const checked = `核验于 ${formatTime(new Date().toISOString())}`;
    $("#runs-checked-at").textContent = checked;
    $("#runs-asof").textContent = checked;
  }

  function renderCoverage() {
    const results = state.latest?.results || [];
    const keys = ["market", "news", "fundamentals", "manager", "decision"];
    $("#coverage-table").innerHTML = `<thead><tr><th>标的</th>${keys.map((key) => `<th>${TAB_LABELS[key]}</th>`).join("")}<th>评级</th></tr></thead><tbody>${results.map((result) => `<tr><td><b>${html(result.ticker)}</b></td>${keys.map((key) => `<td><span class="coverage-mark ${result.files?.[key] ? "yes" : ""}"></span>${result.files?.[key] ? "已归档" : "缺失"}</td>`).join("")}<td>${html(ratingLabel(result.rating))}</td></tr>`).join("")}</tbody>`;
  }

  function archiveEntries() {
    if (state.history.length) return state.history;
    if (!state.latest) return [];
    return [{ trade_date: state.latest.trade_date, generated_at: state.latest.generated_at, provider: state.latest.provider, results: state.latest.results }];
  }

  function renderArchiveList() {
    const query = $("#archive-query").value.trim().toLowerCase();
    const entries = archiveEntries();
    const filtered = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => {
      const haystack = `${entry.trade_date} ${(entry.results || []).map((r) => r.ticker).join(" ")}`.toLowerCase();
      return !query || haystack.includes(query);
    });
    $("#archive-count").textContent = String(entries.length || 0);
    $("#archive-summary").textContent = `${filtered.length} 次运行 · ${entries.reduce((sum, entry) => sum + (entry.results?.length || 0), 0)} 份决策`;
    $("#archive-list").innerHTML = filtered.map(({ entry, index }) => `<button class="archive-entry ${index === state.selectedArchiveIndex ? "is-active" : ""}" type="button" data-archive-index="${index}"><span class="archive-entry-head"><b class="archive-entry-date">${html(entry.trade_date || "—")}</b><small>${formatTime(entry.generated_at)}</small></span><span class="archive-entry-tickers">${(entry.results || []).map((result) => `<span>${html(result.ticker)}</span>`).join("")}</span></button>`).join("") || '<div class="empty-line">没有匹配的研究档案</div>';
    $$('[data-archive-index]').forEach((button) => button.addEventListener("click", () => {
      state.selectedArchiveIndex = Number(button.dataset.archiveIndex);
      const entry = entries[state.selectedArchiveIndex];
      selectArchiveTicker(entry?.results?.[0]?.ticker || null);
      renderArchiveList();
    }));
    if (!state.selectedTicker && entries[0]?.results?.[0]) selectArchiveTicker(entries[0].results[0].ticker);
  }

  function resultForEntry(entry, ticker) {
    let result = (entry?.results || []).find((item) => item.ticker === ticker);
    if (entry?.trade_date === state.latest?.trade_date) {
      result = state.latest.results?.find((item) => item.ticker === ticker) || result;
    }
    return result;
  }

  function selectArchiveTicker(ticker) {
    const entry = archiveEntries()[state.selectedArchiveIndex] || archiveEntries()[0];
    if (!entry) return;
    const result = resultForEntry(entry, ticker) || entry.results?.[0];
    if (!result) return;
    state.selectedTicker = result.ticker;
    $("#report-kicker").textContent = `${entry.trade_date || "—"} / ${entry.provider || "provider unknown"}`;
    $("#report-title").textContent = `${result.ticker} 研究报告`;
    const badge = $("#report-rating");
    badge.textContent = ratingLabel(result.rating);
    badge.className = `rating-badge ${ratingClass(result.rating)}`;
    $("#report-tickers").innerHTML = (entry.results || []).map((item) => `<button class="ticker-tab ${item.ticker === result.ticker ? "is-active" : ""}" type="button" data-report-ticker="${html(item.ticker)}">${html(item.ticker)}</button>`).join("");
    $$('[data-report-ticker]').forEach((button) => button.addEventListener("click", () => selectArchiveTicker(button.dataset.reportTicker)));

    const files = result.files && Object.keys(result.files).length
      ? result.files
      : { complete_report: result.report || `reports/${result.ticker}/${entry.trade_date}/complete_report.md` };
    const ordered = Object.entries(files).sort(([a], [b]) => {
      const order = Object.keys(TAB_LABELS);
      return order.indexOf(a) - order.indexOf(b);
    });
    $("#report-tabs").innerHTML = ordered.map(([key]) => `<button class="report-tab" type="button" data-report-tab="${html(key)}">${html(TAB_LABELS[key] || key)}</button>`).join("");
    $$('[data-report-tab]').forEach((button) => button.addEventListener("click", () => loadReportTab(button.dataset.reportTab, files)));
    const defaultTab = files.decision ? "decision" : (files.complete_report ? "complete_report" : ordered[0]?.[0]);
    if (defaultTab) loadReportTab(defaultTab, files);
    renderArchiveList();
  }

  async function loadReportTab(key, files) {
    const path = files[key];
    if (!path) return;
    state.selectedReportTab = key;
    state.selectedReport = { key, path, ticker: state.selectedTicker };
    $("#chat-context").textContent = `${state.selectedTicker} · ${TAB_LABELS[key] || key}`;
    $$('[data-report-tab]').forEach((button) => button.classList.toggle("is-active", button.dataset.reportTab === key));
    const article = $("#report-article");
    article.innerHTML = '<div class="empty-state"><b>读取研究分卷</b><span>正在从归档加载 Markdown。</span></div>';
    try {
      let response = await fetch(`/api/report?path=${encodeURIComponent(path)}`, { cache: "no-store" });
      if (!response.ok) response = await fetch(`/${path}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      article.innerHTML = renderMarkdown(await response.text());
    } catch {
      article.innerHTML = '<div class="empty-state"><b>报告读取失败</b><span>该归档路径暂时不可用，请稍后刷新。</span></div>';
    }
  }

  function renderNews() {
    const bundle = state.news;
    const items = Array.isArray(bundle?.items) ? bundle.items : [];
    const tickers = [...new Set(items.map((item) => item.ticker).filter(Boolean))];
    const filter = $("#news-ticker-filter");
    filter.innerHTML = ["all", ...tickers].map((ticker) => `<button type="button" class="${state.newsFilter === ticker ? "is-active" : ""}" data-news-filter="${html(ticker)}">${ticker === "all" ? "全部" : html(ticker)}</button>`).join("");
    $$('[data-news-filter]').forEach((button) => button.addEventListener("click", () => { state.newsFilter = button.dataset.newsFilter; renderNews(); }));
    $("#news-asof").textContent = bundle?.generated_at ? `采集 ${formatTime(bundle.generated_at)}` : "档案索引";
    const note = $("#news-source-note");
    if (items.length) {
      note.className = `data-alert ${bundle.status === "ok" ? "neutral" : ""}`;
      note.textContent = `结构化新闻 ${items.length} 条 · 状态 ${bundle.status || "unknown"}。来源健康与新闻数量分开记录，空结果不等于没有事件。`;
    } else {
      note.className = "data-alert neutral";
      note.textContent = "尚无结构化新闻数据，当前仅索引已归档的新闻分析分卷。";
    }
    const visible = state.newsFilter === "all" ? items : items.filter((item) => item.ticker === state.newsFilter);
    if (visible.length) {
      $("#news-grid").innerHTML = visible.map((item) => {
        const url = safeUrl(item.url);
        const title = url ? `<a href="${html(url)}" target="_blank" rel="noopener noreferrer">${html(item.title)}</a>` : html(item.title);
        return `<article class="news-card"><div class="news-card-head"><span class="news-source">${html(item.source || "未知来源")}</span><span>${formatTime(item.published_at)}</span></div><h2>${title}</h2><p>${html(item.summary || "无摘要")}</p><div class="news-card-foot"><span>${html(item.ticker || "市场资讯")}</span><span>${item.source_tier === "primary" ? "原始来源" : "聚合来源"}</span></div></article>`;
      }).join("");
      return;
    }
    const fallback = (state.latest?.results || []).filter((result) => result.files?.news);
    $("#news-grid").innerHTML = fallback.map((result) => `<button class="news-card report-index" type="button" data-news-report="${html(result.ticker)}"><div class="news-card-head"><span class="news-source">研究档案</span><span>${html(state.latest.trade_date || "")}</span></div><h2>${html(result.ticker)} 新闻分析</h2><p>打开本次研究中的新闻分析分卷，查看引用和判断依据。</p><div class="news-card-foot"><span>${html(ratingLabel(result.rating))}</span><span>查看分卷 →</span></div></button>`).join("") || '<div class="empty-state"><b>暂无新闻覆盖</b><span>下次研究运行完成后再刷新。</span></div>';
    $$('[data-news-report]').forEach((button) => button.addEventListener("click", () => {
      state.selectedArchiveIndex = 0;
      selectArchiveTicker(button.dataset.newsReport);
      const result = state.latest.results.find((item) => item.ticker === button.dataset.newsReport);
      if (result?.files?.news) loadReportTab("news", result.files);
      setPage("archive");
    }));
  }

  function normalizeOptions(data) {
    if (Number(data?.schema_version) >= 2 && data?.quick_metrics) {
      return {
        schema: 2,
        generated: data.quote_generated_at,
        status: data.source_status || {},
        asof: data.source_asof || {},
        underlying: data.underlying || {},
        quick: data.quick_metrics || {},
        slow: data.slow_metrics || {},
        contracts: data.contracts || [],
        priceSeries: data.slow_metrics?.price_series || [],
        limitations: data.limitations || [],
        attribution: data.attribution || data.source || "VolGuard",
      };
    }
    const options = Array.isArray(data?.options) ? data.options : [];
    const call = options.filter((item) => String(item["类型"] || item["名称"] || "").includes("购"));
    const put = options.filter((item) => String(item["类型"] || item["名称"] || "").includes("沽"));
    const sum = (rows, key) => rows.reduce((total, item) => total + (Number(item[key]) || 0), 0);
    return {
      schema: 1,
      generated: data?.generated_at,
      status: { overall: "snapshot", market_phase: data?.market?.options_quality?.market_state || "unknown" },
      asof: { options_latest: data?.market?.options_data_asof || data?.market?.source_asof?.options, underlying: data?.market?.data_asof, slow_snapshot: data?.generated_at },
      underlying: { symbol: data?.market?.symbol, last: data?.market?.spot, change_pct: data?.market?.change_pct, quote_asof: data?.market?.data_asof },
      quick: {
        spot: data?.market?.spot,
        underlying_change_pct: data?.market?.change_pct,
        contract_count: options.length,
        call_count: call.length,
        put_count: put.length,
        open_interest_total: sum(options, "持仓量"),
        put_call_oi_ratio: sum(call, "持仓量") ? sum(put, "持仓量") / sum(call, "持仓量") : null,
        put_call_volume_ratio: sum(call, "成交量") ? sum(put, "成交量") / sum(call, "成交量") : null,
        median_relative_spread_pct: data?.exposure?.median_relative_spread_pct,
      },
      slow: { status: "ok", asof: data?.generated_at, market: data?.market, risk: data?.risk, exposure: data?.exposure },
      contracts: options.map((item) => ({
        code: item["代码"], name: item["名称"], option_type: String(item["类型"] || item["名称"] || "").includes("沽") ? "put" : "call",
        month: item["月份"], expiry: item["到期日"], quote_asof: item["行情时间"], bid: item["买入价"], last: item["最新价"], ask: item["卖出价"],
        open_interest: item["持仓量"], strike: item["行权价"], volume: item["成交量"], implied_volatility: item["隐含波动率"],
      })),
      priceSeries: data?.price_series || [],
      limitations: ["静态快照模式：指标和行情不会随 30 秒页面轮询重新计算。"],
      attribution: "VolGuard snapshot",
    };
  }

  function metricCard(label, value, meta, cls = "") {
    return `<div class="metric-card"><div class="metric-label">${html(label)}</div><div class="metric-value ${cls}">${html(value)}</div><div class="metric-meta">${html(meta || "")}</div></div>`;
  }

  function renderOptions() {
    const option = state.options;
    if (!option) return;
    const q = option.quick;
    const risk = option.slow?.risk || {};
    const exposure = option.slow?.exposure || {};
    const overall = option.status?.overall || "unknown";
    const marketPhase = option.status?.market_phase || "unknown";
    const signal = $("#option-signal");
    const closed = overall === "market_closed" || marketPhase === "closed";
    const unavailable = overall === "unavailable" || overall === "static_only";
    signal.className = `option-signal ${unavailable ? "is-bad" : closed || state.optionsMode === "snapshot" ? "is-warn" : "is-good"}`;
    signal.innerHTML = `<div class="signal-rule"></div><div><span>${state.optionsMode === "live" ? "实时行情" : "历史快照"}</span><h2>${closed ? "市场已收盘" : unavailable ? "实时行情不可用" : "行情链路正常"}</h2><p>${state.optionsMode === "snapshot" ? "实时接口未部署或不可用，当前显示静态快照。" : `数据源状态：${html(sourceStatusLabel(overall))}。页面刷新不会改变上游数据时间。`}</p></div>`;
    $("#side-options-asof").textContent = formatTime(option.asof.options_latest || option.generated);
    $("#price-asof").textContent = `ETF ${formatTime(option.asof.underlying)}`;
    const change = Number(q.underlying_change_pct);
    const slowAsOf = formatTime(option.asof.slow_snapshot || option.slow?.asof);
    $("#option-metrics").innerHTML = [
      metricCard("50ETF", formatNumber(q.spot, 4), `${formatNumber(change, 2)}%`, change > 0 ? "positive" : change < 0 ? "negative" : ""),
      metricCard("持仓沽购比", formatNumber(q.put_call_oi_ratio ?? exposure.pcr_oi, 3), "认沽持仓 / 认购持仓"),
      metricCard("成交沽购比", formatNumber(q.put_call_volume_ratio ?? exposure.pcr_volume, 3), "认沽成交 / 认购成交"),
      metricCard("平均隐波", risk.iv_avg != null ? `${formatNumber(risk.iv_avg, 2)}%` : "—", `指标时间 ${slowAsOf}`, risk.iv_avg > 40 ? "warning" : ""),
      metricCard("风险价值 95", risk.var_95 != null ? `${formatNumber(risk.var_95, 2)}%` : "—", risk.var_method || "慢指标"),
      metricCard("最大痛点", formatNumber(exposure.max_pain ?? q.front_max_pain, 3), exposure.near_expiry || q.front_expiry || "近月"),
      metricCard("净 Gamma 敞口", exposure.gex_net != null ? `${formatNumber(exposure.gex_net, 3)}B` : "—", exposure.gex_unit || "持仓量估算"),
      metricCard("净 Delta 敞口", exposure.dex_net != null ? `${formatNumber(exposure.dex_net, 3)}B` : "—", exposure.dex_unit || "持仓量估算"),
      metricCard("合约数量", formatNumber(q.contract_count, 0), `${q.call_count || 0} 认购 / ${q.put_count || 0} 认沽`),
      metricCard("双边价差", q.median_relative_spread_pct != null ? `${formatNumber(q.median_relative_spread_pct, 2)}%` : "—", "相对价差中位数"),
      metricCard("IV 覆盖", risk.iv_coverage_pct != null ? `${formatNumber(risk.iv_coverage_pct, 1)}%` : "—", risk.iv_valid_count != null ? `${risk.iv_valid_count}/${risk.iv_eligible_count}` : "慢指标"),
      metricCard("25D 偏斜", exposure.iv_skew_25d_pp != null ? `${formatNumber(exposure.iv_skew_25d_pp, 2)}pp` : "—", "认沽 IV - 认购 IV"),
    ].join("");
    renderExposure(option);
    renderPriceChart(option.priceSeries);
    renderOptionChain();
    const stale = $("#options-stale-alert");
    const reason = state.optionsMode === "snapshot" ? "当前使用静态回退快照；30 秒刷新只能检查新快照，不能生成实时行情。" : closed ? "市场已收盘；最近成交时间停留在收盘附近属于正常状态。" : "";
    stale.hidden = !reason;
    stale.className = `data-alert ${closed ? "neutral" : ""}`;
    stale.textContent = reason;
    $("#options-provenance").innerHTML = `<b>来源：</b>${html(option.attribution)} · 行情 ${html(formatFullTime(option.asof.options_latest))} · 慢指标 ${html(formatFullTime(option.asof.slow_snapshot || option.slow?.asof))}<br>${option.limitations.map(html).join(" · ")}`;
  }

  function renderExposure(option) {
    const e = option.slow?.exposure || {};
    const q = option.quick || {};
    const pair = (label, put, call, unit = "") => {
      const p = Math.abs(Number(put) || 0); const c = Math.abs(Number(call) || 0); const max = Math.max(p, c, 1);
      return `<div class="exposure-pair"><div class="exposure-pair-head"><b>${html(label)}</b><span>认沽 ${formatNumber(put, 3)}${unit} / 认购 ${formatNumber(call, 3)}${unit}</span></div><div class="exposure-bar"><i class="put" style="width:${Math.min(100, p / max * 100)}%"></i><i class="call" style="width:${Math.min(100, c / max * 100)}%"></i></div></div>`;
    };
    $("#exposure-unit").textContent = e.is_estimate ? "持仓量估算" : "快速统计";
    $("#exposure-detail").innerHTML = `${pair("持仓量", q.put_open_interest, q.call_open_interest)}${pair("成交量", q.put_volume, q.call_volume)}${e.gex_call != null ? pair("Gamma Exposure", e.gex_put, e.gex_call, "B") : ""}<div class="quality-list"><div class="quality-row"><span>近月</span><b>${html(e.near_month || q.front_expiry || "—")}</b></div><div class="quality-row"><span>有效 IV</span><b>${e.iv_eligible_count ? `${e.exposure_contract_count || 0}/${e.iv_eligible_count}` : "—"}</b></div><div class="quality-row"><span>报价合约</span><b>${formatNumber(q.quoted_contract_count, 0)}</b></div></div>`;
  }

  function renderPriceChart(series) {
    const svg = $("#price-chart");
    const rows = (series || []).map((item) => ({ x: item.date, y: Number(item.close) })).filter((item) => Number.isFinite(item.y));
    if (rows.length < 2) {
      svg.innerHTML = '<line x1="30" x2="690" y1="110" y2="110" class="chart-grid-line" stroke-dasharray="4 6"/>';
      $("#price-chart-legend").textContent = "实时端点不携带完整历史曲线；慢快照更新后恢复。";
      return;
    }
    const min = Math.min(...rows.map((row) => row.y)); const max = Math.max(...rows.map((row) => row.y)); const range = max - min || 1;
    const point = (row, index) => `${30 + index / (rows.length - 1) * 660},${190 - (row.y - min) / range * 150}`;
    const points = rows.map(point).join(" ");
    const area = `30,190 ${points} 690,190`;
    svg.innerHTML = [40, 90, 140, 190].map((y) => `<line x1="30" x2="690" y1="${y}" y2="${y}" class="chart-grid-line"/>`).join("") + `<polygon points="${area}" class="chart-area"/><polyline points="${points}" class="chart-line"/><circle cx="690" cy="${point(rows.at(-1), rows.length - 1).split(",")[1]}" r="4" class="chart-end"/><text x="30" y="212" class="chart-label">${html(String(rows[0].x).slice(0, 10))}</text><text x="642" y="212" class="chart-label">${html(String(rows.at(-1).x).slice(0, 10))}</text>`;
    $("#price-chart-legend").innerHTML = `<span>区间低 ${formatNumber(min, 3)}</span><span>区间高 ${formatNumber(max, 3)}</span><span>最新 ${formatNumber(rows.at(-1).y, 3)}</span>`;
  }

  function renderOptionChain() {
    if (!state.options) return;
    const type = $("#chain-type").value;
    const query = $("#chain-query").value.trim().toLowerCase();
    const rows = state.options.contracts.filter((item) => (type === "all" || item.option_type === type) && (!query || `${item.code} ${item.name}`.toLowerCase().includes(query))).slice(0, 60);
    if (!rows.length) {
      $("#option-chain").innerHTML = '<div class="empty-state compact"><b>没有匹配合约</b><span>调整类型或搜索条件。</span></div>';
      return;
    }
    $("#option-chain").innerHTML = `<table class="data-table option-table"><thead><tr><th>代码</th><th>合约</th><th>类型</th><th>到期</th><th>行权价</th><th>买</th><th>最新</th><th>卖</th><th>成交量</th><th>持仓</th><th>行情时间</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${html(item.code)}</td><td>${html(item.name)}</td><td>${item.option_type === "put" ? "认沽" : "认购"}</td><td>${html(item.expiry || item.month || "—")}</td><td>${formatNumber(item.strike, 3)}</td><td>${formatNumber(item.bid, 4)}</td><td>${formatNumber(item.last, 4)}</td><td>${formatNumber(item.ask, 4)}</td><td>${formatNumber(item.volume, 0)}</td><td>${formatNumber(item.open_interest, 0)}</td><td>${formatTime(item.quote_asof)}</td></tr>`).join("")}</tbody></table>`;
  }

  function renderHealth() {
    const health = state.health;
    const pill = $("#global-health");
    const label = $("#global-health-label");
    const dot = $(".status-dot", pill);
    dot.className = "status-dot";
    if (!health) {
      dot.classList.add("is-bad"); label.textContent = "健康接口不可用"; return;
    }
    dot.classList.add(health.status === "ok" ? "is-good" : "is-warn");
    label.textContent = health.status === "ok" ? "服务正常" : "部分降级";
    $("#health-checked-at").textContent = `核验 ${formatTime(health.checked_at)}`;
    const checks = health.checks || [];
    const configured = Object.entries(health.configured || {}).map(([name, ok]) => ({ name: `配置 / ${name}`, ok, status: ok ? 200 : 0, latency_ms: null, detail: { status: ok ? "configured" : "missing" } }));
    $("#health-grid").innerHTML = [...checks, ...configured].map((check) => `<article class="health-card"><div class="health-card-head"><h3><span class="status-dot ${check.ok ? "is-good" : "is-bad"}"></span> ${html(check.name)}</h3><span class="health-latency">${check.latency_ms != null ? `${check.latency_ms}ms` : "CONFIG"}</span></div><p>HTTP ${check.status || "—"} · ${html(check.detail?.status || check.error || (check.ok ? "ok" : "unavailable"))}<br>${html(check.detail?.generated_at ? formatFullTime(check.detail.generated_at) : "")}</p></article>`).join("");
  }

  function bytesToBase64(bytes) {
    let binary = ""; bytes.forEach((value) => { binary += String.fromCharCode(value); }); return btoa(binary);
  }
  function base64ToBytes(value) {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }
  async function deviceCryptoKey(create = false) {
    if (!window.crypto?.subtle) return null;
    let raw = localStorage.getItem(STORAGE.deviceKey);
    if (!raw && create) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      raw = bytesToBase64(bytes);
      localStorage.setItem(STORAGE.deviceKey, raw);
    }
    return raw ? crypto.subtle.importKey("raw", base64ToBytes(raw), "AES-GCM", false, ["encrypt", "decrypt"]) : null;
  }
  async function encryptForDevice(value) {
    const key = await deviceCryptoKey(true); if (!key) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value)));
    return JSON.stringify({ v: 1, iv: bytesToBase64(iv), data: bytesToBase64(data) });
  }
  async function decryptForDevice(payload) {
    try {
      const parsed = JSON.parse(payload); const key = await deviceCryptoKey(false); if (!key) return "";
      const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(parsed.iv) }, key, base64ToBytes(parsed.data));
      return decoder.decode(data);
    } catch { return ""; }
  }

  function syncCredentialUi() {
    $$('[data-access-input]').forEach((input) => { if (input.value !== state.accessCode) input.value = state.accessCode; });
    $$('[data-remember-input]').forEach((input) => { input.checked = state.rememberCode; });
    $$('[data-credential-state]').forEach((node) => { node.textContent = state.accessCode ? (state.rememberCode ? "访问码已加密保存在此设备。" : "访问码仅保存在当前标签会话。") : "尚未保存访问码。"; });
    $("#vault-label").textContent = state.rememberCode ? "设备加密存储" : "仅本次会话";
  }

  async function loadCredential() {
    state.accessCode = sessionStorage.getItem(STORAGE.sessionCode) || "";
    const encrypted = localStorage.getItem(STORAGE.encryptedCode);
    if (!state.accessCode && encrypted) {
      state.accessCode = await decryptForDevice(encrypted);
      state.rememberCode = Boolean(state.accessCode);
      if (state.accessCode) sessionStorage.setItem(STORAGE.sessionCode, state.accessCode);
    } else {
      state.rememberCode = Boolean(encrypted && state.accessCode);
    }
    syncCredentialUi();
  }

  async function saveCredential() {
    const code = $("#settings-code").value.trim();
    const remember = $("#settings-remember").checked;
    if (!code) { toast("请输入访问码", true); return; }
    state.accessCode = code;
    state.rememberCode = remember;
    sessionStorage.setItem(STORAGE.sessionCode, code);
    if (remember) {
      const encrypted = await encryptForDevice(code);
      if (!encrypted) { toast("当前浏览器不支持设备加密，仅保存到本次会话", true); state.rememberCode = false; }
      else localStorage.setItem(STORAGE.encryptedCode, encrypted);
    } else {
      localStorage.removeItem(STORAGE.encryptedCode);
    }
    syncCredentialUi(); toast("访问码已保存");
  }

  function clearCredential() {
    state.accessCode = ""; state.rememberCode = false;
    sessionStorage.removeItem(STORAGE.sessionCode); localStorage.removeItem(STORAGE.encryptedCode);
    syncCredentialUi(); toast("本机访问码副本已清除");
  }

  async function submitAction(path, body) {
    if (!state.accessCode) throw Object.assign(new Error("请先输入访问码"), { status: 401 });
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-code": state.accessCode },
      body: JSON.stringify(body),
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* empty */ }
    if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status, payload });
    return payload;
  }

  function loadThreads() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE.threads) || "[]");
      state.threads = Array.isArray(parsed) ? parsed.slice(0, 20) : [];
    } catch { state.threads = []; }
    if (!state.threads.length) createThread(false);
    else state.threadId = state.threads[0].id;
    renderThreads();
  }

  function saveThreads() {
    state.threads = state.threads.slice(0, 20).map((thread) => ({ ...thread, messages: (thread.messages || []).slice(-40) }));
    localStorage.setItem(STORAGE.threads, JSON.stringify(state.threads));
  }

  function createThread(render = true) {
    const thread = { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, title: "新研究对话", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
    state.threads.unshift(thread); state.threadId = thread.id; saveThreads();
    if (render) renderThreads();
  }
  function currentThread() { return state.threads.find((thread) => thread.id === state.threadId); }
  function deleteThread() {
    state.threads = state.threads.filter((thread) => thread.id !== state.threadId);
    if (!state.threads.length) createThread(false);
    state.threadId = state.threads[0].id; saveThreads(); renderThreads();
  }
  function renderThreads() {
    $("#thread-select").innerHTML = state.threads.map((thread) => `<option value="${html(thread.id)}" ${thread.id === state.threadId ? "selected" : ""}>${html(thread.title || "研究对话")}</option>`).join("");
    const thread = currentThread(); const log = $("#chat-log");
    if (!thread?.messages?.length) {
      log.innerHTML = '<div class="chat-empty" id="chat-empty"><span class="chat-monogram">问</span><b>在当前研究资料内提问</b><p>回答只基于当前报告或期权快照；资料没有的信息会明确说明。</p><div class="prompt-suggestions" id="prompt-suggestions"><button type="button">核心判断的反方证据是什么？</button><button type="button">列出最需要跟踪的三个风险条件</button></div></div>';
      bindPromptSuggestions(); return;
    }
    log.innerHTML = thread.messages.map((message) => `<div class="chat-message ${message.role === "user" ? "user" : "assistant"} ${message.error ? "is-error" : ""}"><div class="chat-message-meta">${message.role === "user" ? "我" : "研究助理"} · ${formatTime(message.at)}</div><div class="chat-message-body">${html(message.content)}</div></div>`).join("");
    log.scrollTop = log.scrollHeight;
  }

  function bindPromptSuggestions() {
    $$("#prompt-suggestions button").forEach((button) => button.addEventListener("click", () => { $("#chat-question").value = button.textContent; $("#chat-question").focus(); }));
  }

  function appendChatMessage(role, content, error = false) {
    const thread = currentThread();
    const message = { role, content, error, at: new Date().toISOString() };
    thread.messages.push(message); thread.updatedAt = message.at;
    if (thread.title === "新研究对话" && role === "user") thread.title = stripMarkdown(content, 28);
    saveThreads(); renderThreads(); return message;
  }

  function updateStreamingMessage(message, content, error = false) {
    message.content = content; message.error = error; message.at = message.at || new Date().toISOString();
    saveThreads(); renderThreads();
  }

  async function sendChat(question) {
    if (state.chatBusy) return;
    question = String(question || "").trim();
    if (!question) return;
    if (!state.accessCode) { toast("研究问答需要访问码，请在设置中保存", true); setPage("settings"); return; }
    state.chatBusy = true; $("#chat-send").disabled = true; $("#chat-question").value = "";
    appendChatMessage("user", question);
    const answer = appendChatMessage("assistant", "正在连接研究资料…");
    const historyMessages = currentThread().messages.slice(0, -2).filter((item) => !item.error).slice(-16).map((item) => ({ role: item.role, content: item.content }));
    const payload = { question, history: historyMessages, stream: true };
    if (state.page === "options") payload.volguard = true;
    else if (state.selectedReport?.path) payload.report = state.selectedReport.path;
    let content = "";
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-access-code": state.accessCode }, body: JSON.stringify(payload) });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        let error; try { error = await response.json(); } catch { error = {}; }
        throw new Error(error.error || `研究问答失败 (${response.status})`);
      }
      if (!contentType.includes("text/event-stream") || !response.body) {
        const data = await response.json(); content = data.answer || "上游未返回内容"; updateStreamingMessage(answer, content); return;
      }
      const reader = response.body.getReader(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          let event = "message"; const dataLines = [];
          block.split("\n").forEach((line) => { if (line.startsWith("event:")) event = line.slice(6).trim(); if (line.startsWith("data:")) dataLines.push(line.slice(5).trim()); });
          if (!dataLines.length) continue;
          let data; try { data = JSON.parse(dataLines.join("\n")); } catch { continue; }
          if (event === "meta" && data.context) $("#chat-context").textContent = data.context;
          if (event === "delta") { content += data.content || ""; updateStreamingMessage(answer, content || "…"); }
          if (event === "error") throw new Error(data.error || "流式回答中断");
        }
      }
      updateStreamingMessage(answer, content || "上游未返回内容");
    } catch (error) {
      updateStreamingMessage(answer, error.message || "研究问答暂时不可用", true);
      toast(error.message || "研究问答暂时不可用", true);
    } finally {
      state.chatBusy = false; $("#chat-send").disabled = false;
    }
  }

  async function loadLatest() {
    try {
      state.latest = (await fetchJson(["/api/latest", "./data/latest.json"])).data;
      renderLatest();
      renderArchiveList();
      if (state.news) renderNews();
    }
    catch { $("#overview-alert").hidden = false; $("#overview-alert").textContent = "最新研究数据暂时不可用。"; }
  }
  async function loadHistory() {
    try { const payload = (await fetchJson(["/api/history", "./data/history.json"])).data; state.history = Array.isArray(payload) ? payload : payload.history || []; renderArchiveList(); }
    catch { state.history = []; renderArchiveList(); }
  }
  async function loadSettings() {
    try { state.settings = (await fetchJson(["/api/settings", "./data/workbench-settings.json"])).data; renderSettingsSummary(); }
    catch { state.settings = null; renderSettingsSummary(); }
  }
  async function loadRuns() {
    try { state.runs = (await fetchJson("/api/runs")).data.runs || []; }
    catch { state.runs = []; }
    renderRuns();
  }
  async function loadHealth() {
    try { state.health = (await fetchJson("/api/health")).data; }
    catch { state.health = null; }
    renderHealth();
  }
  async function loadNews() {
    try { state.news = (await fetchJson(["./data/news.json", "/api/news"])).data; }
    catch { state.news = { version: 1, status: "unavailable", items: [] }; }
    renderNews();
  }
  async function loadOptions() {
    $("#refresh-options").disabled = true;
    try {
      const result = await fetchJson("/api/volguard");
      state.optionsMode = result.response.headers.get("x-volguard-mode") || (Number(result.data.schema_version) >= 2 ? "live" : "snapshot");
      state.options = normalizeOptions(result.data); renderOptions();
    } catch {
      $("#options-stale-alert").hidden = false; $("#options-stale-alert").textContent = "期权实时与快照数据均不可用。";
    } finally {
      state.optionCountdown = 30; $("#refresh-options").disabled = false;
    }
  }

  async function refreshAll() {
    $("#refresh-all").disabled = true;
    await Promise.allSettled([loadLatest(), loadHistory(), loadSettings(), loadRuns(), loadHealth(), loadNews(), loadOptions()]);
    $("#refresh-all").disabled = false; toast("工作台数据已核验");
  }

  function bindEvents() {
    $$('[data-view-target]').forEach((node) => node.addEventListener("click", (event) => { event.preventDefault(); setPage(node.dataset.viewTarget); }));
    $("#nav-open").addEventListener("click", openNav); $("#nav-close").addEventListener("click", closeNav); $("#nav-backdrop").addEventListener("click", closeNav);
    $("#mobile-more").addEventListener("click", openNav);
    $("#assistant-open").addEventListener("click", openAssistant); $("#assistant-close").addEventListener("click", closeAssistant); $("#assistant-backdrop").addEventListener("click", closeAssistant);
    $("#refresh-all").addEventListener("click", refreshAll); $("#refresh-runs").addEventListener("click", loadRuns); $("#refresh-health").addEventListener("click", loadHealth); $("#refresh-news").addEventListener("click", loadNews); $("#refresh-options").addEventListener("click", loadOptions);
    $("#global-health").addEventListener("click", () => setPage("settings"));
    $("#archive-query").addEventListener("input", renderArchiveList); $("#archive-reset").addEventListener("click", () => { $("#archive-query").value = ""; state.selectedArchiveIndex = 0; renderArchiveList(); });
    $("#chain-type").addEventListener("change", renderOptionChain); $("#chain-query").addEventListener("input", renderOptionChain);
    $$('[data-secret-toggle]').forEach((button) => button.addEventListener("click", () => { const input = button.closest(".secret-field").querySelector("input"); input.type = input.type === "password" ? "text" : "password"; button.querySelector("use").setAttribute("href", input.type === "password" ? "#i-eye" : "#i-eye-off"); }));
    $$('[data-access-input]').forEach((input) => input.addEventListener("input", () => { state.accessCode = input.value; syncCredentialUi(); }));
    $$('[data-remember-input]').forEach((input) => input.addEventListener("change", () => { state.rememberCode = input.checked; syncCredentialUi(); }));
    $("#save-credential").addEventListener("click", saveCredential); $("#clear-credential").addEventListener("click", clearCredential);
    $("#analyze-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      state.accessCode = $("#analyze-code").value.trim();
      if (state.accessCode) sessionStorage.setItem(STORAGE.sessionCode, state.accessCode);
      const notice = $("#analyze-notice"); notice.textContent = "正在提交…"; notice.className = "form-notice"; $("#analyze-submit").disabled = true;
      try { const payload = await submitAction("/api/analyze", { tickers: $("#analyze-tickers").value }); notice.textContent = `${payload.message}：${(payload.tickers || []).join(", ")}`; toast("研究任务已受理"); window.setTimeout(loadRuns, 2500); }
      catch (error) { notice.textContent = error.message; notice.classList.add("is-bad"); }
      finally { $("#analyze-submit").disabled = false; }
    });
    $("#save-settings").addEventListener("click", async () => {
      state.accessCode = $("#settings-code").value.trim();
      const notice = $("#settings-notice"); notice.textContent = "正在校验并保存…"; notice.className = "form-notice"; $("#save-settings").disabled = true;
      try { const payload = await submitAction("/api/settings", { tickers: $("#settings-tickers").value, settings: state.settings }); state.settings = payload.settings; renderSettingsSummary(); notice.textContent = payload.message; toast("每日研究清单已受理"); }
      catch (error) { notice.textContent = error.message; notice.classList.add("is-bad"); }
      finally { $("#save-settings").disabled = false; }
    });
    $("#thread-select").addEventListener("change", (event) => { state.threadId = event.target.value; renderThreads(); });
    $("#new-thread").addEventListener("click", () => { createThread(); openAssistant(); }); $("#delete-thread").addEventListener("click", deleteThread);
    $("#chat-form").addEventListener("submit", (event) => { event.preventDefault(); sendChat($("#chat-question").value); });
    $("#chat-question").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#chat-form").requestSubmit(); } });
    window.addEventListener("hashchange", () => setPage(location.hash.slice(1), false));
    window.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeNav(); closeAssistant(); } });
  }

  async function init() {
    bindEvents(); loadThreads(); await loadCredential();
    setPage(location.hash.slice(1) || "overview", false);
    await Promise.allSettled([loadLatest(), loadHistory(), loadSettings(), loadRuns(), loadHealth(), loadNews(), loadOptions()]);
    window.setInterval(() => {
      state.optionCountdown -= 1;
      if (state.optionCountdown <= 0) loadOptions();
      $("#options-countdown").textContent = `自动刷新 ${Math.max(0, state.optionCountdown)}s`;
    }, 1000);
    window.setInterval(loadRuns, 60000);
  }

  init().catch((error) => { console.error(error); toast("工作台初始化失败，请刷新重试", true); });
})();
