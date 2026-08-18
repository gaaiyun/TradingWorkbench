import assert from "node:assert/strict";
import test from "node:test";

import { monitorSettings } from "./helpers/monitor_settings.mjs";

const schedulerUrl = new URL(
  "../workers/monitor/src/scheduler.mjs",
  import.meta.url,
);

async function dueAt(iso, profileOverrides = {}, holidaySets = {}) {
  const { dueTasksForProfile } = await import(schedulerUrl);
  const baseSchedules = monitorSettings().profiles[0].schedules;
  const profile = monitorSettings({
    ...profileOverrides,
    schedules: {
      ...baseSchedules,
      ...profileOverrides.schedules,
      newsRefresh: profileOverrides.schedules?.newsRefresh ?? {
        enabled: true,
        intervalMinutes: 15,
      },
    },
  }).profiles[0];
  return dueTasksForProfile(profile, Date.parse(iso), holidaySets);
}

async function recoveryAt(iso, profileOverrides = {}, holidaySets = {}) {
  const { recoveryTasksForProfile } = await import(schedulerUrl);
  const baseSchedules = monitorSettings().profiles[0].schedules;
  const profile = monitorSettings({
    ...profileOverrides,
    schedules: {
      ...baseSchedules,
      ...profileOverrides.schedules,
      newsRefresh: profileOverrides.schedules?.newsRefresh ?? {
        enabled: true,
        intervalMinutes: 15,
      },
    },
  }).profiles[0];
  return recoveryTasksForProfile(
    profile,
    Date.parse(iso),
    holidaySets,
  );
}

test("maps configured one-off schedule times from the planned event", async () => {
  assert.deepEqual(
    (await dueAt("2026-07-23T21:35:00.000Z")).map((task) => task.type),
    ["usCloseSnapshot"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T00:25:00.000Z")).map((task) => task.type),
    ["premarketBrief", "newsCollect"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T07:20:00.000Z")).map((task) => task.type),
    ["cnDailySnapshot", "closeFullAnalysis"],
  );
});

test("collects every five minutes and signals every fifteen minutes in CN sessions", async () => {
  assert.deepEqual(
    (await dueAt("2026-07-23T01:30:00.000Z")).map((task) => task.type),
    ["intradayCollect", "intradaySignal", "newsCollect"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T01:35:00.000Z")).map((task) => task.type),
    ["intradayCollect"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T03:30:00.000Z")).map((task) => task.type),
    ["intradayCollect", "intradaySignal", "newsCollect"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T04:00:00.000Z")).map((task) => task.type),
    ["newsCollect"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T07:00:00.000Z")).map((task) => task.type),
    ["intradayCollect", "intradaySignal", "newsCollect"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T07:05:00.000Z")).map((task) => task.type),
    [],
  );
});

test("keeps news refreshing on weekends while skipping market-bound work", async () => {
  assert.deepEqual(
    (await dueAt("2026-07-25T01:30:00.000Z")).map((task) => task.type),
    ["newsCollect"],
  );
});

test("skips market-bound work on the applicable CN or US holiday set", async () => {
  assert.deepEqual(
    (await dueAt(
      "2026-07-23T01:30:00.000Z",
      {},
      { cn: new Set(["2026-07-23"]) },
    )).map((task) => task.type),
    ["newsCollect"],
  );
  assert.deepEqual(
    (await dueAt(
      "2026-07-23T21:35:00.000Z",
      {},
      { us: new Set(["2026-07-23"]) },
    )).map((task) => task.type),
    [],
  );
});

test("news refresh is independently configurable and uses deterministic interval slots", async () => {
  const enabled = await dueAt("2026-07-26T11:30:00.000Z");
  assert.deepEqual(
    enabled.filter(({ type }) => type === "newsCollect").map((task) => ({
      schedule: task.schedule,
      localSlot: task.localSlot,
    })),
    [{ schedule: "newsRefresh", localSlot: "2026-07-26T19:30" }],
  );

  const disabled = await dueAt("2026-07-26T11:30:00.000Z", {
    schedules: {
      ...monitorSettings().profiles[0].schedules,
      newsRefresh: { enabled: false, intervalMinutes: 15 },
    },
  });
  assert.deepEqual(disabled, []);
});

test("premarket refresh and interval overlap produce one news slot", async () => {
  const tasks = await dueAt("2026-07-23T00:30:00.000Z", {
    schedules: {
      ...monitorSettings().profiles[0].schedules,
      preMarketBrief: { enabled: true, time: "08:30" },
      newsRefresh: { enabled: true, intervalMinutes: 15 },
    },
  });
  assert.equal(
    tasks.filter(({ type }) => type === "newsCollect").length,
    1,
  );
});

test("US snapshot uses the New York trading date while keeping the profile-local trigger", async () => {
  const summerFriday = await dueAt("2026-07-24T21:35:00.000Z");
  assert.deepEqual(
    summerFriday.map((task) => task.type),
    ["usCloseSnapshot"],
    "上海周六 05:35 对应纽约周五，必须执行",
  );

  const thanksgiving = await dueAt(
    "2026-11-26T21:35:00.000Z",
    {},
    { us: new Set(["2026-11-26"]) },
  );
  assert.deepEqual(
    thanksgiving,
    [],
    "上海 11 月 27 日 05:35 对应纽约感恩节，必须跳过",
  );
});

test("US market-day conversion handles both winter and summer offsets", async () => {
  assert.deepEqual(
    (await dueAt("2026-01-09T21:35:00.000Z")).map((task) => task.type),
    ["usCloseSnapshot"],
    "冬令时下上海周六仍对应纽约周五",
  );
  assert.deepEqual(
    await dueAt("2026-01-04T21:35:00.000Z"),
    [],
    "冬令时下上海周一对应纽约周日，应跳过",
  );
  assert.deepEqual(
    await dueAt("2026-07-26T21:35:00.000Z"),
    [],
    "夏令时下上海周一对应纽约周日，应跳过",
  );
});

test("US intraday collection follows the New York session and only exists for explicit core drivers", async () => {
  const targets = [
    ...monitorSettings().profiles[0].targets,
    { symbol: "SOXX", name: "SOXX", market: "US", role: "driver", analysis: "signal" },
    { symbol: "NVDA", name: "NVDA", market: "US", role: "driver", analysis: "signal" },
  ];
  const summer = await dueAt("2026-07-28T13:30:00.000Z", { targets });
  assert.deepEqual(
    summer.filter(({ type }) => type === "usIntradayCollect").map(({ schedule }) => schedule),
    ["usIntraday/collect"],
  );
  const winter = await dueAt("2026-01-09T14:30:00.000Z", { targets });
  assert.equal(winter.filter(({ type }) => type === "usIntradayCollect").length, 1);
  const closed = await dueAt("2026-07-28T13:30:00.000Z", {
    targets,
    schedules: {
      ...monitorSettings().profiles[0].schedules,
      usCloseSnapshot: { enabled: false, time: "05:35" },
    },
  });
  assert.equal(closed.filter(({ type }) => type === "usIntradayCollect").length, 0);
  const holiday = await dueAt(
    "2026-07-28T13:30:00.000Z",
    { targets },
    { us: new Set(["2026-07-28"]) },
  );
  assert.equal(holiday.filter(({ type }) => type === "usIntradayCollect").length, 0);
});

test("uses IANA DST conversion without repeating or losing ordinary local slots", async () => {
  const profile = { timezone: "America/New_York" };
  const beforeDst = await dueAt("2026-03-06T13:25:00.000Z", profile);
  const afterDst = await dueAt("2026-03-09T12:25:00.000Z", profile);
  assert.deepEqual(
    beforeDst.filter(({ type }) => type === "premarketBrief").map((task) => task.localSlot),
    ["2026-03-06T08:25"],
  );
  assert.deepEqual(
    afterDst.filter(({ type }) => type === "premarketBrief").map((task) => task.localSlot),
    ["2026-03-09T08:25"],
  );

  const { localDateTimeAt } = await import(schedulerUrl);
  assert.equal(
    localDateTimeAt(Date.parse("2026-11-01T05:30:00.000Z"), "America/New_York").key,
    "2026-11-01T01:30",
  );
  assert.equal(
    localDateTimeAt(Date.parse("2026-11-01T06:30:00.000Z"), "America/New_York").key,
    "2026-11-01T01:30",
  );
});

test("slot ids are deterministic and contain no raw punctuation-sensitive profile data", async () => {
  const { slotIdForTask } = await import(schedulerUrl);
  const task = {
    type: "intradayCollect",
    schedule: "cnIntraday/collect",
    localSlot: "2026-07-23T09:30",
  };
  assert.equal(
    await slotIdForTask("profile / 一", task),
    await slotIdForTask("profile / 一", task),
  );
  assert.match(await slotIdForTask("profile / 一", task), /^slot-[a-f0-9]{64}$/);
});

test("a five-minute cron tick catches a configured minute inside its open-closed window", async () => {
  const tasks = await dueAt("2026-07-23T00:30:00.000Z", {
    schedules: {
      ...monitorSettings().profiles[0].schedules,
      preMarketBrief: { enabled: true, time: "08:27" },
    },
  });
  const brief = tasks.find((task) => task.type === "premarketBrief");
  assert.equal(brief.localSlot, "2026-07-23T08:27");
  assert.equal(brief.scheduledFor, "2026-07-23T00:27:00.000Z");
});

test("non-five-minute intraday intervals use their theoretical sequence", async () => {
  const schedules = monitorSettings().profiles[0].schedules;
  const profile = {
    schedules: {
      ...schedules,
      cnIntraday: {
        enabled: true,
        windows: [{ start: "09:30", end: "10:00" }],
        collectionIntervalMinutes: 7,
        signalIntervalMinutes: 14,
      },
    },
  };
  const tasks = await dueAt("2026-07-23T01:40:00.000Z", profile);
  assert.deepEqual(
    tasks.filter((task) => task.type === "intradayCollect")
      .map((task) => task.localSlot),
    ["2026-07-23T09:37"],
  );
  assert.equal(
    tasks.find((task) => task.type === "intradayCollect").scheduledFor,
    "2026-07-23T01:37:00.000Z",
  );
});

test("intervals below five minutes emit every crossed theoretical slot", async () => {
  const schedules = monitorSettings().profiles[0].schedules;
  const tasks = await dueAt("2026-07-23T01:35:00.000Z", {
    schedules: {
      ...schedules,
      cnIntraday: {
        enabled: true,
        windows: [{ start: "09:30", end: "10:00" }],
        collectionIntervalMinutes: 2,
        signalIntervalMinutes: 6,
      },
    },
  });
  assert.deepEqual(
    tasks.filter((task) => task.type === "intradayCollect")
      .map((task) => task.localSlot),
    ["2026-07-23T09:32", "2026-07-23T09:34"],
  );
});

test("recovers a missed CN close snapshot and report without replaying high-frequency work", async () => {
  const tasks = await recoveryAt("2026-07-29T20:38:00.000Z");
  assert.deepEqual(
    tasks.map(({ type, localSlot }) => ({ type, localSlot })),
    [
      {
        type: "usCloseSnapshot",
        localSlot: "2026-07-29T05:35#recovery",
      },
      {
        type: "closeFullAnalysis",
        localSlot: "2026-07-29T15:20#recovery",
      },
      {
        type: "cnDailySnapshot",
        localSlot: "2026-07-29T15:20#recovery",
      },
    ],
  );
  assert.equal(
    tasks.some(({ type }) =>
      ["intradayCollect", "intradaySignal", "newsCollect"].includes(type)),
    false,
  );
  assert.equal(
    tasks.every(({ scheduledFor }) =>
      scheduledFor !== "2026-07-29T07:20:00.000Z"),
    true,
  );
  assert.equal(new Set(
    tasks.map(({ type, scheduledFor }) => `${type}|${scheduledFor}`),
  ).size, tasks.length);
});

test("recovers the profile-local US close snapshot using the New York market date", async () => {
  const tasks = await recoveryAt("2026-07-29T22:00:00.000Z");
  assert.deepEqual(
    tasks.filter(({ type }) => type === "usCloseSnapshot")
      .map(({ localSlot }) => localSlot),
    ["2026-07-29T05:35#recovery", "2026-07-30T05:35#recovery"],
  );
});

test("recovery respects holidays and never reaches beyond the bounded lookback", async () => {
  const holiday = await recoveryAt(
    "2026-07-29T20:38:00.000Z",
    {},
    { cn: new Set(["2026-07-29"]) },
  );
  assert.equal(
    holiday.some(({ type }) =>
      ["cnDailySnapshot", "closeFullAnalysis"].includes(type)),
    false,
  );

  const disabled = await recoveryAt("2026-07-29T20:38:00.000Z", {
    schedules: {
      ...monitorSettings().profiles[0].schedules,
      closeDeepAnalysis: { enabled: false, time: "15:20" },
      usCloseSnapshot: { enabled: false, time: "05:35" },
    },
  });
  assert.deepEqual(disabled, []);
});

test("recovery still finds Friday close work early Sunday within the 36-hour bound", async () => {
  const tasks = await recoveryAt("2026-08-01T17:00:00.000Z");
  assert.deepEqual(
    tasks.filter(({ type }) =>
      ["cnDailySnapshot", "closeFullAnalysis"].includes(type))
      .map(({ type, localSlot }) => ({ type, localSlot })),
    [
      {
        type: "closeFullAnalysis",
        localSlot: "2026-07-31T15:20#recovery",
      },
      {
        type: "cnDailySnapshot",
        localSlot: "2026-07-31T15:20#recovery",
      },
    ],
  );
});
