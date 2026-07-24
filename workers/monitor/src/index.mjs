import { parseWorkbenchSettings } from "../../../functions/api/_workbench_settings.mjs";
import { collectForTask } from "./collector.mjs";
import { dispatchFullAnalysis } from "./github-dispatch.mjs";
import {
  collectNewsForProfile,
  writeNewsItems,
} from "./news-collector.mjs";
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
import { evaluateIntradaySignals } from "./signals.mjs";

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

async function needsMarketBootstrap(db) {
  try {
    const row = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM market_bars
    `).bind().first();
    return Number(row?.count ?? 0) === 0;
  } catch {
    return false;
  }
}

function bootstrapTasks(profile, scheduledTime) {
  if (!profile.enabled) return [];
  const scheduledFor = new Date(scheduledTime).toISOString();
  return [
    {
      type: "intradayCollect",
      schedule: "bootstrap/cn-market",
      localSlot: "bootstrap-v1-cn-market",
      scheduledFor,
    },
    {
      type: "cnDailySnapshot",
      schedule: "bootstrap/cn-daily",
      localSlot: "bootstrap-v1-cn-daily",
      scheduledFor,
    },
    {
      type: "usCloseSnapshot",
      schedule: "bootstrap/us-market",
      localSlot: "bootstrap-v1-us-market",
      scheduledFor,
    },
    {
      type: "newsCollect",
      schedule: "bootstrap/news",
      localSlot: "bootstrap-v1-news",
      scheduledFor,
    },
  ];
}

function deferredHook() {
  return { status: "deferred", errorCode: "HOOK_NOT_IMPLEMENTED" };
}

const MANUAL_COLLECTION_TASKS = new Set([
  "usCloseSnapshot",
  "cnDailySnapshot",
  "intradayCollect",
  "newsCollect",
]);

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
  if (task.type === "newsCollect") {
    const collectNews = deps.collectNews ?? collectNewsForProfile;
    return collectNews({
      profile,
      db,
      fetcher: deps.newsFetcher ?? globalThis.fetch,
      writeItems: deps.writeNews ?? writeNewsItems,
      now,
    });
  }
  if (task.type === "premarketBrief") {
    return deferredHook();
  }
  if (task.type === "intradaySignal") {
    return evaluateIntradaySignals({
      db,
      profile,
      scheduledFor: task.scheduledFor,
      now,
    });
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
  const bootstrap = await needsMarketBootstrap(env.DB);
  for (const profile of loaded.settings.profiles) {
    profilesById.set(profile.id, profile);
    for (const task of dueTasksForProfile(profile, scheduledTime, holidaySets)) {
      due.push({ profile, task });
    }
    if (bootstrap) {
      for (const task of bootstrapTasks(profile, scheduledTime)) {
        due.push({ profile, task });
      }
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

export async function runManualCollection(taskType, env, deps = {}) {
  if (!MANUAL_COLLECTION_TASKS.has(taskType)) {
    return { status: "unavailable", errorCode: "INVALID_COLLECTION_TASK" };
  }
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    return { status: "unavailable", errorCode: "D1_NOT_CONFIGURED" };
  }
  let loaded;
  try {
    loaded = await readSettings(env.DB);
  } catch {
    return { status: "unavailable", errorCode: "WORKBENCH_SETTINGS_READ_FAILED" };
  }
  if (loaded.errorCode) return { status: "unavailable", errorCode: loaded.errorCode };

  const clock = deps.now ?? (() => new Date());
  const registryFactory = deps.registryFactory ?? ((options) =>
    createProviderRegistry(options));
  const registry = registryFactory({
    db: env.DB,
    env,
    now: clock,
    ignoreCircuitBreaker: true,
  });
  const totals = { targets: 0, succeeded: 0, failed: 0 };
  let written = 0;
  const sources = [];
  for (const profile of loaded.settings.profiles.filter(({ enabled }) => enabled)) {
    const result = taskType === "newsCollect"
      ? await (deps.collectNews ?? collectNewsForProfile)({
        profile,
        db: env.DB,
        fetcher: deps.newsFetcher ?? globalThis.fetch,
        writeItems: deps.writeNews ?? writeNewsItems,
        now: clock(),
      })
      : await collectForTask({
        taskType,
        profile,
        registry,
        writeBars: deps.writeBars ?? writeMarketBars,
        db: env.DB,
        now: clock(),
      });
    written += Number(result.written || 0);
    totals.targets += Number(result.counts?.targets ?? result.counts?.queries ?? 0);
    totals.succeeded += Number(result.counts?.succeeded || 0);
    totals.failed += Number(result.counts?.failed || 0);
    if (Array.isArray(result.sources)) sources.push(...result.sources);
  }
  const status = totals.succeeded === 0
    ? "failed"
    : totals.failed > 0 ? "degraded" : "completed";
  return {
    status,
    ...(status === "failed" ? { errorCode: "COLLECTION_UNAVAILABLE" } : {}),
    counts: totals,
    written,
    sources,
  };
}

export async function handleFetch(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({ ok: true, service: "monitor-worker" });
  }
  if (url.pathname !== "/run-collection" || request.method !== "POST") {
    return new Response("Not found", { status: 404 });
  }
  const configuredToken = String(env?.MONITOR_RUN_TOKEN || "");
  if (!configuredToken) {
    return Response.json(
      { status: "unavailable", errorCode: "MANUAL_RUN_NOT_CONFIGURED" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${configuredToken}`) {
    return Response.json(
      { status: "unavailable", errorCode: "UNAUTHORIZED" },
      { status: 401 },
    );
  }
  const result = await runManualCollection(url.searchParams.get("task"), env, deps);
  return Response.json(result, {
    status: ["completed", "degraded"].includes(result.status) ? 200 : 503,
  });
}

const worker = {
  scheduled(event, env, ctx) {
    const run = runScheduled(event.scheduledTime, env).then((summary) => {
      console.log(JSON.stringify({ event: "monitor_run", ...summary }));
      return summary;
    });
    ctx.waitUntil(run);
  },

  fetch(request, env) {
    return handleFetch(request, env);
  },
};

export default worker;
