import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as settingsDomain from "../functions/api/_workbench_settings.mjs";

const {
  WorkbenchSettingsError,
  buildWorkbenchSettings,
  normalizeWorkbenchTickers,
  parseWorkbenchSettings,
} = settingsDomain;

const DEFAULT_OBJECTIVE =
  "持续监控 A 股通信与半导体 ETF，识别美股半导体隔夜行情、行业新闻和政策变化对 A 股 ETF 的传导影响。";

function defaultSettingsInput() {
  return JSON.parse(
    readFileSync(new URL("../public/data/workbench-settings.json", import.meta.url), "utf8"),
  );
}

function assertSettingsError(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof WorkbenchSettingsError);
    assert.equal(error.code, code);
    return true;
  });
}

test("normalizes A-share and US symbols while preserving first-seen order", () => {
  assert.deepEqual(
    normalizeWorkbenchTickers(" nvda, 600519.sh，000001  BRK.B nvda "),
    ["NVDA", "600519.SS", "000001.SZ", "BRK-B"],
  );
});

test("normalizes Google aliases and Hong Kong symbols for the workbench", () => {
  assert.deepEqual(
    normalizeWorkbenchTickers(["googl", "GOOG", "03887", "03887.HK", "3887"]),
    ["GOOGL", "GOOG", "3887.HK"],
  );
});

test("the checked-in v2 settings contain the only default research profile", () => {
  const raw = defaultSettingsInput();
  const settings = parseWorkbenchSettings(raw);

  assert.equal(raw.version, 2);
  assert.equal(settings.version, 2);
  assert.equal(settings.profiles.length, 1);

  const [profile] = settings.profiles;
  assert.equal(profile.id, "cn-semi-comms");
  assert.equal(profile.objective, DEFAULT_OBJECTIVE);
  assert.equal(profile.enabled, true);
  assert.equal(profile.timezone, "Asia/Shanghai");
  assert.deepEqual(
    profile.targets.map(({ symbol, name, role, analysis }) => ({ symbol, name, role, analysis })),
    [
      { symbol: "515880.SS", name: "通信ETF", role: "core", analysis: "full" },
      { symbol: "512480.SS", name: "半导体ETF", role: "core", analysis: "full" },
      { symbol: "159995.SZ", name: "芯片ETF", role: "comparison", analysis: "signal" },
      { symbol: "SOXX", name: "SOXX", role: "driver", analysis: "signal" },
      { symbol: "SMH", name: "SMH", role: "driver", analysis: "signal" },
      { symbol: "NVDA", name: "NVDA", role: "driver", analysis: "signal" },
      { symbol: "TSM", name: "TSM", role: "driver", analysis: "signal" },
      { symbol: "AVGO", name: "AVGO", role: "driver", analysis: "signal" },
      { symbol: "AMD", name: "AMD", role: "driver", analysis: "signal" },
      { symbol: "ASML", name: "ASML", role: "driver", analysis: "signal" },
      { symbol: "ORCL", name: "Oracle", role: "driver", analysis: "signal" },
      { symbol: "GOOGL", name: "Alphabet", role: "driver", analysis: "signal" },
      { symbol: "3887.HK", name: "HashKey Holdings", role: "driver", analysis: "signal" },
    ],
  );
  assert.deepEqual(
    profile.systemBenchmarks.map(({ id, name }) => ({ id, name })),
    [
      { id: "csi-300", name: "沪深300" },
      { id: "nasdaq-100", name: "纳指100" },
      { id: "usd-cny", name: "美元人民币" },
    ],
  );
  assert.deepEqual(settings.tickers, ["515880.SS", "512480.SS"]);
});

test("migrates v1 ticker settings into one complete v2 profile", () => {
  const settings = parseWorkbenchSettings({
    version: 1,
    tickers: [" nvda ", "600519.sh", "NVDA"],
  });

  assert.equal(settings.version, 2);
  assert.equal(settings.profiles.length, 1);
  assert.deepEqual(settings.tickers, ["NVDA", "600519.SS"]);
  assert.deepEqual(
    settings.profiles[0].targets.map((target) => target.symbol),
    ["NVDA", "600519.SS"],
  );
  for (const target of settings.profiles[0].targets) {
    assert.equal(target.name, target.symbol);
    assert.equal(target.role, "core");
    assert.equal(target.analysis, "full");
  }
  assert.deepEqual(Object.keys(settings.profiles[0]).sort(), [
    "agentBudget",
    "alerts",
    "enabled",
    "id",
    "name",
    "objective",
    "schedules",
    "systemBenchmarks",
    "targets",
    "timezone",
  ]);
  assert.equal(settings.profiles[0].timezone, "Asia/Shanghai");
  assert.deepEqual(settings.profiles[0].systemBenchmarks, []);
});

test("keeps the legacy ticker-list builder usable during the API transition", () => {
  const settings = buildWorkbenchSettings(["spy", "000001"]);
  assert.equal(settings.version, 2);
  assert.deepEqual(settings.tickers, ["SPY", "000001.SZ"]);
});

test("accepts only the supported target roles and analysis depths", () => {
  const invalidRole = defaultSettingsInput();
  invalidRole.profiles[0].targets[0].role = "watch";
  assertSettingsError("INVALID_TARGET_ROLE", () => buildWorkbenchSettings(invalidRole));

  const invalidAnalysis = defaultSettingsInput();
  invalidAnalysis.profiles[0].targets[0].analysis = "deep";
  assertSettingsError("INVALID_ANALYSIS_DEPTH", () => buildWorkbenchSettings(invalidAnalysis));

  const benchmarkRole = defaultSettingsInput();
  benchmarkRole.profiles[0].targets[0].role = "benchmark";
  assert.equal(buildWorkbenchSettings(benchmarkRole).profiles[0].targets[0].role, "benchmark");
});

test("de-duplicates normalized target symbols before enforcing the fourteen-target cap", () => {
  const duplicate = defaultSettingsInput();
  duplicate.profiles[0].targets.push({
    symbol: "515880.sh",
    name: "重复名称不会覆盖首项",
    market: "cn",
    role: "comparison",
    analysis: "signal",
  });
  const normalized = buildWorkbenchSettings(duplicate);
  assert.equal(normalized.profiles[0].targets.length, 13);
  assert.equal(normalized.profiles[0].targets[0].name, "通信ETF");

  const tooMany = defaultSettingsInput();
  tooMany.profiles[0].targets.push({
    symbol: "INTC",
    name: "Intel",
    market: "US",
    role: "driver",
    analysis: "signal",
  });
  assert.equal(buildWorkbenchSettings(tooMany).profiles[0].targets.length, 14);
  tooMany.profiles[0].targets.push({
    symbol: "MSFT",
    name: "Microsoft",
    market: "US",
    role: "driver",
    analysis: "signal",
  });
  tooMany.profiles[0].targets.push({
    symbol: "INTU",
    name: "Intuit",
    market: "US",
    role: "driver",
    analysis: "signal",
  });
  assertSettingsError("TOO_MANY_TARGETS", () => buildWorkbenchSettings(tooMany));
});

test("does not count provider-neutral system benchmarks toward the target cap", () => {
  const input = defaultSettingsInput();
  input.profiles[0].systemBenchmarks = Array.from({ length: 12 }, (_, index) => ({
    id: `provider-neutral-${index}`,
    name: `系统基准 ${index}`,
    market: "GLOBAL",
  }));
  assert.equal(buildWorkbenchSettings(input).profiles[0].targets.length, 13);
});

test("ships semantic schedules, high-severity web and PushPlus alerts, and bounded agent work", () => {
  const [profile] = buildWorkbenchSettings(defaultSettingsInput()).profiles;
  assert.deepEqual(profile.schedules, {
    usCloseSnapshot: { enabled: true, time: "05:35" },
    preMarketBrief: { enabled: true, time: "08:25" },
    newsRefresh: { enabled: true, intervalMinutes: 15 },
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
  });
  assert.deepEqual(profile.alerts, {
    channels: { web: true, pushPlus: true },
    pushMinSeverity: "high",
    quietHours: { start: "22:30", end: "07:30" },
  });
  assert.deepEqual(profile.agentBudget, {
    intradayLightSummariesPerDay: 3,
    fullAnalysesPerDay: 1,
  });
});

test("accepts valid IANA timezones and rejects unknown timezone identifiers", () => {
  const valid = defaultSettingsInput();
  valid.profiles[0].timezone = "America/New_York";
  assert.equal(buildWorkbenchSettings(valid).profiles[0].timezone, "America/New_York");

  const invalid = defaultSettingsInput();
  invalid.profiles[0].timezone = "Mars/Olympus_Mons";
  assertSettingsError("INVALID_TIMEZONE", () => buildWorkbenchSettings(invalid));
});

test("rejects malformed schedule times, windows, and intervals", () => {
  const invalidTime = defaultSettingsInput();
  invalidTime.profiles[0].schedules.usCloseSnapshot.time = "5:35";
  assertSettingsError("INVALID_SCHEDULE_TIME", () => buildWorkbenchSettings(invalidTime));

  const reversedWindow = defaultSettingsInput();
  reversedWindow.profiles[0].schedules.cnIntraday.windows[0] = {
    start: "11:30",
    end: "09:30",
  };
  assertSettingsError("INVALID_SCHEDULE_WINDOW", () => buildWorkbenchSettings(reversedWindow));

  const overlappingWindows = defaultSettingsInput();
  overlappingWindows.profiles[0].schedules.cnIntraday.windows[1].start = "11:00";
  assertSettingsError("INVALID_SCHEDULE_WINDOW", () => buildWorkbenchSettings(overlappingWindows));

  const invalidCollectionInterval = defaultSettingsInput();
  invalidCollectionInterval.profiles[0].schedules.cnIntraday.collectionIntervalMinutes = 0;
  assertSettingsError("INVALID_SCHEDULE_INTERVAL", () =>
    buildWorkbenchSettings(invalidCollectionInterval),
  );

  const incompatibleSignalInterval = defaultSettingsInput();
  incompatibleSignalInterval.profiles[0].schedules.cnIntraday.signalIntervalMinutes = 12;
  assertSettingsError("INVALID_SCHEDULE_INTERVAL", () =>
    buildWorkbenchSettings(incompatibleSignalInterval),
  );

  const invalidNewsInterval = defaultSettingsInput();
  invalidNewsInterval.profiles[0].schedules.newsRefresh.intervalMinutes = 7;
  assertSettingsError("INVALID_NEWS_REFRESH_INTERVAL", () =>
    buildWorkbenchSettings(invalidNewsInterval),
  );
});

test("allows overnight quiet hours but rejects invalid or all-day quiet ranges", () => {
  const valid = buildWorkbenchSettings(defaultSettingsInput());
  assert.deepEqual(valid.profiles[0].alerts.quietHours, { start: "22:30", end: "07:30" });

  const invalidTime = defaultSettingsInput();
  invalidTime.profiles[0].alerts.quietHours.end = "24:00";
  assertSettingsError("INVALID_QUIET_HOURS", () => buildWorkbenchSettings(invalidTime));

  const allDay = defaultSettingsInput();
  allDay.profiles[0].alerts.quietHours.end = "22:30";
  assertSettingsError("INVALID_QUIET_HOURS", () => buildWorkbenchSettings(allDay));
});

test("rejects non-integer or negative agent budgets", () => {
  const invalid = defaultSettingsInput();
  invalid.profiles[0].agentBudget.intradayLightSummariesPerDay = 1.5;
  assertSettingsError("INVALID_AGENT_BUDGET", () => buildWorkbenchSettings(invalid));

  const negative = defaultSettingsInput();
  negative.profiles[0].agentBudget.fullAnalysesPerDay = -1;
  assertSettingsError("INVALID_AGENT_BUDGET", () => buildWorkbenchSettings(negative));
});

test("returns deeply immutable canonical settings detached from the input", () => {
  const input = defaultSettingsInput();
  input.ignored = true;
  input.profiles[0].name = "  主题研究  ";
  input.profiles[0].ignored = true;
  input.profiles[0].targets[0].symbol = "515880.sh";
  input.profiles[0].targets[0].market = "cn";
  input.profiles[0].targets[0].ignored = true;
  input.profiles[0].systemBenchmarks[0].id = "  csi-300  ";
  input.profiles[0].systemBenchmarks[0].ignored = true;
  const settings = buildWorkbenchSettings(input);

  assert.equal(settings.profiles[0].name, "主题研究");
  assert.equal(settings.profiles[0].targets[0].symbol, "515880.SS");
  assert.equal(settings.profiles[0].targets[0].market, "CN");
  assert.equal(settings.profiles[0].systemBenchmarks[0].id, "csi-300");
  assert.equal("ignored" in settings, false);
  assert.equal("ignored" in settings.profiles[0], false);
  assert.equal("ignored" in settings.profiles[0].targets[0], false);
  assert.equal("ignored" in settings.profiles[0].systemBenchmarks[0], false);
  assert.equal(Object.keys(settings).includes("tickers"), false);
  assert.equal(JSON.stringify(settings).includes("tickers"), false);

  input.profiles[0].targets[0].name = "输入随后被修改";
  assert.equal(settings.profiles[0].targets[0].name, "通信ETF");
  assert.equal(Object.isFrozen(settings), true);
  assert.equal(Object.isFrozen(settings.profiles), true);
  assert.equal(Object.isFrozen(settings.profiles[0]), true);
  assert.equal(Object.isFrozen(settings.profiles[0].targets[0]), true);
  assert.equal(Object.isFrozen(settings.profiles[0].schedules.cnIntraday.windows[0]), true);
  assert.equal(Object.isFrozen(settings.tickers), true);
  assert.throws(() => settings.profiles.push(settings.profiles[0]), TypeError);
});

test("rejects duplicate profile ids", () => {
  const input = defaultSettingsInput();
  const duplicate = structuredClone(input.profiles[0]);
  duplicate.id = input.profiles[0].id;
  input.profiles.push(duplicate);
  assertSettingsError("DUPLICATE_PROFILE_ID", () => buildWorkbenchSettings(input));
});

test("migrates legacy schedules without creating an unsafe multi-profile news burst", () => {
  const single = defaultSettingsInput();
  delete single.profiles[0].schedules.newsRefresh;
  assert.deepEqual(
    buildWorkbenchSettings(single).profiles[0].schedules.newsRefresh,
    { enabled: true, intervalMinutes: 15 },
  );

  const multi = defaultSettingsInput();
  const second = structuredClone(multi.profiles[0]);
  second.id = "legacy-second";
  delete multi.profiles[0].schedules.newsRefresh;
  delete second.schedules.newsRefresh;
  multi.profiles.push(second);
  assert.deepEqual(
    buildWorkbenchSettings(multi).profiles.map((profile) =>
      profile.schedules.newsRefresh),
    [
      { enabled: false, intervalMinutes: 60 },
      { enabled: false, intervalMinutes: 60 },
    ],
  );
});

test("caps aggregate news refresh work so multiple profiles cannot starve market tasks", () => {
  const input = defaultSettingsInput();
  const source = input.profiles[0];
  input.profiles = [0, 1, 2].map((index) => ({
    ...structuredClone(source),
    id: `news-capacity-${index}`,
    schedules: {
      ...structuredClone(source.schedules),
      newsRefresh: { enabled: true, intervalMinutes: 15 },
    },
  }));
  assertSettingsError("NEWS_REFRESH_CAPACITY_EXCEEDED", () =>
    buildWorkbenchSettings(input),
  );

  input.profiles[1].schedules.newsRefresh.intervalMinutes = 30;
  input.profiles[2].schedules.newsRefresh.intervalMinutes = 30;
  assert.equal(buildWorkbenchSettings(input).profiles.length, 3);
});

test("accepts only immutable profile ids matching the public 1-64 character contract", () => {
  for (const invalidId of [" profile", "profile ", "profile.name", "中文", "", "x".repeat(65)]) {
    const input = defaultSettingsInput();
    input.profiles[0].id = invalidId;
    assertSettingsError("INVALID_PROFILE_ID", () => buildWorkbenchSettings(input));
  }

  for (const validId of ["A", "profile_2", "profile-2", "x".repeat(64)]) {
    const input = defaultSettingsInput();
    input.profiles[0].id = validId;
    assert.equal(buildWorkbenchSettings(input).profiles[0].id, validId);
  }

  assert.equal(typeof settingsDomain.updateWorkbenchProfile, "function");
  assertSettingsError("IMMUTABLE_PROFILE_ID", () =>
    settingsDomain.updateWorkbenchProfile(defaultSettingsInput(), "cn-semi-comms", {
      id: "renamed-profile",
    }),
  );
});

test("accepts at most eight profiles", () => {
  const input = defaultSettingsInput();
  input.profiles = Array.from({ length: 8 }, (_, index) => ({
    ...structuredClone(input.profiles[0]),
    id: `profile-${index + 1}`,
    schedules: {
      ...structuredClone(input.profiles[0].schedules),
      newsRefresh: { enabled: true, intervalMinutes: 60 },
    },
  }));
  assert.equal(buildWorkbenchSettings(input).profiles.length, 8);

  input.profiles.push({
    ...structuredClone(input.profiles[0]),
    id: "profile-9",
  });
  assertSettingsError("TOO_MANY_PROFILES", () => buildWorkbenchSettings(input));
});

test("profile domain helpers create blank profiles, patch nested fields, copy safely, and protect the last profile", () => {
  assert.equal(typeof settingsDomain.createWorkbenchProfile, "function");
  assert.equal(typeof settingsDomain.updateWorkbenchProfile, "function");
  assert.equal(typeof settingsDomain.copyWorkbenchProfile, "function");
  assert.equal(typeof settingsDomain.deleteWorkbenchProfile, "function");

  const created = settingsDomain.createWorkbenchProfile(defaultSettingsInput(), {
    id: "us_tech",
    name: "美国科技",
    objective: "跟踪美国科技股。",
    timezone: "America/New_York",
  });
  const blank = created.profiles.find(({ id }) => id === "us_tech");
  assert.deepEqual(blank.targets, []);
  assert.deepEqual(blank.systemBenchmarks, []);
  assert.equal(blank.enabled, false);

  const patched = settingsDomain.updateWorkbenchProfile(created, "us_tech", {
    enabled: true,
    alerts: { pushMinSeverity: "critical" },
  });
  const updated = patched.profiles.find(({ id }) => id === "us_tech");
  assert.equal(updated.enabled, true);
  assert.equal(updated.alerts.pushMinSeverity, "critical");
  assert.deepEqual(updated.alerts.channels, blank.alerts.channels);
  assert.deepEqual(updated.alerts.quietHours, blank.alerts.quietHours);

  const copied = settingsDomain.copyWorkbenchProfile(patched, "us_tech");
  const duplicate = copied.profiles.find(({ id }) => id === "us_tech-copy");
  assert.equal(duplicate.name, "美国科技 副本");
  assert.equal(duplicate.enabled, false);
  assert.deepEqual(duplicate.targets, updated.targets);

  const withoutCopy = settingsDomain.deleteWorkbenchProfile(copied, "us_tech-copy");
  assert.equal(withoutCopy.profiles.some(({ id }) => id === "us_tech-copy"), false);
  assertSettingsError("LAST_PROFILE_REQUIRED", () =>
    settingsDomain.deleteWorkbenchProfile(
      { version: 2, profiles: [structuredClone(defaultSettingsInput().profiles[0])] },
      "cn-semi-comms",
    ),
  );
});

test("de-duplicates the legacy analysis list across profiles in first-seen order", () => {
  const input = defaultSettingsInput();
  const secondProfile = structuredClone(input.profiles[0]);
  secondProfile.id = "second-profile";
  secondProfile.targets = [
    { symbol: "515880.SS", name: "重复通信ETF", market: "CN", role: "core", analysis: "full" },
    { symbol: "SPY", name: "SPY", market: "US", role: "core", analysis: "full" },
  ];
  input.profiles.push(secondProfile);

  assert.deepEqual(buildWorkbenchSettings(input).tickers, ["515880.SS", "512480.SS", "SPY"]);
});

test("accepts valid v2 profiles above the legacy cap and truncates only the legacy projection", () => {
  const input = defaultSettingsInput();
  input.profiles[0].targets = ["A", "B", "C", "D", "E", "F"].map((symbol) => ({
    symbol,
    name: symbol,
    market: "US",
    role: "core",
    analysis: "full",
  }));
  const secondProfile = structuredClone(input.profiles[0]);
  secondProfile.id = "second-profile";
  secondProfile.targets = ["G", "H", "I", "J", "K"].map((symbol) => ({
    symbol,
    name: symbol,
    market: "US",
    role: "core",
    analysis: "full",
  }));
  input.profiles.push(secondProfile);

  const settings = buildWorkbenchSettings(input);
  assert.equal(settings.profiles.length, 2);
  assert.deepEqual(settings.tickers, ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
});

test("rejects empty, unsupported, and exchange-mismatched symbols", () => {
  assertSettingsError("EMPTY_TICKERS", () => normalizeWorkbenchTickers("  ,， "));
  assertSettingsError("INVALID_TICKER", () => normalizeWorkbenchTickers(["BTC-USD"]));
  assertSettingsError("INVALID_TICKER", () => normalizeWorkbenchTickers(["600519.SZ"]));
  assert.equal(normalizeWorkbenchTickers(["0700.HK"])[0], "0700.HK");
});

test("rejects more than ten unique symbols instead of truncating", () => {
  const validEleven = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
  assertSettingsError("TOO_MANY_TICKERS", () => normalizeWorkbenchTickers(validEleven));
});

test("rejects unknown schema versions", () => {
  assertSettingsError("UNSUPPORTED_SETTINGS_VERSION", () =>
    parseWorkbenchSettings({ version: 3, profiles: [] }),
  );
});

test("assistant drawer styles do not match assistant chat messages", () => {
  const css = readFileSync(new URL("../public/assets/workbench.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /(^|\n)\s*\.assistant(?:\.is-open)?\s*\{/);
  assert.match(css, /#assistant\.is-open\s*\{\s*transform:\s*translateX\(0\)/);
});

test("the workbench view derives its ticker list from the explicitly selected profile", () => {
  const script = readFileSync(
    new URL("../public/assets/workbench.js", import.meta.url),
    "utf8",
  );
  const helper = /function settingsTickers\(settings\) \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  function renderSettingsSummary/.exec(
    script,
  );
  assert.match(script, /function settingsTickers\(settings\)/);
  assert.ok(helper);
  assert.match(helper[1], /currentProfileFor\(settings,\s*state\.selectedProfileId\)/);
  assert.doesNotMatch(helper[1], /\.find\(\(profile\) => profile\.enabled\)/);
  assert.doesNotMatch(helper[1], /\.flatMap\(/);
  assert.match(helper[1], /target\.analysis === "full"/);
  assert.match(script, /settingsTickers\(state\.settings\)/);
  assert.match(script, /function currentProfile\(\)/);
});

test("the workbench patches the selected profile with the last observed D1 revision", () => {
  const script = readFileSync(
    new URL("../public/assets/workbench.js", import.meta.url),
    "utf8",
  );
  assert.match(script, /settingsUpdatedAt:\s*null/);
  assert.match(script, /expectedUpdatedAt:\s*state\.settingsUpdatedAt/);
  assert.match(script, /`\/api\/settings\/profiles\/\$\{encodeURIComponent\(profile\.id\)\}`/);
  assert.match(script, /"PATCH"/);
  assert.match(script, /state\.settingsUpdatedAt\s*=\s*snapshot\.revision/);
  assert.match(script, /if\s*\(!state\.settingsWritable\s*\|\|\s*!state\.settingsUpdatedAt\)/);
});
