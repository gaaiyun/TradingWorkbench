export const WORKBENCH_SETTINGS_VERSION = 2;
export const MAX_WORKBENCH_TICKERS = 10;
export const MAX_WORKBENCH_TARGETS = MAX_WORKBENCH_TICKERS;

const A_SHARE = /^(\d{6})(?:\.(SS|SH|SZ))?$/;
const US_EQUITY = /^([A-Z]{1,5})(?:[.-]([A-Z]))?$/;
const TARGET_ROLES = new Set(["core", "comparison", "driver", "benchmark"]);
const ANALYSIS_DEPTHS = new Set(["full", "signal"]);
const ALERT_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export class WorkbenchSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkbenchSettingsError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkbenchSettingsError(code, message);
}

/**
 * Normalize one supported equity symbol.
 *
 * A-share bare codes are mapped to Yahoo Finance suffixes. US class-share
 * separators are normalized to the Yahoo-compatible dash form (BRK.B -> BRK-B).
 */
export function normalizeWorkbenchTicker(raw) {
  if (typeof raw !== "string") {
    fail("INVALID_TICKER", "标的代码必须是字符串");
  }

  const ticker = raw.trim().toUpperCase();
  if (!ticker) {
    fail("INVALID_TICKER", "标的代码不能为空");
  }

  const aShare = A_SHARE.exec(ticker);
  if (aShare) {
    const [, code, rawExchange] = aShare;
    let expectedExchange = null;
    if ("569".includes(code[0])) expectedExchange = "SS";
    if ("0123".includes(code[0])) expectedExchange = "SZ";
    if (!expectedExchange) {
      fail("INVALID_TICKER", `不支持的 A 股代码：${ticker}`);
    }

    const exchange = rawExchange === "SH" ? "SS" : rawExchange;
    if (exchange && exchange !== expectedExchange) {
      fail("INVALID_TICKER", `A 股代码与交易所后缀不匹配：${ticker}`);
    }
    return `${code}.${expectedExchange}`;
  }

  const usEquity = US_EQUITY.exec(ticker);
  if (usEquity) {
    const [, root, shareClass] = usEquity;
    return shareClass ? `${root}-${shareClass}` : root;
  }

  fail("INVALID_TICKER", `仅支持 A 股或美股代码：${ticker}`);
}

function tickerItems(input) {
  if (typeof input === "string") {
    return input.split(/[,，\s]+/).filter(Boolean);
  }
  if (Array.isArray(input)) {
    return input;
  }
  fail("INVALID_TICKERS_TYPE", "tickers 必须是代码数组或逗号分隔字符串");
}

/** Normalize, de-duplicate in first-seen order, and enforce the saved-list cap. */
export function normalizeWorkbenchTickers(input) {
  const items = tickerItems(input);
  if (items.length === 0) {
    fail("EMPTY_TICKERS", "每日分析清单不能为空");
  }

  const seen = new Set();
  const tickers = [];
  for (const item of items) {
    const ticker = normalizeWorkbenchTicker(item);
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    tickers.push(ticker);
    if (tickers.length > MAX_WORKBENCH_TICKERS) {
      fail("TOO_MANY_TICKERS", `每日分析清单最多 ${MAX_WORKBENCH_TICKERS} 个标的`);
    }
  }
  return tickers;
}

function requiredString(value, field, code = "INVALID_PROFILE") {
  if (typeof value !== "string" || !value.trim()) {
    fail(code, `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function objectValue(value, field, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${field} 必须是对象`);
  }
  return value;
}

function booleanValue(value, field, code) {
  if (typeof value !== "boolean") {
    fail(code, `${field} 必须是布尔值`);
  }
  return value;
}

function clockTime(value, field, code) {
  if (typeof value !== "string" || !CLOCK_TIME.test(value)) {
    fail(code, `${field} 必须使用 HH:mm 格式`);
  }
  return value;
}

function timeMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    fail("INVALID_TARGET", "target 必须是对象");
  }
  const role = requiredString(target.role, "target.role", "INVALID_TARGET");
  if (!TARGET_ROLES.has(role)) {
    fail("INVALID_TARGET_ROLE", `不支持的 target role：${role}`);
  }
  const analysis = requiredString(target.analysis, "target.analysis", "INVALID_TARGET");
  if (!ANALYSIS_DEPTHS.has(analysis)) {
    fail("INVALID_ANALYSIS_DEPTH", `不支持的 analysis depth：${analysis}`);
  }
  return {
    symbol: normalizeWorkbenchTicker(target.symbol),
    name: requiredString(target.name, "target.name", "INVALID_TARGET"),
    market: requiredString(target.market, "target.market", "INVALID_TARGET").toUpperCase(),
    role,
    analysis,
  };
}

function normalizeTargets(targets) {
  const seen = new Set();
  const normalized = [];
  for (const rawTarget of targets) {
    const target = normalizeTarget(rawTarget);
    if (seen.has(target.symbol)) continue;
    seen.add(target.symbol);
    normalized.push(target);
    if (normalized.length > MAX_WORKBENCH_TARGETS) {
      fail("TOO_MANY_TARGETS", `每个研究目标最多 ${MAX_WORKBENCH_TARGETS} 个用户标的`);
    }
  }
  return normalized;
}

function normalizeSystemBenchmark(benchmark) {
  if (!benchmark || typeof benchmark !== "object" || Array.isArray(benchmark)) {
    fail("INVALID_BENCHMARK", "system benchmark 必须是对象");
  }
  return {
    id: requiredString(benchmark.id, "systemBenchmark.id", "INVALID_BENCHMARK"),
    name: requiredString(benchmark.name, "systemBenchmark.name", "INVALID_BENCHMARK"),
    market: requiredString(benchmark.market, "systemBenchmark.market", "INVALID_BENCHMARK").toUpperCase(),
  };
}

function normalizeTimedSchedule(value, field) {
  const schedule = objectValue(value, field, "INVALID_SCHEDULES");
  return {
    enabled: booleanValue(schedule.enabled, `${field}.enabled`, "INVALID_SCHEDULES"),
    time: clockTime(schedule.time, `${field}.time`, "INVALID_SCHEDULE_TIME"),
  };
}

function normalizeSchedules(value) {
  const schedules = objectValue(value, "profile.schedules", "INVALID_SCHEDULES");
  const intraday = objectValue(
    schedules.cnIntraday,
    "schedules.cnIntraday",
    "INVALID_SCHEDULES",
  );
  if (!Array.isArray(intraday.windows) || intraday.windows.length === 0) {
    fail("INVALID_SCHEDULE_WINDOW", "盘中窗口必须是非空数组");
  }
  const windows = intraday.windows.map((rawWindow, index) => {
    const field = `schedules.cnIntraday.windows[${index}]`;
    const window = objectValue(rawWindow, field, "INVALID_SCHEDULE_WINDOW");
    const start = clockTime(window.start, `${field}.start`, "INVALID_SCHEDULE_TIME");
    const end = clockTime(window.end, `${field}.end`, "INVALID_SCHEDULE_TIME");
    if (timeMinutes(start) >= timeMinutes(end)) {
      fail("INVALID_SCHEDULE_WINDOW", `${field} 的开始时间必须早于结束时间`);
    }
    return { start, end };
  });
  for (let index = 1; index < windows.length; index += 1) {
    if (timeMinutes(windows[index].start) < timeMinutes(windows[index - 1].end)) {
      fail("INVALID_SCHEDULE_WINDOW", "盘中窗口必须按时间排序且不能重叠");
    }
  }

  const collectionIntervalMinutes = intraday.collectionIntervalMinutes;
  const signalIntervalMinutes = intraday.signalIntervalMinutes;
  if (
    !Number.isInteger(collectionIntervalMinutes) ||
    collectionIntervalMinutes <= 0 ||
    !Number.isInteger(signalIntervalMinutes) ||
    signalIntervalMinutes <= 0 ||
    signalIntervalMinutes < collectionIntervalMinutes ||
    signalIntervalMinutes % collectionIntervalMinutes !== 0
  ) {
    fail("INVALID_SCHEDULE_INTERVAL", "盘中 interval 必须为正整数，且信号间隔应是采集间隔的整数倍");
  }

  return {
    usCloseSnapshot: normalizeTimedSchedule(
      schedules.usCloseSnapshot,
      "schedules.usCloseSnapshot",
    ),
    preMarketBrief: normalizeTimedSchedule(
      schedules.preMarketBrief,
      "schedules.preMarketBrief",
    ),
    cnIntraday: {
      enabled: booleanValue(
        intraday.enabled,
        "schedules.cnIntraday.enabled",
        "INVALID_SCHEDULES",
      ),
      windows,
      collectionIntervalMinutes,
      signalIntervalMinutes,
    },
    closeDeepAnalysis: normalizeTimedSchedule(
      schedules.closeDeepAnalysis,
      "schedules.closeDeepAnalysis",
    ),
  };
}

function normalizeAlerts(value) {
  const alerts = objectValue(value, "profile.alerts", "INVALID_ALERTS");
  const channels = objectValue(alerts.channels, "alerts.channels", "INVALID_ALERTS");
  const quietHours = objectValue(
    alerts.quietHours,
    "alerts.quietHours",
    "INVALID_QUIET_HOURS",
  );
  const start = clockTime(quietHours.start, "alerts.quietHours.start", "INVALID_QUIET_HOURS");
  const end = clockTime(quietHours.end, "alerts.quietHours.end", "INVALID_QUIET_HOURS");
  if (start === end) {
    fail("INVALID_QUIET_HOURS", "静默时段不能覆盖全天");
  }
  const pushMinSeverity = requiredString(
    alerts.pushMinSeverity,
    "alerts.pushMinSeverity",
    "INVALID_ALERTS",
  );
  if (!ALERT_SEVERITIES.has(pushMinSeverity)) {
    fail("INVALID_ALERTS", `不支持的推送等级：${pushMinSeverity}`);
  }
  return {
    channels: {
      web: booleanValue(channels.web, "alerts.channels.web", "INVALID_ALERTS"),
      pushPlus: booleanValue(
        channels.pushPlus,
        "alerts.channels.pushPlus",
        "INVALID_ALERTS",
      ),
    },
    pushMinSeverity,
    quietHours: { start, end },
  };
}

function normalizeAgentBudget(value) {
  const budget = objectValue(value, "profile.agentBudget", "INVALID_AGENT_BUDGET");
  const intradayLightSummariesPerDay = budget.intradayLightSummariesPerDay;
  const fullAnalysesPerDay = budget.fullAnalysesPerDay;
  if (
    !Number.isInteger(intradayLightSummariesPerDay) ||
    intradayLightSummariesPerDay < 0 ||
    !Number.isInteger(fullAnalysesPerDay) ||
    fullAnalysesPerDay < 0
  ) {
    fail("INVALID_AGENT_BUDGET", "agentBudget 的每日次数必须是非负整数");
  }
  return { intradayLightSummariesPerDay, fullAnalysesPerDay };
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    fail("INVALID_PROFILE", "profile 必须是对象");
  }
  if (!Array.isArray(profile.targets) || profile.targets.length === 0) {
    fail("INVALID_TARGETS", "profile.targets 必须是非空数组");
  }
  if (!Array.isArray(profile.systemBenchmarks)) {
    fail("INVALID_BENCHMARKS", "profile.systemBenchmarks 必须是数组");
  }
  if (typeof profile.enabled !== "boolean") {
    fail("INVALID_PROFILE", "profile.enabled 必须是布尔值");
  }
  return {
    id: requiredString(profile.id, "profile.id"),
    name: requiredString(profile.name, "profile.name"),
    objective: requiredString(profile.objective, "profile.objective"),
    enabled: profile.enabled,
    timezone: requiredString(profile.timezone, "profile.timezone"),
    targets: normalizeTargets(profile.targets),
    systemBenchmarks: profile.systemBenchmarks.map(normalizeSystemBenchmark),
    schedules: normalizeSchedules(profile.schedules),
    alerts: normalizeAlerts(profile.alerts),
    agentBudget: normalizeAgentBudget(profile.agentBudget),
  };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

function withLegacyTickers(settings) {
  const seen = new Set();
  const tickers = [];
  for (const profile of settings.profiles) {
    if (!profile.enabled) continue;
    for (const target of profile.targets) {
      if (target.analysis !== "full" || seen.has(target.symbol)) continue;
      seen.add(target.symbol);
      tickers.push(target.symbol);
      if (tickers.length > MAX_WORKBENCH_TICKERS) {
        fail(
          "TOO_MANY_TICKERS",
          `兼容分析清单最多 ${MAX_WORKBENCH_TICKERS} 个唯一 full 标的`,
        );
      }
    }
  }
  Object.defineProperty(settings, "tickers", {
    enumerable: false,
    value: tickers,
  });
  return deepFreeze(settings);
}

function defaultSchedules() {
  return {
    usCloseSnapshot: { enabled: true, time: "05:35" },
    preMarketBrief: { enabled: true, time: "08:25" },
    cnIntraday: {
      enabled: true,
      windows: [
        { start: "09:30", end: "11:30" },
        { start: "13:00", end: "15:00" },
      ],
      collectionIntervalMinutes: 5,
      signalIntervalMinutes: 15,
    },
    closeDeepAnalysis: { enabled: true, time: "15:20" },
  };
}

function defaultAlerts() {
  return {
    channels: { web: true, pushPlus: true },
    pushMinSeverity: "high",
    quietHours: { start: "22:30", end: "07:30" },
  };
}

function defaultAgentBudget() {
  return {
    intradayLightSummariesPerDay: 3,
    fullAnalysesPerDay: 1,
  };
}

function migrateV1Tickers(input) {
  const tickers = normalizeWorkbenchTickers(input);
  return buildWorkbenchSettings({
    version: WORKBENCH_SETTINGS_VERSION,
    profiles: [
      {
        id: "migrated-v1",
        name: "迁移的每日分析清单",
        objective: "按原有每日分析清单持续跟踪市场标的。",
        enabled: true,
        timezone: "Asia/Shanghai",
        targets: tickers.map((symbol) => ({
          symbol,
          name: symbol,
          market: symbol.endsWith(".SS") || symbol.endsWith(".SZ") ? "CN" : "US",
          role: "core",
          analysis: "full",
        })),
        systemBenchmarks: [],
        schedules: defaultSchedules(),
        alerts: defaultAlerts(),
        agentBudget: defaultAgentBudget(),
      },
    ],
  });
}

export function buildWorkbenchSettings(input) {
  if (typeof input === "string" || Array.isArray(input)) {
    return migrateV1Tickers(input);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_SETTINGS", "v2 设置必须是 JSON 对象");
  }
  if (input.version !== WORKBENCH_SETTINGS_VERSION) {
    fail("UNSUPPORTED_SETTINGS_VERSION", `不支持的设置版本：${String(input.version)}`);
  }
  if (!Array.isArray(input.profiles) || input.profiles.length === 0) {
    fail("INVALID_PROFILES", "profiles 必须是非空数组");
  }
  const profiles = input.profiles.map(normalizeProfile);
  const profileIds = new Set();
  for (const profile of profiles) {
    if (profileIds.has(profile.id)) {
      fail("DUPLICATE_PROFILE_ID", `profile id 重复：${profile.id}`);
    }
    profileIds.add(profile.id);
  }
  return withLegacyTickers({
    version: WORKBENCH_SETTINGS_VERSION,
    profiles,
  });
}

export function parseWorkbenchSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_SETTINGS", "设置文件必须是 JSON 对象");
  }
  if (value.version === 1) {
    return migrateV1Tickers(value.tickers);
  }
  return buildWorkbenchSettings(value);
}

/** Replace the first enabled profile's full-analysis list without dropping its v2 metadata. */
export function updateWorkbenchFullAnalysisTargets(value, input) {
  const settings = parseWorkbenchSettings(value);
  const profileIndex = settings.profiles.findIndex((profile) => profile.enabled);
  if (profileIndex < 0) {
    fail("NO_ENABLED_PROFILE", "没有可更新的启用研究目标");
  }

  const symbols = normalizeWorkbenchTickers(input);
  const profile = settings.profiles[profileIndex];
  const existingBySymbol = new Map(profile.targets.map((target) => [target.symbol, target]));
  const signalTargets = profile.targets.filter((target) => target.analysis !== "full");
  const signalSymbols = new Set(signalTargets.map((target) => target.symbol));
  const fullTargets = symbols
    .filter((symbol) => !signalSymbols.has(symbol))
    .map((symbol) => {
      const existing = existingBySymbol.get(symbol);
      return {
        symbol,
        name: existing?.name || symbol,
        market:
          existing?.market ||
          (symbol.endsWith(".SS") || symbol.endsWith(".SZ") ? "CN" : "US"),
        role: existing?.role || "core",
        analysis: "full",
      };
    });
  const profiles = settings.profiles.map((candidate, index) =>
    index === profileIndex
      ? { ...candidate, targets: [...fullTargets, ...signalTargets] }
      : candidate,
  );
  return buildWorkbenchSettings({ version: WORKBENCH_SETTINGS_VERSION, profiles });
}
