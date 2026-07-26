import assert from "node:assert/strict";
import test from "node:test";

import {
  notificationDecision,
  notificationPoliciesForEvent,
} from "../workers/monitor/src/notifications.mjs";
import { monitorSettings } from "./helpers/monitor_settings.mjs";

function profile(overrides = {}) {
  const base = monitorSettings().profiles[0];
  const { alerts: alertOverrides = {}, ...profileOverrides } = overrides;
  return {
    ...base,
    ...profileOverrides,
    alerts: {
      ...base.alerts,
      channels: { web: true, pushPlus: true },
      pushMinSeverity: "high",
      quietHours: { start: "22:30", end: "07:30" },
      ...alertOverrides,
    },
  };
}

const highEvent = {
  id: "event-high",
  profileId: "etf-main",
  importance: "high",
  eventAt: "2026-07-24T02:00:00.000Z",
  title: "价格异动",
};

test("web delivery means the persisted event is visible, not a browser system notification", () => {
  assert.deepEqual(
    notificationDecision({
      profile: profile(),
      event: highEvent,
      channel: "web",
      mode: "shadow",
      hasPushPlusToken: false,
      now: new Date("2026-07-24T02:00:10.000Z"),
    }),
    {
      status: "sent",
      reasonCode: "WEB_EVENT_PERSISTED",
      nextAttemptAt: null,
      sentAt: "2026-07-24T02:00:10.000Z",
      quiet: false,
      eligible: true,
    },
  );
});

test("policy applies channels, severity, missing token, and shadow without exposing a token", () => {
  const now = new Date("2026-07-24T02:00:10.000Z");
  const disabled = notificationDecision({
    profile: profile({ alerts: { channels: { web: true, pushPlus: false } } }),
    event: highEvent,
    channel: "pushPlus",
    mode: "live",
    hasPushPlusToken: true,
    now,
  });
  assert.equal(disabled.status, "skipped");
  assert.equal(disabled.reasonCode, "CHANNEL_DISABLED");

  const belowThreshold = notificationDecision({
    profile: profile(),
    event: { ...highEvent, importance: "medium" },
    channel: "pushPlus",
    mode: "live",
    hasPushPlusToken: true,
    now,
  });
  assert.equal(belowThreshold.reasonCode, "SEVERITY_BELOW_THRESHOLD");

  const missingToken = notificationDecision({
    profile: profile(),
    event: highEvent,
    channel: "pushPlus",
    mode: "live",
    hasPushPlusToken: false,
    now,
  });
  assert.equal(missingToken.reasonCode, "PUSHPLUS_TOKEN_MISSING");

  const shadow = notificationPoliciesForEvent({
    profile: profile(),
    event: highEvent,
    mode: "shadow",
    hasPushPlusToken: true,
    now,
  });
  assert.equal(shadow.find(({ channel }) => channel === "pushPlus").status, "skipped");
  assert.equal(
    shadow.find(({ channel }) => channel === "pushPlus").reasonCode,
    "SHADOW_MODE",
  );
  assert.doesNotMatch(JSON.stringify(shadow), /token/i);
});

test("overnight quiet hours defer high severity while critical bypasses quiet", () => {
  const now = new Date("2026-07-24T15:00:00.000Z"); // 23:00 Asia/Shanghai
  const deferred = notificationDecision({
    profile: profile(),
    event: highEvent,
    channel: "pushPlus",
    mode: "live",
    hasPushPlusToken: true,
    now,
  });
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.reasonCode, "QUIET_HOURS");
  assert.equal(deferred.nextAttemptAt, "2026-07-24T23:30:00.000Z");

  const critical = notificationDecision({
    profile: profile(),
    event: { ...highEvent, importance: "critical" },
    channel: "pushPlus",
    mode: "live",
    hasPushPlusToken: true,
    now,
  });
  assert.equal(critical.status, "pending");
  assert.equal(critical.reasonCode, "READY");
  assert.equal(critical.nextAttemptAt, now.toISOString());
});

test("quiet-hour release respects profile timezone DST transitions", () => {
  const decision = notificationDecision({
    profile: profile({
      timezone: "America/New_York",
      alerts: {
        quietHours: { start: "22:00", end: "07:00" },
      },
    }),
    event: highEvent,
    channel: "pushPlus",
    mode: "live",
    hasPushPlusToken: true,
    now: new Date("2026-03-08T06:30:00.000Z"), // 01:30 EST, DST starts at 02:00
  });
  assert.equal(decision.status, "deferred");
  assert.equal(decision.nextAttemptAt, "2026-03-08T11:00:00.000Z"); // 07:00 EDT
});

test("nonexistent DST quiet end advances to the next real local minute", () => {
  const now = new Date("2026-03-08T06:30:00.000Z"); // 01:30 EST
  const decision = notificationDecision({
    profile: profile({
      timezone: "America/New_York",
      alerts: {
        quietHours: { start: "22:00", end: "02:30" },
      },
    }),
    event: highEvent,
    channel: "pushPlus",
    mode: "live",
    hasPushPlusToken: true,
    now,
  });

  assert.equal(decision.status, "deferred");
  assert.equal(decision.nextAttemptAt, "2026-03-08T07:00:00.000Z"); // 03:00 EDT
  assert.equal(Date.parse(decision.nextAttemptAt) > now.valueOf(), true);
});

test("ambiguous DST quiet end chooses the first matching instant after now", () => {
  const alerts = { quietHours: { start: "22:00", end: "01:30" } };
  const first = notificationDecision({
    profile: profile({ timezone: "America/New_York", alerts }),
    event: highEvent,
    channel: "pushPlus",
    mode: "live",
    hasPushPlusToken: true,
    now: new Date("2026-11-01T05:15:00.000Z"), // first 01:15 EDT
  });
  const second = notificationDecision({
    profile: profile({ timezone: "America/New_York", alerts }),
    event: highEvent,
    channel: "pushPlus",
    mode: "live",
    hasPushPlusToken: true,
    now: new Date("2026-11-01T06:15:00.000Z"), // second 01:15 EST
  });

  assert.equal(first.nextAttemptAt, "2026-11-01T05:30:00.000Z");
  assert.equal(second.nextAttemptAt, "2026-11-01T06:30:00.000Z");
});
