import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildHealthPayload,
  checkDeploymentManifest,
  checkDeploymentState,
  checkJson,
} from "../functions/api/_health.mjs";
import { onRequestGet } from "../functions/api/health.js";

test("checkJson reports upstream status and freshness without leaking the body", async () => {
  const result = await checkJson(
    "reports",
    "https://example.test/latest.json",
    {},
    {
      fetchImpl: async () =>
        new Response(JSON.stringify({ generated_at: "2026-07-22T10:00:00Z", trade_date: "2026-07-22", status: "ok", secret: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.detail, {
    generated_at: "2026-07-22T10:00:00Z",
    trade_date: "2026-07-22",
    status: "ok",
  });
  assert.equal("secret" in result.detail, false);
});

test("checkJson converts network failures into a stable degraded result", async () => {
  const result = await checkJson("actions", "https://example.test/runs", {}, {
    fetchImpl: async () => {
      throw new TypeError("socket closed");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, "unreachable");
});

test("checkJson understands the realtime options freshness contract", async () => {
  const result = await checkJson("options_live", "https://example.test/api/live", {}, {
    fetchImpl: async () =>
      new Response(JSON.stringify({
        quote_generated_at: "2026-07-22T18:42:00+08:00",
        source_status: { overall: "market_closed" },
      }), { status: 200 }),
  });

  assert.deepEqual(result.detail, {
    generated_at: "2026-07-22T18:42:00+08:00",
    trade_date: null,
    status: "market_closed",
  });
});

test("buildHealthPayload exposes booleans only and marks partial failure degraded", () => {
  const payload = buildHealthPayload(
    {
      ACCESS_CODE: "do-not-return",
      OPENAI_COMPATIBLE_API_KEY: "do-not-return",
      GITHUB_DISPATCH_TOKEN: "do-not-return",
      CF_PAGES_COMMIT_SHA: "208edf3c4afa84fc9f5d00bdadad5b83df3a0d50",
      CF_PAGES_BRANCH: "main",
      CF_PAGES_URL: "https://d359044c.tradingagents-board.pages.dev",
    },
    [
      { name: "reports", ok: true },
      { name: "options_live", ok: false },
      {
        name: "deployment_manifest",
        ok: true,
        detail: {
          commitSha: "208edf3c4afa84fc9f5d00bdadad5b83df3a0d50",
          deployedAt: "2026-07-22T09:55:00.000Z",
          branch: "main",
        },
      },
    ],
    new Date("2026-07-22T10:00:00Z"),
  );

  assert.equal(payload.status, "degraded");
  assert.equal(payload.checked_at, "2026-07-22T10:00:00.000Z");
  assert.deepEqual(payload.configured, {
    access_gate: true,
    chat: true,
    analysis_dispatch: true,
    shared_conversations: false,
  });
  assert.deepEqual(payload.deployment, {
    service: "pages-functions",
    commitSha: "208edf3c4afa84fc9f5d00bdadad5b83df3a0d50",
    deployedAt: "2026-07-22T09:55:00.000Z",
    branch: "main",
    url: "https://d359044c.tradingagents-board.pages.dev/",
  });
  assert.equal(JSON.stringify(payload).includes("do-not-return"), false);
});

test("health checks the same bounded live-to-snapshot chain as the user route", async () => {
  const source = await readFile(
    new URL("../functions/api/health.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /loadVolguardData\(\{[\s\S]*?liveTimeoutMs:\s*5000[\s\S]*?snapshotTimeoutMs:\s*3000/,
  );
  assert.match(
    source,
    /mode:\s*result\.mode[\s\S]*?fallback:\s*result\.fallback_reason/,
  );
});

test("buildHealthPayload fails closed when Pages deployment metadata is malformed", () => {
  const payload = buildHealthPayload(
    {
      CF_PAGES_COMMIT_SHA: "not-a-sha",
      CF_PAGES_BRANCH: "<script>",
      CF_PAGES_URL: "javascript:alert(1)",
    },
    [{ name: "reports", ok: true }],
    new Date("2026-07-22T10:00:00Z"),
  );

  assert.deepEqual(payload.deployment, {
    service: "pages-functions",
    commitSha: "unknown",
    deployedAt: "unknown",
    branch: "unknown",
    url: null,
  });
});

test("deployment manifest is accepted only for the current immutable revision", async () => {
  const sha = "208edf3c4afa84fc9f5d00bdadad5b83df3a0d50";
  const accepted = await checkDeploymentManifest(
    "https://example.pages.dev/data/deployment.json",
    sha,
    {
      fetchImpl: async () => new Response(JSON.stringify({
        commitSha: sha,
        deployedAt: "2026-07-22T09:55:00.000Z",
        branch: "main",
      }), { status: 200 }),
    },
  );
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.detail, {
    commitSha: sha,
    deployedAt: "2026-07-22T09:55:00.000Z",
    branch: "main",
  });

  const mismatch = await checkDeploymentManifest(
    "https://example.pages.dev/data/deployment.json",
    sha,
    {
      fetchImpl: async () => new Response(JSON.stringify({
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        deployedAt: "2026-07-22T09:55:00.000Z",
        branch: "main",
      }), { status: 200 }),
    },
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, "revision_mismatch");
  assert.equal(mismatch.detail, null);
});

test("deployment manifest rejects missing or malformed deployment time", async () => {
  const sha = "208edf3c4afa84fc9f5d00bdadad5b83df3a0d50";
  const invalid = await checkDeploymentManifest(
    "https://example.pages.dev/data/deployment.json",
    sha,
    {
      fetchImpl: async () => new Response(JSON.stringify({
        commitSha: sha,
        deployedAt: "not-a-time",
        branch: "main",
      }), { status: 200 }),
    },
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "invalid_metadata");
  assert.equal(invalid.detail, null);

  const missing = await checkDeploymentManifest(null, sha);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "metadata_unavailable");
});

test("deployment identity falls back to a bounded D1 record for direct Pages races", async () => {
  const sha = "208edf3c4afa84fc9f5d00bdadad5b83df3a0d50";
  const calls = [];
  const db = {
    prepare(sql) {
      calls.push(sql);
      return {
        bind(...params) {
          calls.push(params);
          return this;
        },
        async first() {
          return {
            commit_sha: sha,
            deployed_at: "2026-07-27T19:00:00Z",
            branch: "main",
            url: null,
          };
        },
      };
    },
  };
  const result = await checkDeploymentState(db, sha);
  assert.equal(result.ok, true);
  assert.deepEqual(result.detail, {
    commitSha: sha,
    deployedAt: "2026-07-27T19:00:00Z",
    branch: "main",
    source: "d1",
  });
  assert.deepEqual(calls[1], ["pages-functions", sha]);
});

test("health reports D1-backed persistent conversations as available", () => {
  const payload = buildHealthPayload(
    { DB: { prepare() {} } },
    [{ name: "reports", ok: true }],
    new Date("2026-07-22T10:00:00Z"),
  );
  assert.equal(payload.configured.shared_conversations, true);
});

test("health degrades when the latest report request succeeded but the research run failed", () => {
  const payload = buildHealthPayload(
    {},
    [
      { name: "reports", ok: true, detail: { status: "failed" } },
      { name: "options_live", ok: true, detail: { status: "market_closed" } },
    ],
    new Date("2026-07-22T10:00:00Z"),
  );

  assert.equal(payload.status, "degraded");
});

test("health reports a missed scheduled research date instead of staying green", () => {
  const checks = [{
    name: "reports",
    ok: true,
    detail: {
      generated_at: "2026-07-28T07:36:00Z",
      trade_date: "2026-07-28",
      status: "ok",
    },
  }];
  const payload = buildHealthPayload(
    {},
    checks,
    new Date("2026-07-30T02:00:00Z"),
  );

  assert.equal(payload.status, "degraded");
  assert.equal(checks[0].error, "report_lag");
  assert.equal(checks[0].detail.expected_trade_date, "2026-07-29");
  assert.equal(checks[0].detail.freshness, "stale");
});

test("onRequestGet falls back to D1 deployment state concurrently instead of after the static manifest fetch", async () => {
  const sha = "208edf3c4afa84fc9f5d00bdadad5b83df3a0d50";
  const CHECK_DELAY_MS = 200;
  const db = {
    prepare(sql) {
      return {
        bind: () => ({
          async first() {
            await new Promise((resolve) => setTimeout(resolve, CHECK_DELAY_MS));
            return {
              commit_sha: sha,
              deployed_at: "2026-07-31T08:09:51Z",
              branch: "main",
              url: null,
            };
          },
        }),
      };
    },
  };
  const env = {
    CF_PAGES_COMMIT_SHA: sha,
    CF_PAGES_BRANCH: "main",
    CF_PAGES_URL: "https://test.tradingagents-board.pages.dev",
    DB: db,
  };
  const originalFetch = globalThis.fetch;
  // buildHealthPayload 用真实 Date.now() 判断 report_lag（onRequestGet 不接受可注入的
  // 时钟），报告日期必须跟随运行时的"上海今天"，否则会像 2026-08-02 那次 CI 一样，随真实
  // 时间推移把这条 fixture 判成滞后，把整个 payload.status 拖成 degraded。用与
  // expectedReportDate() 相同的时区口径，保证 trade_date 恒不早于它的计算结果。
  const todayIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "raw.githubusercontent.com") {
      return Response.json({
        generated_at: `${todayIso}T08:00:00Z`,
        trade_date: todayIso,
        status: "ok",
      });
    }
    if (url.hostname === "api.github.com") {
      return Response.json([]);
    }
    if (url.hostname === "sh50-volguard.pages.dev") {
      return Response.json({});
    }
    if (url.pathname === "/data/deployment.json") {
      // 复现生产实测的真实故障：该路径返回 SPA 兜底 HTML，不是 JSON manifest。
      await new Promise((resolve) => setTimeout(resolve, CHECK_DELAY_MS));
      return new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  };

  try {
    const startedAt = Date.now();
    const response = await onRequestGet({
      env,
      request: { url: "https://test.tradingagents-board.pages.dev/api/health" },
    });
    const elapsedMs = Date.now() - startedAt;
    const payload = await response.json();

    assert.ok(
      elapsedMs < CHECK_DELAY_MS * 2 - 50,
      `expected the manifest fetch and D1 fallback to run concurrently `
      + `(elapsed ${elapsedMs}ms should be well under ${CHECK_DELAY_MS * 2}ms)`,
    );
    const deploymentCheck = payload.checks.find(({ name }) => name === "deployment_manifest");
    assert.equal(deploymentCheck.ok, true);
    assert.equal(deploymentCheck.detail.source, "d1");
    assert.equal(deploymentCheck.detail.commitSha, sha);
    assert.equal(payload.status, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
