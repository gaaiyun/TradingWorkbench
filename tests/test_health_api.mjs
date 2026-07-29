import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHealthPayload,
  checkDeploymentManifest,
  checkDeploymentState,
  checkJson,
} from "../functions/api/_health.mjs";

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
