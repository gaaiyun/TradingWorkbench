import assert from "node:assert/strict";
import test from "node:test";

import { monitorSettings } from "./helpers/monitor_settings.mjs";

const schedulerUrl = new URL(
  "../workers/monitor/src/scheduler.mjs",
  import.meta.url,
);

async function dueAt(iso, profileOverrides = {}, holidaySets = {}) {
  const { dueTasksForProfile } = await import(schedulerUrl);
  const profile = monitorSettings(profileOverrides).profiles[0];
  return dueTasksForProfile(profile, Date.parse(iso), holidaySets);
}

test("maps configured one-off schedule times from the planned event", async () => {
  assert.deepEqual(
    (await dueAt("2026-07-23T21:35:00.000Z")).map((task) => task.type),
    ["usCloseSnapshot"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T00:25:00.000Z")).map((task) => task.type),
    ["premarketBrief"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T07:20:00.000Z")).map((task) => task.type),
    ["closeFullAnalysis"],
  );
});

test("collects every five minutes and signals every fifteen minutes in CN sessions", async () => {
  assert.deepEqual(
    (await dueAt("2026-07-23T01:30:00.000Z")).map((task) => task.type),
    ["intradayCollect", "intradaySignal"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T01:35:00.000Z")).map((task) => task.type),
    ["intradayCollect"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T03:30:00.000Z")).map((task) => task.type),
    ["intradayCollect", "intradaySignal"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T04:00:00.000Z")).map((task) => task.type),
    [],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T07:00:00.000Z")).map((task) => task.type),
    ["intradayCollect", "intradaySignal"],
  );
  assert.deepEqual(
    (await dueAt("2026-07-23T07:05:00.000Z")).map((task) => task.type),
    [],
  );
});

test("skips local weekends and the applicable CN or US holiday set", async () => {
  assert.deepEqual(await dueAt("2026-07-25T01:30:00.000Z"), []);
  assert.deepEqual(
    await dueAt(
      "2026-07-23T01:30:00.000Z",
      {},
      { cn: new Set(["2026-07-23"]) },
    ),
    [],
  );
  assert.deepEqual(
    await dueAt(
      "2026-07-23T21:35:00.000Z",
      {},
      { us: new Set(["2026-07-23"]) },
    ),
    [],
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

test("uses IANA DST conversion without repeating or losing ordinary local slots", async () => {
  const profile = { timezone: "America/New_York" };
  const beforeDst = await dueAt("2026-03-06T13:25:00.000Z", profile);
  const afterDst = await dueAt("2026-03-09T12:25:00.000Z", profile);
  assert.deepEqual(beforeDst.map((task) => task.localSlot), ["2026-03-06T08:25"]);
  assert.deepEqual(afterDst.map((task) => task.localSlot), ["2026-03-09T08:25"]);

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
