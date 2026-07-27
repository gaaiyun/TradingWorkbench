const LOCAL_FORMATTERS = new Map();
export const BOOTSTRAP_SCHEMA_VERSION = "v2";
export const MAX_SCHEDULED_EXTERNAL_REQUESTS = 32;
export const MAX_SELECTABLE_EXTERNAL_REQUESTS = 40;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function formatterFor(timeZone) {
  let formatter = LOCAL_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    LOCAL_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

export function localDateTimeAt(scheduledTime, timeZone = "Asia/Shanghai") {
  const values = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(scheduledTime))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const date = `${values.year}-${values.month}-${values.day}`;
  const time = `${values.hour}:${values.minute}`;
  return {
    date,
    time,
    weekday: values.weekday,
    key: `${date}T${time}`,
  };
}

function minutes(clock) {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

function scheduledTask(type, schedule, local, scheduledTime) {
  return {
    type,
    schedule,
    localSlot: local.key,
    scheduledFor: new Date(scheduledTime).toISOString(),
  };
}

function isTradingDay(local, holidays) {
  return local.weekday !== "Sat" &&
    local.weekday !== "Sun" &&
    !holidays?.has(local.date);
}

function matchesInterval(clock, window, interval) {
  const value = minutes(clock);
  const start = minutes(window.start);
  const end = minutes(window.end);
  return value >= start && value <= end && (value - start) % interval === 0;
}

function matchesClockInterval(clock, interval) {
  return minutes(clock) % interval === 0;
}

function dueTasksAtMinute(profile, scheduledTime, holidaySets) {
  if (!profile?.enabled) return [];
  const local = localDateTimeAt(
    scheduledTime,
    profile.timezone || "Asia/Shanghai",
  );
  const schedules = profile.schedules;
  const tasks = [];
  const usMarketLocal = localDateTimeAt(
    scheduledTime,
    "America/New_York",
  );

  if (
    schedules.usCloseSnapshot.enabled &&
    local.time === schedules.usCloseSnapshot.time &&
    isTradingDay(usMarketLocal, holidaySets.us)
  ) {
    tasks.push(scheduledTask(
      "usCloseSnapshot",
      "usCloseSnapshot",
      local,
      scheduledTime,
    ));
  }

  const cnTradingDay = isTradingDay(local, holidaySets.cn);
  if (
    cnTradingDay &&
    schedules.preMarketBrief.enabled &&
    local.time === schedules.preMarketBrief.time
  ) {
    tasks.push(scheduledTask(
      "premarketBrief",
      "preMarketBrief",
      local,
      scheduledTime,
    ));
  }

  if (cnTradingDay && schedules.cnIntraday.enabled) {
    const collect = schedules.cnIntraday.windows.some((window) =>
      matchesInterval(
        local.time,
        window,
        schedules.cnIntraday.collectionIntervalMinutes,
      ));
    if (collect) {
      tasks.push(scheduledTask(
        "intradayCollect",
        "cnIntraday/collect",
        local,
        scheduledTime,
      ));
    }
    const signal = schedules.cnIntraday.windows.some((window) =>
      matchesInterval(
        local.time,
        window,
        schedules.cnIntraday.signalIntervalMinutes,
      ));
    if (signal) {
      tasks.push(scheduledTask(
        "intradaySignal",
        "cnIntraday/signal",
        local,
        scheduledTime,
      ));
    }
  }

  if (
    cnTradingDay &&
    schedules.closeDeepAnalysis.enabled &&
    local.time === schedules.closeDeepAnalysis.time
  ) {
    tasks.push(scheduledTask(
      "cnDailySnapshot",
      "closeDeepAnalysis/cn-daily",
      local,
      scheduledTime,
    ));
    tasks.push(scheduledTask(
      "closeFullAnalysis",
      "closeDeepAnalysis",
      local,
      scheduledTime,
    ));
  }

  // News uses only the budget left after market snapshots and signals at the
  // same slot. The settings domain caps aggregate profile frequency.
  const newsEnabled = schedules.newsRefresh?.enabled !== false;
  const intervalNewsDue = matchesClockInterval(
    local.time,
    schedules.newsRefresh?.intervalMinutes || 15,
  );
  const premarketNewsDue = cnTradingDay &&
    schedules.preMarketBrief.enabled &&
    local.time === schedules.preMarketBrief.time;
  if (newsEnabled && (intervalNewsDue || premarketNewsDue)) {
    tasks.push(scheduledTask(
      "newsCollect",
      "newsRefresh",
      local,
      scheduledTime,
    ));
  }
  return tasks;
}

export function dueTasksForProfile(profile, scheduledTime, holidaySets = {}) {
  const tick = Math.floor(scheduledTime / 60_000) * 60_000;
  const tasks = [];
  for (let offset = 4; offset >= 0; offset -= 1) {
    tasks.push(...dueTasksAtMinute(
      profile,
      tick - offset * 60_000,
      holidaySets,
    ));
  }
  return tasks;
}

const SCHEDULE_BY_TYPE = {
  usCloseSnapshot: "usCloseSnapshot",
  cnDailySnapshot: "closeDeepAnalysis/cn-daily",
  newsCollect: "newsRefresh",
  premarketBrief: "preMarketBrief",
  intradayCollect: "cnIntraday/collect",
  intradaySignal: "cnIntraday/signal",
  closeFullAnalysis: "closeDeepAnalysis",
};

export function taskFromScheduledSlot(profileOrRow, possibleRow) {
  const row = possibleRow ?? profileOrRow;
  if (typeof row?.payload_json === "string" && row.payload_json) {
    try {
      const payload = JSON.parse(row.payload_json);
      if (!payload?.profile || !payload?.task) return null;
      return {
        profile: payload.profile,
        task: payload.task,
        profileRevision: row.profile_revision,
        payloadHash: row.payload_hash,
      };
    } catch {
      return null;
    }
  }
  const profile = possibleRow ? profileOrRow : null;
  if (!profile) return null;
  const schedule = SCHEDULE_BY_TYPE[row.slot_type];
  if (!schedule) return null;
  const scheduledTime = Date.parse(row.scheduled_for);
  if (!Number.isFinite(scheduledTime)) return null;
  return {
    type: row.slot_type,
    schedule,
    localSlot: localDateTimeAt(
      scheduledTime,
      profile.timezone || "Asia/Shanghai",
    ).key,
    scheduledFor: new Date(scheduledTime).toISOString(),
  };
}

export async function slotIdForTask(profileId, task) {
  const material = `${profileId}\n${task.schedule}\n${task.localSlot}`;
  return `slot-${await sha256(material)}`;
}

export async function scheduledPayloadForTask(profile, task, profileRevision) {
  const payloadJson = stableJson({
    version: 1,
    profile,
    task,
  });
  return {
    profileRevision: String(profileRevision || ""),
    payloadJson,
    payloadHash: await sha256(payloadJson),
  };
}

export async function profileRevisionForProfile(profile) {
  return sha256(stableJson(profile));
}

function bootstrapTargetGroups(profile) {
  const cnTargets = profile.targets.filter((target) =>
    target.market === "CN" &&
    (target.role === "core" || target.role === "comparison"));
  const usTargets = profile.targets.filter((target) =>
    ["US", "HK"].includes(target.market) && target.role === "driver");
  return [
    ...cnTargets.flatMap((target) => [
      { taskType: "intradayCollect", target, timeframe: "5m" },
      { taskType: "cnDailySnapshot", target, timeframe: "1d" },
    ]),
    ...usTargets.map((target) => ({
      taskType: "usCloseSnapshot",
      target,
      timeframe: "1d",
    })),
    {
      taskType: "newsCollect",
      target: {
        symbol: "__news__",
        market: "NEWS",
        role: "discovery",
        analysis: "signal",
      },
      timeframe: "news",
    },
  ];
}

export async function bootstrapRequirementsForProfile(
  profile,
  completedIdentities = new Set(),
) {
  if (!profile?.enabled) return [];
  const requirements = [];
  for (const { taskType, target, timeframe } of bootstrapTargetGroups(profile)) {
    const targetHash = await sha256(stableJson({
      schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
      taskType,
      timeframe,
      target,
    }));
    const identity = [
      "bootstrap",
      profile.id,
      target.symbol,
      timeframe,
      BOOTSTRAP_SCHEMA_VERSION,
      targetHash,
    ].join(":");
    if (!completedIdentities.has(identity)) {
      requirements.push({
        identity,
        profileId: profile.id,
        symbol: target.symbol,
        timeframe,
        schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
        targetHash,
        taskType,
      });
    }
  }
  return requirements;
}

export function estimateTaskExternalRequests(profile, task) {
  const targetSymbols = Array.isArray(task?.targetSymbols)
    ? new Set(task.targetSymbols)
    : null;
  const selectedTargets = profile.targets.filter((target) =>
    !targetSymbols || targetSymbols.has(target.symbol));
  if (task.type === "intradayCollect" || task.type === "cnDailySnapshot") {
    const targets = selectedTargets.filter((target) =>
      target.market === "CN" &&
      (target.role === "core" || target.role === "comparison"));
    return targets.length * 3;
  }
  if (task.type === "usCloseSnapshot") {
    const targets = selectedTargets.filter((target) =>
      ["US", "HK"].includes(target.market) && target.role === "driver");
    return targets.reduce(
      (total, target) => total + (target.market === "US" ? 5 : 1),
      0,
    );
  }
  if (task.type === "newsCollect") return 21;
  if (task.type === "closeFullAnalysis") return 2;
  if (task.type === "intradaySignal") {
    return Math.max(
      1,
      selectedTargets.filter((target) =>
        target.market === "CN" &&
        (target.role === "core" || target.role === "comparison")).length,
    );
  }
  if (task.type === "premarketBrief") return 1;
  return 0;
}

function targetExternalRequestCost(taskType, target) {
  if (taskType === "intradayCollect" || taskType === "cnDailySnapshot") {
    return target.market === "CN" &&
        (target.role === "core" || target.role === "comparison")
      ? 3
      : 0;
  }
  if (taskType === "usCloseSnapshot") {
    if (!["US", "HK"].includes(target.market) || target.role !== "driver") {
      return 0;
    }
    return target.market === "US" ? 5 : 1;
  }
  return 0;
}

export function splitTaskWithinRequestLimit(
  profile,
  task,
  requestLimit = MAX_SCHEDULED_EXTERNAL_REQUESTS,
) {
  const limit = Math.max(1, Math.min(
    MAX_SCHEDULED_EXTERNAL_REQUESTS,
    Math.floor(Number(requestLimit) || MAX_SCHEDULED_EXTERNAL_REQUESTS),
  ));
  const selectedSymbols = Array.isArray(task?.targetSymbols)
    ? new Set(task.targetSymbols)
    : null;
  const targets = profile.targets
    .filter((target) =>
      !selectedSymbols || selectedSymbols.has(target.symbol))
    .map((target) => ({
      target,
      cost: targetExternalRequestCost(task.type, target),
    }))
    .filter(({ cost }) => cost > 0);
  if (
    targets.length === 0 ||
    targets.reduce((total, { cost }) => total + cost, 0) <= limit
  ) {
    return [task];
  }

  const groups = [];
  let group = [];
  let groupCost = 0;
  for (const entry of targets) {
    if (group.length > 0 && groupCost + entry.cost > limit) {
      groups.push(group);
      group = [];
      groupCost = 0;
    }
    group.push(entry.target.symbol);
    groupCost += entry.cost;
  }
  if (group.length > 0) groups.push(group);
  return groups.map((targetSymbols, index) => {
    const allowed = new Set(targetSymbols);
    const bootstrapRequirements = Array.isArray(task.bootstrapRequirements)
      ? task.bootstrapRequirements.filter(({ symbol }) => allowed.has(symbol))
      : undefined;
    return {
      ...task,
      localSlot: `${task.localSlot}#part-${index + 1}-of-${groups.length}`,
      targetSymbols,
      ...(bootstrapRequirements
        ? { bootstrapRequirements }
        : {}),
    };
  });
}

export function selectFairWorkWithinBudget(work, options = {}) {
  const budget = Math.min(
    MAX_SELECTABLE_EXTERNAL_REQUESTS,
    Math.max(
      0,
      Number(options.externalRequestBudget ?? 40),
    ),
  );
  const groups = new Map();
  for (const item of work) {
    const profileId = item.profile?.id ?? item.profileId ?? "";
    if (!groups.has(profileId)) groups.set(profileId, []);
    groups.get(profileId).push(item);
  }
  const profileIds = [...groups.keys()].sort();
  const rotation = profileIds.length === 0
    ? 0
    : Math.abs(Number(options.rotation ?? 0)) % profileIds.length;
  const orderedIds = [
    ...profileIds.slice(rotation),
    ...profileIds.slice(0, rotation),
  ];
  const ordered = [];
  let remaining = work.length;
  while (remaining > 0) {
    let progressed = false;
    for (const profileId of orderedIds) {
      const group = groups.get(profileId);
      if (group.length === 0) continue;
      ordered.push(group.shift());
      remaining -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  const candidates = options.preserveOrder ? [...work] : ordered;
  const maxTasks = Math.min(
    MAX_SCHEDULED_EXTERNAL_REQUESTS,
    Math.max(
      0,
      Math.floor(Number(
        options.maxTasks ?? MAX_SCHEDULED_EXTERNAL_REQUESTS,
      )),
    ),
  );
  const selected = [];
  const deferred = [];
  let estimatedExternalRequests = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    const cost = estimateTaskExternalRequests(item.profile, item.task);
    if (
      selected.length < maxTasks &&
      estimatedExternalRequests + cost <= budget
    ) {
      selected.push(item);
      estimatedExternalRequests += cost;
      continue;
    }
    deferred.push(item);
    if (options.stopOnBudgetExhaustion) {
      deferred.push(...candidates.slice(index + 1));
      break;
    }
  }
  return {
    selected,
    deferred,
    estimatedExternalRequests,
    externalRequestBudget: budget,
  };
}
