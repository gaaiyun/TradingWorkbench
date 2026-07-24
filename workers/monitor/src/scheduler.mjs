const LOCAL_FORMATTERS = new Map();

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
      "newsCollect",
      "preMarketBrief/news",
      local,
      scheduledTime,
    ));
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
  newsCollect: "preMarketBrief/news",
  premarketBrief: "preMarketBrief",
  intradayCollect: "cnIntraday/collect",
  intradaySignal: "cnIntraday/signal",
  closeFullAnalysis: "closeDeepAnalysis",
};

export function taskFromScheduledSlot(profile, row) {
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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `slot-${hex}`;
}
