const SEVERITY_RANK = new Map([
  ["low", 0],
  ["medium", 1],
  ["high", 2],
  ["critical", 3],
]);

const LOCAL_FORMATTERS = new Map();

function formatter(timeZone) {
  if (!LOCAL_FORMATTERS.has(timeZone)) {
    LOCAL_FORMATTERS.set(timeZone, new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }));
  }
  return LOCAL_FORMATTERS.get(timeZone);
}

function localParts(value, timeZone) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(value)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }) => [type, Number(part)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function clockMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function offsetMillisecondsAt(value, timeZone) {
  const parts = localParts(value, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - Math.floor(value.valueOf() / 1000) * 1000;
}

function localTimeToUtc(parts, timeZone) {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
  );
  let candidate = localAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = localAsUtc - offsetMillisecondsAt(new Date(candidate), timeZone);
    if (next === candidate) break;
    candidate = next;
  }
  return new Date(candidate);
}

function quietState(profile, now) {
  const timeZone = profile.timezone || "Asia/Shanghai";
  const quietHours = profile.alerts.quietHours;
  const start = clockMinutes(quietHours.start);
  const end = clockMinutes(quietHours.end);
  if (start === null || end === null || start === end) {
    return { quiet: false, nextAttemptAt: null };
  }
  const local = localParts(now, timeZone);
  const value = local.hour * 60 + local.minute;
  const overnight = start > end;
  const quiet = overnight
    ? value >= start || value < end
    : value >= start && value < end;
  if (!quiet) return { quiet: false, nextAttemptAt: null };
  const targetDate = addLocalDays(local, overnight && value >= start ? 1 : 0);
  const release = localTimeToUtc({
    ...targetDate,
    hour: Math.floor(end / 60),
    minute: end % 60,
  }, timeZone);
  return { quiet: true, nextAttemptAt: release.toISOString() };
}

export function notificationDecision({
  profile,
  event,
  channel,
  mode = "shadow",
  hasPushPlusToken = false,
  now = new Date(),
}) {
  const channels = profile.alerts.channels;
  if (channels[channel] !== true) {
    return {
      status: "skipped",
      reasonCode: "CHANNEL_DISABLED",
      nextAttemptAt: null,
      sentAt: null,
      quiet: false,
      eligible: false,
    };
  }
  const severity = SEVERITY_RANK.get(event.importance) ?? -1;
  const minimum = SEVERITY_RANK.get(profile.alerts.pushMinSeverity) ?? 2;
  if (severity < minimum) {
    return {
      status: "skipped",
      reasonCode: "SEVERITY_BELOW_THRESHOLD",
      nextAttemptAt: null,
      sentAt: null,
      quiet: false,
      eligible: false,
    };
  }
  if (channel === "web") {
    return {
      status: "sent",
      reasonCode: "WEB_EVENT_PERSISTED",
      nextAttemptAt: null,
      sentAt: now.toISOString(),
      quiet: false,
      eligible: true,
    };
  }
  if (mode !== "live") {
    return {
      status: "skipped",
      reasonCode: "SHADOW_MODE",
      nextAttemptAt: null,
      sentAt: null,
      quiet: false,
      eligible: true,
    };
  }
  if (!hasPushPlusToken) {
    return {
      status: "skipped",
      reasonCode: "PUSHPLUS_TOKEN_MISSING",
      nextAttemptAt: null,
      sentAt: null,
      quiet: false,
      eligible: false,
    };
  }
  const quiet = quietState(profile, now);
  if (quiet.quiet && event.importance !== "critical") {
    return {
      status: "deferred",
      reasonCode: "QUIET_HOURS",
      nextAttemptAt: quiet.nextAttemptAt,
      sentAt: null,
      quiet: true,
      eligible: true,
    };
  }
  return {
    status: "pending",
    reasonCode: "READY",
    nextAttemptAt: now.toISOString(),
    sentAt: null,
    quiet: quiet.quiet,
    eligible: true,
  };
}

export function notificationPoliciesForEvent({
  profile,
  event,
  mode = "shadow",
  hasPushPlusToken = false,
  now = new Date(),
}) {
  return ["web", "pushPlus"].map((channel) => {
    const decision = notificationDecision({
      profile,
      event,
      channel,
      mode,
      hasPushPlusToken,
      now,
    });
    const policySnapshotJson = JSON.stringify({
      version: 1,
      mode: mode === "live" ? "live" : "shadow",
      channel,
      profileId: profile.id,
      timezone: profile.timezone,
      minimumSeverity: profile.alerts.pushMinSeverity,
      quietHours: profile.alerts.quietHours,
      event: {
        id: event.id,
        importance: event.importance,
        eventAt: event.eventAt,
      },
      evaluatedAt: now.toISOString(),
      decision: {
        status: decision.status,
        reasonCode: decision.reasonCode,
        quiet: decision.quiet,
        eligible: decision.eligible,
        nextAttemptAt: decision.nextAttemptAt,
      },
    });
    return { channel, ...decision, policySnapshotJson };
  });
}
