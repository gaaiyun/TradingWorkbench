import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { monitorSettings } from "./helpers/monitor_settings.mjs";

const workerUrl = new URL("../workers/monitor/src/index.mjs", import.meta.url);

class WorkerD1 {
  constructor(settings) {
    this.settings = settings;
    this.slots = new Map();
    this.barWrites = [];
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...params) {
        return {
          async first() {
            if (/FROM\s+workbench_settings/i.test(sql)) {
              return db.settings == null
                ? null
                : { settings_json: JSON.stringify(db.settings) };
            }
            if (/INSERT\s+INTO\s+scheduled_slots/i.test(sql)) {
              const [id, profileId, slotType, scheduledFor, claimedAt, expiresAt, updatedAt] =
                params;
              const row = db.slots.get(id);
              if (!row) {
                const claim = {
                  id,
                  profile_id: profileId,
                  slot_type: slotType,
                  scheduled_for: scheduledFor,
                  status: "claimed",
                  attempt_count: 1,
                  claimed_at: claimedAt,
                  expires_at: expiresAt,
                  updated_at: updatedAt,
                };
                db.slots.set(id, claim);
                return claim;
              }
              if (row.status === "failed" && row.attempt_count < 3) {
                row.status = "claimed";
                row.attempt_count += 1;
                return row;
              }
              return null;
            }
            return null;
          },
          async run() {
            if (/UPDATE\s+scheduled_slots/i.test(sql)) {
              const [status, completedAt, errorCode, updatedAt, id] = params;
              Object.assign(db.slots.get(id), {
                status,
                completed_at: completedAt,
                last_error_code: errorCode,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (/INSERT\s+INTO\s+market_bars/i.test(sql)) {
              db.barWrites.push(...JSON.parse(params[0]));
              return { meta: { changes: db.barWrites.length } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

function barFor(request) {
  return {
    symbol: request.symbol,
    timeframe: request.timeframe,
    timestamp: "2026-07-23T01:30:00.000Z",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1000,
    source: "wire",
    asOf: "2026-07-23T01:30:00.000Z",
    fetchedAt: "2026-07-23T01:30:01.000Z",
    freshness: "fresh",
    adjustment: "none",
    quality: "good",
  };
}

test("core scheduled run reads D1 settings, executes due tasks, and is awaitable", async () => {
  const { runScheduled } = await import(workerUrl);
  const db = new WorkerD1(monitorSettings());
  const result = await runScheduled(
    Date.parse("2026-07-23T01:30:00.000Z"),
    { DB: db },
    {
      registryFactory: () => ({
        fetchMarketData: async (request) => ({
          status: "ok",
          source: "wire",
          bars: [barFor(request)],
          sources: [{ source: "wire", status: "success", reason: null }],
        }),
      }),
    },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(result.counts, {
    due: 2,
    claimed: 2,
    completed: 1,
    deferred: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(db.barWrites.length, 2);
  assert.deepEqual(
    [...db.slots.values()].map((row) => row.status).sort(),
    ["completed", "deferred"],
  );
});

test("close scheduled run dispatches one full analysis with the claimed slot metadata", async () => {
  const { runScheduled } = await import(workerUrl);
  const db = new WorkerD1(monitorSettings());
  const requests = [];
  const result = await runScheduled(
    Date.parse("2026-07-23T07:20:00.000Z"),
    {
      DB: db,
      GITHUB_DISPATCH_TOKEN: "worker-secret",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_WORKFLOW_ID: "daily-analysis.yml",
    },
    {
      fetcher: async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: 204 });
      },
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.counts.completed, 1);
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.inputs.profileId, "etf-main");
  assert.match(payload.inputs.slotId, /^slot-[a-f0-9]{64}$/);
  assert.equal(payload.inputs.scheduledFor, "2026-07-23T07:20:00.000Z");
  assert.equal(payload.inputs.tickers, "515880.SS,QQQ");
  assert.equal(JSON.stringify(result).includes("worker-secret"), false);
});

test("missing and invalid D1 settings fail safely with stable summaries", async () => {
  const { runScheduled } = await import(workerUrl);
  assert.deepEqual(
    await runScheduled(Date.now(), { DB: new WorkerD1(null) }),
    {
      status: "unavailable",
      errorCode: "WORKBENCH_SETTINGS_MISSING",
      counts: { due: 0, claimed: 0, completed: 0, deferred: 0, failed: 0, skipped: 0 },
      sources: [],
    },
  );
  const bad = await runScheduled(Date.now(), { DB: new WorkerD1({ version: 999 }) });
  assert.equal(bad.status, "unavailable");
  assert.equal(bad.errorCode, "WORKBENCH_SETTINGS_INVALID");
  assert.equal(JSON.stringify(bad).includes("不支持"), false);
});

test("scheduled handler uses scheduledTime and waitUntil while health reveals no secret", async () => {
  const { default: worker } = await import(workerUrl);
  const db = new WorkerD1(monitorSettings());
  let promise;
  worker.scheduled(
    { scheduledTime: Date.parse("2026-07-23T00:25:00.000Z") },
    { DB: db, GITHUB_DISPATCH_TOKEN: "secret-value" },
    { waitUntil(value) { promise = value; } },
  );
  assert.ok(promise instanceof Promise);
  const summary = await promise;
  assert.equal(summary.counts.deferred, 1);
  assert.equal(JSON.stringify(summary).includes("secret-value"), false);

  const response = await worker.fetch(new Request("https://monitor.example/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "monitor-worker" });
  assert.equal((await worker.fetch(new Request("https://monitor.example/anything"))).status, 404);
});

test("monitor wrangler config uses five-minute cron and the same placeholder D1 binding", () => {
  const pages = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const monitor = readFileSync(
    new URL("../wrangler.monitor.toml", import.meta.url),
    "utf8",
  );
  assert.match(monitor, /main\s*=\s*"workers\/monitor\/src\/index\.mjs"/);
  assert.match(monitor, /crons\s*=\s*\[\s*"\*\/5 \* \* \* \*"\s*\]/);
  assert.match(monitor, /binding\s*=\s*"DB"/);
  assert.match(monitor, /database_name\s*=\s*"tradingagents-workbench"/);
  assert.match(monitor, /database_id\s*=\s*"replace-with-d1-database-id"/);
  assert.equal(monitor.includes("GITHUB_DISPATCH_TOKEN"), false);
  assert.equal(
    /database_name\s*=\s*"([^"]+)"/.exec(monitor)[1],
    /database_name\s*=\s*"([^"]+)"/.exec(pages)[1],
  );
});

test("daily workflow accepts monitor dispatch metadata and keeps legacy manual input", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/daily-analysis.yml", import.meta.url),
    "utf8",
  );
  for (const input of ["tickers", "profileId", "slotId", "scheduledFor"]) {
    assert.match(workflow, new RegExp(`^\\s{6}${input}:`, "m"));
  }
  assert.match(workflow, /MANUAL_TICKERS:\s*\$\{\{\s*inputs\.tickers/);
});
