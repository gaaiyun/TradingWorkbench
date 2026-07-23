import { parseWorkbenchSettings } from "../../../functions/api/_workbench_settings.mjs";
import { collectForTask } from "./collector.mjs";
import { dispatchFullAnalysis } from "./github-dispatch.mjs";
import { createProviderRegistry } from "./providers/registry.mjs";
import { writeMarketBars } from "./providers/market-bar-writer.mjs";
import {
  dueTasksForProfile,
  slotIdForTask,
  taskFromScheduledSlot,
} from "./scheduler.mjs";
import {
  claimScheduledSlot,
  finishScheduledSlot,
  listRetryableSlots,
} from "./slots.mjs";

function emptyCounts() {
  return {
    due: 0,
    claimed: 0,
    completed: 0,
    degraded: 0,
    deferred: 0,
    failed: 0,
    skipped: 0,
  };
}

function parseHolidaySet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (typeof value !== "string" || !value.trim()) return new Set();
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? new Set(parsed) : new Set();
    } catch {
      return new Set();
    }
  }
  return new Set(trimmed.split(",").map((date) => date.trim()).filter(Boolean));
}

async function readSettings(db) {
  const row = await db.prepare(`
    SELECT settings_json
    FROM workbench_settings
    WHERE id = 1
  `).bind().first();
  if (!row) return { errorCode: "WORKBENCH_SETTINGS_MISSING" };
  try {
    return { settings: parseWorkbenchSettings(JSON.parse(row.settings_json)) };
  } catch {
    return { errorCode: "WORKBENCH_SETTINGS_INVALID" };
  }
}

function deferredHook() {
  return { status: "deferred", errorCode: "HOOK_NOT_IMPLEMENTED" };
}

async function executeTask({
  task,
  profile,
  slotId,
  env,
  db,
  registry,
  deps,
  now,
}) {
  if (task.type === "premarketBrief" || task.type === "intradaySignal") {
    return deferredHook();
  }
  if (task.type === "closeFullAnalysis") {
    return dispatchFullAnalysis({
      env,
      fetcher: deps.fetcher,
      profile,
      slotId,
      scheduledFor: task.scheduledFor,
    });
  }
  return collectForTask({
    taskType: task.type,
    profile,
    registry,
    writeBars: deps.writeBars ?? writeMarketBars,
    db,
    now,
  });
}

export async function runScheduled(scheduledTime, env, deps = {}) {
  const counts = emptyCounts();
  const sources = [];
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    return {
      status: "unavailable",
      errorCode: "D1_NOT_CONFIGURED",
      counts,
      sources,
    };
  }

  let loaded;
  try {
    loaded = await readSettings(env.DB);
  } catch {
    return {
      status: "unavailable",
      errorCode: "WORKBENCH_SETTINGS_READ_FAILED",
      counts,
      sources,
    };
  }
  if (loaded.errorCode) {
    return {
      status: "unavailable",
      errorCode: loaded.errorCode,
      counts,
      sources,
    };
  }

  const holidaySets = {
    cn: parseHolidaySet(deps.cnHolidays ?? env.CN_HOLIDAY_DATES),
    us: parseHolidaySet(deps.usHolidays ?? env.US_HOLIDAY_DATES),
  };
  const due = [];
  const profilesById = new Map();
  for (const profile of loaded.settings.profiles) {
    profilesById.set(profile.id, profile);
    for (const task of dueTasksForProfile(profile, scheduledTime, holidaySets)) {
      due.push({ profile, task });
    }
  }
  const clock = deps.now ?? (() => new Date());
  const retryNow = clock();
  let retryable = [];
  try {
    const rows = await listRetryableSlots(env.DB, retryNow);
    retryable = rows.flatMap((row) => {
      const profile = profilesById.get(row.profile_id);
      const task = profile ? taskFromScheduledSlot(profile, row) : null;
      return profile && task ? [{ profile, task, slotId: row.id }] : [];
    });
  } catch {
    counts.failed += 1;
  }
  const work = [...retryable, ...due];
  counts.due = work.length;
  const registryFactory = deps.registryFactory ?? ((options) =>
    createProviderRegistry(options));
  const registry = registryFactory({ db: env.DB, env, now: clock });

  for (const { profile, task, slotId: retrySlotId } of work) {
    const slotId = retrySlotId ?? await slotIdForTask(profile.id, task);
    const claimNow = clock();
    let claim;
    try {
      claim = await claimScheduledSlot(env.DB, {
        id: slotId,
        profileId: profile.id,
        slotType: task.type,
        scheduledFor: task.scheduledFor,
        now: claimNow,
      });
    } catch {
      counts.failed += 1;
      continue;
    }
    if (!claim) {
      counts.skipped += 1;
      continue;
    }
    counts.claimed += 1;

    let result;
    try {
      result = await executeTask({
        task,
        profile,
        slotId,
        env,
        db: env.DB,
        registry,
        deps,
        now: claimNow,
      });
    } catch {
      result = { status: "failed", errorCode: "TASK_EXECUTION_FAILED" };
    }
    if (Array.isArray(result.sources)) sources.push(...result.sources);
    const terminalStatus = result.status === "deferred"
      ? "deferred"
      : result.status === "failed" || result.status === "degraded"
        ? "failed"
        : "completed";
    try {
      const finishResult = await finishScheduledSlot(env.DB, {
        id: slotId,
        attemptCount: claim.attemptCount,
        status: terminalStatus,
        errorCode: result.errorCode,
        now: clock(),
      });
      if (finishResult.changed === 0) {
        counts.skipped += 1;
      } else {
        counts[result.status === "degraded" ? "degraded" : terminalStatus] += 1;
      }
    } catch {
      counts.failed += 1;
    }
  }

  return {
    status: counts.failed > 0 || counts.degraded > 0 ? "degraded" : "completed",
    counts,
    sources,
  };
}

const worker = {
  scheduled(event, env, ctx) {
    const run = runScheduled(event.scheduledTime, env).then((summary) => {
      console.log(JSON.stringify({ event: "monitor_run", ...summary }));
      return summary;
    });
    ctx.waitUntil(run);
  },

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({ ok: true, service: "monitor-worker" });
  },
};

export default worker;
