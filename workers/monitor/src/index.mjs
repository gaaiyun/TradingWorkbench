import { parseWorkbenchSettings } from "../../../functions/api/_workbench_settings.mjs";
import { collectForTask } from "./collector.mjs";
import { dispatchFullAnalysis } from "./github-dispatch.mjs";
import {
  ACTIVE_NEWS_PROVIDERS,
  collectNewsForProfile,
  writeNewsItems,
} from "./news-collector.mjs";
import { createProviderRegistry } from "./providers/registry.mjs";
import { writeMarketBars } from "./providers/market-bar-writer.mjs";
import {
  bootstrapRequirementsForProfile,
  dueTasksForProfile,
  estimateTaskExternalRequests,
  localDateTimeAt,
  MAX_SCHEDULED_EXTERNAL_REQUESTS,
  profileRevisionForProfile,
  scheduledPayloadForTask,
  selectFairWorkWithinBudget,
  splitTaskWithinRequestLimit,
  slotIdForTask,
  taskFromScheduledSlot,
} from "./scheduler.mjs";
import {
  cancelStaleScheduledSlots,
  claimScheduledSlot,
  countScheduledBacklog,
  finishScheduledSlot,
  listRetryableSlots,
  markScheduledSlotsQueued,
  reserveFullAnalysisBudget,
  stageScheduledSlots,
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
    const settings = parseWorkbenchSettings(JSON.parse(row.settings_json));
    return {
      settings,
      revisions: new Map(await Promise.all(
        settings.profiles.map(async (profile) => [
          profile.id,
          await profileRevisionForProfile(profile),
        ]),
      )),
    };
  } catch {
    return { errorCode: "WORKBENCH_SETTINGS_INVALID" };
  }
}

function bootstrapIdentity(row) {
  return [
    "bootstrap",
    row.profile_id,
    row.symbol,
    row.timeframe,
    row.schema_version,
    row.target_hash,
  ].join(":");
}

async function readBootstrapIdentities(db) {
  const result = await db.prepare(`
    SELECT profile_id, symbol, timeframe, schema_version, target_hash
    FROM monitor_bootstrap_targets
  `).bind().all();
  return new Set((result?.results ?? []).map(bootstrapIdentity));
}

async function shortHash(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function bootstrapTasks(profile, scheduledTime, completedIdentities) {
  const requirements = await bootstrapRequirementsForProfile(
    profile,
    completedIdentities,
  );
  const grouped = new Map();
  for (const requirement of requirements) {
    if (!grouped.has(requirement.taskType)) {
      grouped.set(requirement.taskType, []);
    }
    grouped.get(requirement.taskType).push(requirement);
  }
  const scheduledFor = new Date(scheduledTime).toISOString();
  const tasks = [];
  for (const [type, group] of grouped) {
    const baseTask = {
      type,
      schedule: `bootstrap/${type}`,
      localSlot: `bootstrap-v2-${type}`,
      scheduledFor,
      targetSymbols: [...new Set(group.map(({ symbol }) => symbol))],
      bootstrapRequirements: group,
    };
    for (const shard of splitTaskWithinRequestLimit(
      profile,
      baseTask,
      MAX_SCHEDULED_EXTERNAL_REQUESTS,
    )) {
      const hash = await shortHash(
        shard.bootstrapRequirements
          .map(({ identity }) => identity)
          .sort()
          .join("\n"),
      );
      tasks.push({
        ...shard,
        localSlot: `bootstrap-v2-${type}-${hash}`,
      });
    }
  }
  return tasks;
}

async function recordBootstrapRequirements(db, requirements, now) {
  if (!Array.isArray(requirements) || requirements.length === 0) return;
  const timestamp = now.toISOString();
  const statements = requirements.map((requirement) =>
    db.prepare(`
      INSERT INTO monitor_bootstrap_targets (
        profile_id, symbol, timeframe, schema_version, target_hash, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).bind(
      requirement.profileId,
      requirement.symbol,
      requirement.timeframe,
      requirement.schemaVersion,
      requirement.targetHash,
      timestamp,
    ));
  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

async function readRotation(db) {
  const row = await db.prepare(`
    SELECT rotation
    FROM monitor_scheduler_state
    WHERE id = 1
  `).bind().first();
  return Number(row?.rotation ?? 0);
}

async function writeRotation(db, rotation, now) {
  await db.prepare(`
    INSERT INTO monitor_scheduler_state (id, rotation, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      rotation = excluded.rotation,
      updated_at = excluded.updated_at
  `).bind(rotation, now.toISOString()).run();
}

function deferredHook() {
  return { status: "deferred", errorCode: "HOOK_NOT_IMPLEMENTED" };
}

const MANUAL_COLLECTION_TASKS = new Set([
  "usCloseSnapshot",
  "usIntradayCollect",
  "cnDailySnapshot",
  "intradayCollect",
  "newsCollect",
]);

// Keep /health bounded, but allow a cold D1 read to complete. A cold read gets
// one retry, while binding/query failures remain single-shot so probes cannot
// amplify a persistent D1 failure.
const HEALTH_QUERY_TIMEOUT_MS = 1500;
const HEALTH_QUERY_TIMEOUT_MAX_MS = 3000;
const HEALTH_PROVIDER_LIMIT = 32;
const DIRECT_EXTERNAL_REQUEST_LIMIT = 32;
const QUEUE_DISCOVERY_LIMIT = 10;
const QUEUE_CONSUMER_BATCH_LIMIT = 1;
const BOOTSTRAP_PROFILES_PER_TICK = 1;
const MANUAL_COLLECTION_TASK_LIMIT = 32;

function stableNewsErrorCode(reason) {
  const code = String(reason || "");
  return /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
    ? code
    : "NEWS_PROVIDER_FAILED";
}

function newsProviderOutcomes(sources) {
  const outcomes = new Map();
  for (const entry of Array.isArray(sources) ? sources : []) {
    const source = String(entry?.source || "");
    if (
      !/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(source) ||
      !["success", "failed"].includes(entry?.status)
    ) continue;
    const outcome = outcomes.get(source) ?? {
      source,
      succeeded: false,
      failed: false,
      errorCode: null,
    };
    if (entry.status === "success") {
      outcome.succeeded = true;
    } else {
      outcome.failed = true;
      outcome.errorCode = stableNewsErrorCode(entry.reason);
    }
    outcomes.set(source, outcome);
  }
  return [...outcomes.values()];
}

async function recordNewsProviderHealth(db, sources, now) {
  if (!db?.prepare) return;
  const timestamp = now.toISOString();
  const statements = newsProviderOutcomes(sources).map((outcome) => {
    const status = outcome.succeeded
      ? outcome.failed ? "degraded" : "ok"
      : "unavailable";
    return db.prepare(`
      INSERT INTO monitor_news_provider_health (
        source, status, last_success_at, last_failure_at, last_error_code,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        status = excluded.status,
        last_success_at = COALESCE(
          excluded.last_success_at,
          monitor_news_provider_health.last_success_at
        ),
        last_failure_at = COALESCE(
          excluded.last_failure_at,
          monitor_news_provider_health.last_failure_at
        ),
        last_error_code = excluded.last_error_code,
        updated_at = excluded.updated_at
    `).bind(
      outcome.source,
      status,
      outcome.succeeded ? timestamp : null,
      outcome.failed ? timestamp : null,
      outcome.failed ? outcome.errorCode : null,
      timestamp,
    );
  });
  if (statements.length === 0) return;
  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

async function collectNewsWithHealth({
  collectNews,
  profile,
  db,
  env,
  fetcher,
  writeItems,
  now,
}) {
  let result;
  try {
    result = await collectNews({
      profile,
      db,
      env,
      fetcher,
      writeItems,
      now,
    });
  } catch (error) {
    await recordNewsProviderHealth(db, [{
      source: "news-collector",
      status: "failed",
      reason: "NEWS_COLLECTION_ERROR",
    }], now).catch(() => {});
    throw error;
  }
  await recordNewsProviderHealth(db, result?.sources, now).catch(() => {});
  return result;
}

function unavailableNewsProviders(reason) {
  return { status: "unavailable", reason, providers: [] };
}

function deploymentIdentity(env) {
  const commitSha = String(env?.WORKER_COMMIT_SHA || "").trim();
  const deployedAt = String(env?.WORKER_DEPLOYED_AT || "").trim();
  return {
    commitSha: /^[0-9a-f]{7,64}$/i.test(commitSha) ? commitSha : "unknown",
    deployedAt: (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(deployedAt) &&
        Number.isFinite(Date.parse(deployedAt))
      )
      ? deployedAt
      : "unknown",
  };
}

async function readNewsProviderHealth(db, configuredTimeoutMs = HEALTH_QUERY_TIMEOUT_MS) {
  if (!db?.prepare) return unavailableNewsProviders("no_binding");
  const timedOut = Symbol("health-query-timeout");
  const timeoutMs = Math.min(
    HEALTH_QUERY_TIMEOUT_MAX_MS,
    Math.max(10, Number(configuredTimeoutMs) || HEALTH_QUERY_TIMEOUT_MS),
  );

  async function queryOnce() {
    let timer;
    try {
      const query = db.prepare(`
      SELECT source, status, last_success_at, last_failure_at, last_error_code
      FROM monitor_news_provider_health
      WHERE source IN (${ACTIVE_NEWS_PROVIDERS.map(() => "?").join(", ")})
      ORDER BY source ASC
      LIMIT ?
      `).bind(...ACTIVE_NEWS_PROVIDERS, HEALTH_PROVIDER_LIMIT).all();
      return await Promise.race([
        query,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    let result = await queryOnce();
    if (result === timedOut) result = await queryOnce();
    if (result === timedOut) return unavailableNewsProviders("query_timeout");
    const providers = (result?.results ?? []).map((row) => ({
      source: row.source,
      status: row.status,
      lastSuccessAt: row.last_success_at ?? null,
      lastFailureAt: row.last_failure_at ?? null,
      lastErrorCode: row.last_error_code ?? null,
    }));
    if (providers.length === 0) return unavailableNewsProviders("empty_table");
    const unavailable = providers.filter(
      ({ status }) => status === "unavailable",
    ).length;
    const degraded = providers.some(({ status }) => status === "degraded");
    return {
      status: unavailable === providers.length
        ? "unavailable"
        : unavailable > 0 || degraded ? "degraded" : "ok",
      reason: null,
      providers,
    };
  } catch {
    return unavailableNewsProviders("query_error");
  }
}

async function executeTask({
  task,
  profile,
  slotId,
  payloadHash,
  localDate,
  env,
  db,
  registry,
  deps,
  now,
}) {
  if (task.type === "newsCollect") {
    const collectNews = deps.collectNews ?? collectNewsForProfile;
    return collectNewsWithHealth({
      collectNews,
      profile,
      db,
      env,
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
    const reservation = await reserveFullAnalysisBudget(db, {
      slotId,
      profileId: profile.id,
      localDate,
      limit: profile.agentBudget.fullAnalysesPerDay,
      now,
    });
    if (!reservation.reserved) {
      return {
        status: "deferred",
        errorCode: "FULL_ANALYSIS_DAILY_LIMIT",
        budget: "denied",
      };
    }
    return dispatchFullAnalysis({
      env,
      db,
      fetcher: deps.fetcher,
      profile,
      slotId,
      payloadHash,
      scheduledFor: task.scheduledFor,
      now,
    });
  }
  const result = await collectForTask({
    taskType: task.type,
    task,
    profile,
    registry,
    writeBars: deps.writeBars ?? writeMarketBars,
    db,
    now,
  });
  if (result.status === "completed" && task.bootstrapRequirements?.length) {
    try {
      await recordBootstrapRequirements(
        db,
        task.bootstrapRequirements,
        now,
      );
    } catch {
      return {
        ...result,
        status: "failed",
        errorCode: "BOOTSTRAP_RECEIPT_WRITE_FAILED",
      };
    }
  }
  return result;
}

function emptyBudget() {
  return { fullReserved: 0, fullDenied: 0, lightConsumed: 0 };
}

function profileRevisionMap(loaded) {
  return new Map(loaded.settings.profiles.map((profile) => [
    profile.id,
    { enabled: profile.enabled, revision: loaded.revisions.get(profile.id) },
  ]));
}

async function stageDiscoveredSlots({
  scheduledTime,
  env,
  deps,
  loaded,
  now,
  bootstrapRotation,
}) {
  const holidaySets = {
    cn: parseHolidaySet(deps.cnHolidays ?? env.CN_HOLIDAY_DATES),
    us: parseHolidaySet(deps.usHolidays ?? env.US_HOLIDAY_DATES),
  };
  const completedBootstrap = await readBootstrapIdentities(env.DB);
  const enabledProfiles = loaded.settings.profiles.filter(({ enabled }) => enabled);
  const bootstrapProfileIds = new Set(
    enabledProfiles.length === 0
      ? []
      : Array.from(
          { length: Math.min(BOOTSTRAP_PROFILES_PER_TICK, enabledProfiles.length) },
          (_, offset) =>
            enabledProfiles[
              (Math.abs(Number(bootstrapRotation || 0)) + offset) %
                enabledProfiles.length
            ].id,
        ),
  );
  const discovered = [];
  for (const profile of loaded.settings.profiles) {
    const rawTasks = [
      ...dueTasksForProfile(profile, scheduledTime, holidaySets),
      ...(bootstrapProfileIds.has(profile.id)
        ? await bootstrapTasks(profile, scheduledTime, completedBootstrap)
        : []),
    ];
    const tasks = rawTasks.flatMap((task) =>
      splitTaskWithinRequestLimit(
        profile,
        task,
        MAX_SCHEDULED_EXTERNAL_REQUESTS,
      ));
    for (const task of tasks) {
      const id = await slotIdForTask(profile.id, task);
      const snapshot = await scheduledPayloadForTask(
        profile,
        task,
        loaded.revisions.get(profile.id),
      );
      const localDate = task.localSlot.startsWith("bootstrap-")
        ? localDateTimeAt(
            Date.parse(task.scheduledFor),
            profile.timezone || "Asia/Shanghai",
          ).date
        : task.localSlot.slice(0, 10);
      discovered.push({
        id,
        profileId: profile.id,
        slotType: task.type,
        scheduledFor: task.scheduledFor,
        localDate,
        ...snapshot,
        now,
      });
    }
  }
  await stageScheduledSlots(env.DB, discovered);
  return discovered.length;
}

function workFromRows(rows) {
  return rows.flatMap((row) => {
    const snapshot = taskFromScheduledSlot(row);
    return snapshot
      ? [{
          id: row.id,
          profile: snapshot.profile,
          task: snapshot.task,
          profileRevision: snapshot.profileRevision,
          payloadHash: snapshot.payloadHash,
          localDate: row.local_date,
        }]
      : [];
  });
}

async function executeWorkItems(
  work,
  env,
  deps,
  summary,
  { maxExternalRequests = MAX_SCHEDULED_EXTERNAL_REQUESTS } = {},
) {
  const clock = deps.now ?? (() => new Date());
  const registryFactory = deps.registryFactory ?? ((options) =>
    createProviderRegistry(options));
  const registry = registryFactory({ db: env.DB, env, now: clock });
  for (const item of work) {
    const claimNow = clock();
    let claim;
    try {
      claim = await claimScheduledSlot(env.DB, {
        id: item.id,
        payloadHash: item.payloadHash,
        now: claimNow,
      });
    } catch {
      summary.counts.failed += 1;
      continue;
    }
    if (!claim) {
      summary.counts.skipped += 1;
      continue;
    }
    summary.counts.claimed += 1;

    let result;
    const estimatedRequests = estimateTaskExternalRequests(
      claim.profile,
      claim.task,
    );
    if (estimatedRequests > maxExternalRequests) {
      summary.oversized += 1;
      result = {
        status: "deferred",
        errorCode: "TASK_EXTERNAL_REQUEST_LIMIT",
      };
    } else {
      try {
        result = await (deps.executeTask ?? executeTask)({
          task: claim.task,
          profile: claim.profile,
          slotId: claim.id,
          payloadHash: claim.payloadHash,
          localDate: claim.localDate,
          env,
          db: env.DB,
          registry,
          deps,
          now: claimNow,
        });
      } catch {
        result = { status: "failed", errorCode: "TASK_EXECUTION_FAILED" };
      }
    }
    if (result.budget === "denied") summary.budget.fullDenied += 1;
    if (
      claim.task.type === "closeFullAnalysis" &&
      result.budget !== "denied"
    ) {
      summary.budget.fullReserved += 1;
    }
    if (Array.isArray(result.sources)) summary.sources.push(...result.sources);
    const terminalStatus = result.status === "deferred"
      ? "deferred"
      : result.status === "failed" || result.status === "degraded"
        ? "failed"
        : "completed";
    try {
      const finishResult = await finishScheduledSlot(env.DB, {
        id: claim.id,
        attemptCount: claim.attemptCount,
        status: terminalStatus,
        errorCode: result.errorCode,
        now: clock(),
      });
      if (finishResult.changed === 0) {
        summary.counts.skipped += 1;
      } else {
        summary.counts[
          result.status === "degraded" ? "degraded" : terminalStatus
        ] += 1;
      }
    } catch {
      summary.counts.failed += 1;
    }
  }
}

function successfulSummary(mode) {
  return {
    status: "completed",
    mode,
    counts: emptyCounts(),
    sources: [],
    budget: emptyBudget(),
    externalRequestBudget: 40,
    estimatedExternalRequests: 0,
    backlog: 0,
    capped: 0,
    oversized: 0,
  };
}

function configuredDirectBudget(value) {
  if (value == null || value === "") return DIRECT_EXTERNAL_REQUEST_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DIRECT_EXTERNAL_REQUEST_LIMIT;
  return Math.min(
    DIRECT_EXTERNAL_REQUEST_LIMIT,
    Math.max(0, Math.floor(parsed)),
  );
}

function configuredQueueDiscoveryLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return QUEUE_DISCOVERY_LIMIT;
  return Math.min(
    QUEUE_DISCOVERY_LIMIT,
    Math.max(1, Math.floor(parsed)),
  );
}

function configuredManualCursor(value, total) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(total, Math.max(0, Math.floor(parsed)));
}

function configuredManualLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MANUAL_COLLECTION_TASK_LIMIT;
  return Math.min(
    MANUAL_COLLECTION_TASK_LIMIT,
    Math.max(1, Math.floor(parsed)),
  );
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

  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const summary = successfulSummary(env.MONITOR_QUEUE ? "queue" : "direct");
  let rotation;
  try {
    rotation = await readRotation(env.DB);
  } catch {
    return {
      ...summary,
      status: "degraded",
      errorCode: "SCHEDULER_STATE_READ_FAILED",
      counts: { ...summary.counts, failed: summary.counts.failed + 1 },
    };
  }
  try {
    const cancelled = await cancelStaleScheduledSlots(
      env.DB,
      profileRevisionMap(loaded),
      now,
    );
    summary.cancelled = cancelled.changed;
    summary.discovered = await stageDiscoveredSlots({
      scheduledTime,
      env,
      deps,
      loaded,
      now,
      bootstrapRotation: rotation,
    });
  } catch {
    return {
      ...summary,
      status: "degraded",
      errorCode: "SCHEDULER_DISCOVERY_FAILED",
      counts: { ...summary.counts, failed: summary.counts.failed + 1 },
    };
  }

  let rows;
  try {
    rows = await listRetryableSlots(env.DB, now, 200);
  } catch {
    return {
      ...summary,
      status: "degraded",
      errorCode: "SCHEDULER_BACKLOG_READ_FAILED",
      counts: { ...summary.counts, failed: summary.counts.failed + 1 },
    };
  }
  const work = workFromRows(rows);
  summary.counts.due = work.length;

  if (env.MONITOR_QUEUE?.sendBatch) {
    const fair = selectFairWorkWithinBudget(work, {
      externalRequestBudget: 40,
      rotation,
    });
    const cap = configuredQueueDiscoveryLimit(env.QUEUE_DISCOVERY_CAP);
    const selected = fair.selected.slice(0, cap);
    summary.capped = Math.max(0, work.length - selected.length);
    summary.queued = selected.length;
    summary.queuedEstimatedExternalRequests = selected.reduce(
      (total, item) =>
        total + estimateTaskExternalRequests(item.profile, item.task),
      0,
    );
    if (selected.length > 0) {
      try {
        await env.MONITOR_QUEUE.sendBatch(selected.map((item) => ({
          body: { slotId: item.id, payloadHash: item.payloadHash },
        })));
        await markScheduledSlotsQueued(
          env.DB,
          selected.map((item) => ({
            id: item.id,
            payload_hash: item.payloadHash,
          })),
          now,
        );
      } catch {
        summary.status = "degraded";
        summary.errorCode = "QUEUE_ENQUEUE_FAILED";
        summary.counts.failed += 1;
      }
    }
    await writeRotation(env.DB, rotation + 1, now).catch(() => {});
  } else {
    const selection = selectFairWorkWithinBudget(work, {
      externalRequestBudget: configuredDirectBudget(
        env.DIRECT_EXTERNAL_REQUEST_BUDGET,
      ),
      rotation,
    });
    summary.externalRequestBudget = selection.externalRequestBudget;
    summary.estimatedExternalRequests = selection.estimatedExternalRequests;
    summary.capped = selection.deferred.length;
    await executeWorkItems(selection.selected, env, deps, summary, {
      maxExternalRequests: MAX_SCHEDULED_EXTERNAL_REQUESTS,
    });
    await writeRotation(env.DB, rotation + 1, now).catch(() => {});
    if (selection.deferred.length > 0) {
      summary.status = "degraded";
      summary.errorCode = "DIRECT_FALLBACK_CAPPED";
    }
  }
  summary.backlog = await countScheduledBacklog(env.DB, clock()).catch(() => -1);
  if (summary.counts.failed > 0 || summary.counts.degraded > 0) {
    summary.status = "degraded";
  }
  return summary;
}

export async function runQueueBatch(messages, env, deps = {}) {
  const summary = successfulSummary("queue");
  const clock = deps.now ?? (() => new Date());
  if (!env?.DB || typeof env.DB.prepare !== "function") {
    return {
      ...summary,
      status: "unavailable",
      errorCode: "D1_NOT_CONFIGURED",
    };
  }
  if (!deps.skipProfileRevisionCheck) {
    let loaded;
    try {
      loaded = await readSettings(env.DB);
      if (loaded.errorCode) throw new Error(loaded.errorCode);
      summary.cancelled = (
        await cancelStaleScheduledSlots(
          env.DB,
          profileRevisionMap(loaded),
          clock(),
        )
      ).changed;
    } catch {
      for (const message of messages) message.retry?.();
      return {
        ...summary,
        status: "degraded",
        errorCode: "QUEUE_PROFILE_CHECK_FAILED",
      };
    }
  }
  const validWork = messages.flatMap((message) => {
    const slotId = message?.body?.slotId;
    const payloadHash = message?.body?.payloadHash;
    return typeof slotId === "string" && typeof payloadHash === "string"
      ? [{ id: slotId, payloadHash, message }]
      : [];
  });
  const seen = new Set();
  const duplicates = [];
  const uniqueWork = [];
  for (const item of validWork) {
    const identity = `${item.id}\n${item.payloadHash}`;
    if (seen.has(identity)) {
      duplicates.push(item);
    } else {
      seen.add(identity);
      uniqueWork.push(item);
    }
  }
  for (const { message } of duplicates) message.ack?.();
  const work = uniqueWork.slice(0, QUEUE_CONSUMER_BATCH_LIMIT);
  const capped = uniqueWork.slice(QUEUE_CONSUMER_BATCH_LIMIT);
  for (const { message } of capped) message.retry?.();
  summary.capped = capped.length;
  summary.counts.due = messages.length;
  for (const item of work) {
    const before = {
      claimed: summary.counts.claimed,
      failed: summary.counts.failed,
    };
    await executeWorkItems([item], env, deps, summary, {
      maxExternalRequests: MAX_SCHEDULED_EXTERNAL_REQUESTS,
    });
    if (
      summary.counts.claimed > before.claimed ||
      summary.counts.failed === before.failed
    ) {
      item.message.ack?.();
    } else {
      item.message.retry?.();
    }
  }
  for (const message of messages) {
    if (
      !validWork.some(({ message: valid }) => valid === message)
    ) message.ack?.();
  }
  summary.backlog = await countScheduledBacklog(env.DB, clock()).catch(() => -1);
  if (summary.counts.failed > 0 || summary.counts.degraded > 0) {
    summary.status = "degraded";
  }
  return summary;
}

export async function runManualCollection(
  taskType,
  env,
  deps = {},
  page = {},
) {
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
  let degradedProfiles = 0;
  let written = 0;
  const sources = [];
  const scheduledFor = clock().toISOString();
  const work = loaded.settings.profiles
    .filter(({ enabled }) => enabled)
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((profile) =>
      splitTaskWithinRequestLimit(
        profile,
        {
          type: taskType,
          schedule: `manual/${taskType}`,
          localSlot: `manual-${taskType}`,
          scheduledFor,
        },
        MAX_SCHEDULED_EXTERNAL_REQUESTS,
      ).map((task) => ({ profile, task })));
  const cursor = configuredManualCursor(page.cursor, work.length);
  const limit = configuredManualLimit(page.limit);
  const selection = selectFairWorkWithinBudget(work.slice(cursor), {
    externalRequestBudget: MAX_SCHEDULED_EXTERNAL_REQUESTS,
    maxTasks: limit,
    preserveOrder: true,
    stopOnBudgetExhaustion: true,
  });
  for (const { profile, task } of selection.selected) {
    const result = taskType === "newsCollect"
      ? await collectNewsWithHealth({
        collectNews: deps.collectNews ?? collectNewsForProfile,
        profile,
        db: env.DB,
        env,
        fetcher: deps.newsFetcher ?? globalThis.fetch,
        writeItems: deps.writeNews ?? writeNewsItems,
        now: clock(),
      })
      : await collectForTask({
        taskType,
        task,
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
    if (result.status === "degraded") degradedProfiles += 1;
    if (Array.isArray(result.sources)) sources.push(...result.sources);
  }
  const processed = selection.selected.length;
  const nextOffset = cursor + processed;
  const backlog = Math.max(0, work.length - nextOffset);
  const status = processed === 0 && backlog === 0
    ? "completed"
    : totals.succeeded === 0
      ? "failed"
      : totals.failed > 0 || degradedProfiles > 0 ? "degraded" : "completed";
  return {
    status,
    ...(status === "failed" ? { errorCode: "COLLECTION_UNAVAILABLE" } : {}),
    counts: totals,
    written,
    sources,
    cursor,
    limit,
    nextCursor: backlog > 0 ? nextOffset : null,
    backlog,
    processed,
    workUnitBudget: MAX_SCHEDULED_EXTERNAL_REQUESTS,
    estimatedWorkUnits: selection.estimatedExternalRequests,
  };
}

export async function handleFetch(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({
      ok: true,
      service: "monitor-worker",
      deployment: deploymentIdentity(env),
      newsProviders: await readNewsProviderHealth(
        env?.DB,
        env?.HEALTH_QUERY_TIMEOUT_MS,
      ),
    });
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
  const result = await runManualCollection(
    url.searchParams.get("task"),
    env,
    deps,
    {
      cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.get("limit"),
    },
  );
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

  async queue(batch, env) {
    const summary = await runQueueBatch(batch.messages, env);
    console.log(JSON.stringify({ event: "monitor_queue", ...summary }));
  },

  fetch(request, env) {
    return handleFetch(request, env);
  },
};

export default worker;
