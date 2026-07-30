import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { onRequestPost as analyze } from "../functions/api/analyze.js";
import { onRequestGet as getHistory } from "../functions/api/history.js";
import { onRequestGet as getLatest } from "../functions/api/latest.js";
import { onRequestGet as getReport } from "../functions/api/report.js";
import { onRequestGet as getReportAudit } from "../functions/api/report-audit.js";
import { onRequestGet as listRuns } from "../functions/api/runs.js";
import { onRequestPost as saveSettings } from "../functions/api/settings.js";
import { FakeD1 } from "./helpers/fake_d1.mjs";

const env = {
  ACCESS_CODE: "correct-code",
  GITHUB_DISPATCH_TOKEN: "dispatch-token",
};

function defaultSettings() {
  return JSON.parse(
    readFileSync(new URL("../public/data/workbench-settings.json", import.meta.url), "utf8"),
  );
}

function post(body, code = "correct-code") {
  return new Request("https://workbench.test/api/action", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(code === null ? {} : { "x-access-code": code }),
    },
    body,
  });
}

function settingsRow(settings = defaultSettings()) {
  return {
    version: settings.version,
    settings_json: JSON.stringify(settings),
    updated_at: "2026-07-25T00:00:00.000Z",
  };
}

test("manual analysis normalizes the same ticker contract used by saved tasks", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  globalThis.fetch = async (_url, init) => {
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const response = await analyze({
      request: post(JSON.stringify({ tickers: "nvda, 600519,BRK.B" })),
      env,
    });
    const payload = await response.json();
    assert.equal(response.status, 202);
    assert.deepEqual(payload.tickers, ["NVDA", "600519.SS", "BRK-B"]);
    assert.equal(dispatch.inputs.tickers, "NVDA,600519.SS,BRK-B");
    assert.match(payload.requestId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    assert.equal(dispatch.inputs.requestId, "");
    assert.equal(dispatch.inputs.analysts, "market,news,fundamentals");
    assert.equal(dispatch.inputs.researchDepth, "standard");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual analysis forwards a caller UUID, analyst subset, and deep research depth", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  globalThis.fetch = async (_url, init) => {
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  try {
    const response = await analyze({
      request: post(JSON.stringify({
        tickers: ["NVDA", "SPY", "QQQ"],
        requestId,
        analysts: ["news", "market", "news"],
        researchDepth: "deep",
      })),
      env,
    });
    const payload = await response.json();
    assert.equal(response.status, 202);
    assert.equal(payload.requestId, requestId);
    assert.deepEqual(payload.analysts, ["news", "market"]);
    assert.equal(payload.researchDepth, "deep");
    assert.deepEqual(dispatch.inputs, {
      tickers: "NVDA,SPY,QQQ",
      requestId,
      analysts: "news,market",
      researchDepth: "deep",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("profile manual analysis validates D1 ownership and dispatches profile identity", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  globalThis.fetch = async (_url, init) => {
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const profileId = defaultSettings().profiles[0].id;
    const response = await analyze({
      request: post(JSON.stringify({
        tickers: ["515880.SS"],
        profileId,
      })),
      env: { ...env, DB: new FakeD1({ settings: settingsRow() }) },
    });
    const payload = await response.json();
    assert.equal(response.status, 202);
    assert.equal(payload.identity.scope, "profile");
    assert.equal(payload.identity.kind, "manual");
    assert.equal(payload.identity.profileId, profileId);
    assert.equal(payload.identity.requestId, null);
    assert.equal(dispatch.inputs.profileId, profileId);
    assert.equal(dispatch.inputs.requestId, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analysis rejects a profile and caller request UUID before D1 or GitHub access", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("ambiguous identity must not access upstream");
  try {
    const response = await analyze({
      request: post(JSON.stringify({
        tickers: ["SPY"],
        profileId: "profile-a",
        requestId: "123e4567-e89b-42d3-a456-426614174000",
      })),
      env: { ...env, DB: new FakeD1({ fail: true }) },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error_code, "ambiguous_run_identity");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("profile manual analysis fails closed for unknown or unavailable D1 settings", async () => {
  const unknown = await analyze({
    request: post(JSON.stringify({
      tickers: ["SPY"],
      profileId: "missing-profile",
    })),
    env: { ...env, DB: new FakeD1({ settings: settingsRow() }) },
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error_code, "profile_not_found");

  const unavailable = await analyze({
    request: post(JSON.stringify({
      tickers: ["SPY"],
      profileId: defaultSettings().profiles[0].id,
    })),
    env: { ...env, DB: new FakeD1({ fail: true }) },
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error_code, "settings_unavailable");
});

test("manual analysis rejects invalid research controls with stable 400 codes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("invalid requests must not dispatch");
  const cases = [
    {
      body: { tickers: ["SPY"], requestId: "not-a-uuid" },
      code: "invalid_request_id",
    },
    {
      body: { tickers: ["SPY"], analysts: ["market", "quantum"] },
      code: "invalid_analysts",
    },
    {
      body: { tickers: ["SPY"], analysts: [] },
      code: "invalid_analysts",
    },
    {
      body: { tickers: ["SPY"], researchDepth: "extreme" },
      code: "invalid_research_depth",
    },
    {
      body: { tickers: ["SPY"], researchDepth: "__proto__" },
      code: "invalid_research_depth",
    },
  ];
  try {
    for (const entry of cases) {
      const response = await analyze({
        request: post(JSON.stringify(entry.body)),
        env,
      });
      const payload = await response.json();
      assert.equal(response.status, 400);
      assert.equal(payload.error_code, entry.code);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual analysis enforces the weighted workload ceiling before dispatch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("over-limit requests must not dispatch");
  try {
    const response = await analyze({
      request: post(JSON.stringify({
        tickers: ["SPY", "QQQ", "NVDA", "AAPL"],
        requestId: "123e4567-e89b-42d3-a456-426614174099",
        researchDepth: "deep",
      })),
      env,
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error_code, "analysis_workload_exceeded");
    assert.deepEqual(payload.limit, { weight: 6 });
    assert.deepEqual(payload.actual, { tickers: 4, depthWeight: 2, weight: 8 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy monitor-combination runs keep the existing ten-symbol contract", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  globalThis.fetch = async (_url, init) => {
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const tickers = [
      "SPY", "QQQ", "NVDA", "AAPL", "MSFT",
      "GOOGL", "ORCL", "AMD", "TSM", "AVGO",
    ];
    const response = await analyze({
      request: post(JSON.stringify({ tickers, researchDepth: "deep" })),
      env,
    });
    assert.equal(response.status, 202);
    assert.equal(dispatch.inputs.requestId, "");
    assert.equal(dispatch.inputs.tickers.split(",").length, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sentiment and social analysts require an explicit server capability", async () => {
  const originalFetch = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = async (_url, init) => {
    dispatches += 1;
    return new Response(null, { status: 204 });
  };
  try {
    for (const analyst of ["social", "sentiment"]) {
      const blocked = await analyze({
        request: post(JSON.stringify({ tickers: ["SPY"], analysts: [analyst] })),
        env,
      });
      assert.equal(blocked.status, 400);
      assert.equal((await blocked.json()).error_code, "analysis_capability_unavailable");
    }
    const enabled = await analyze({
      request: post(JSON.stringify({ tickers: ["SPY"], analysts: ["sentiment"] })),
      env: { ...env, ANALYSIS_CAPABILITIES: "social" },
    });
    assert.equal(enabled.status, 202);
    assert.equal(dispatches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analysis runs expose request and scheduled slot identities from stable run names", async () => {
  const originalFetch = globalThis.fetch;
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  globalThis.fetch = async (url) => {
    if (String(url).includes("daily-analysis.yml")) {
      return Response.json({
        workflow_runs: [
          {
            id: 1,
            display_title: `Daily analysis · manual · ${requestId}`,
            status: "queued",
            conclusion: null,
            created_at: "2026-07-25T10:00:00Z",
            html_url: "https://github.test/runs/1",
          },
          {
            id: 2,
            display_title: "Daily analysis · etf-main · slot-abc · 2026-07-25T09:30:00.000Z",
            status: "completed",
            conclusion: "success",
            created_at: "2026-07-25T09:30:00Z",
            html_url: "https://github.test/runs/2",
          },
        ],
      });
    }
    return Response.json({ workflow_runs: [] });
  };
  try {
    const response = await listRuns({ env });
    const { runs } = await response.json();
    assert.deepEqual(
      {
        requestId: runs[0].requestId,
        profileId: runs[0].profileId,
        slotId: runs[0].slotId,
        scheduledFor: runs[0].scheduledFor,
      },
      { requestId, profileId: null, slotId: null, scheduledFor: null },
    );
    assert.deepEqual(
      {
        requestId: runs[1].requestId,
        profileId: runs[1].profileId,
        slotId: runs[1].slotId,
        scheduledFor: runs[1].scheduledFor,
      },
      {
        requestId: null,
        profileId: "etf-main",
        slotId: "slot-abc",
        scheduledFor: "2026-07-25T09:30:00.000Z",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runs fetch enough candidates then isolate profile manual, monitor, and adhoc identities", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    if (String(url).includes("daily-analysis.yml")) {
      return Response.json({
        workflow_runs: [
          {
            id: 11,
            display_title: "Daily analysis · profile · manual · profile-a",
            status: "completed",
            conclusion: "success",
            created_at: "2026-07-25T11:00:00Z",
            html_url: "https://github.test/runs/11",
          },
          {
            id: 12,
            display_title: "Daily analysis · profile · monitor · profile-b · slot-b · 2026-07-25T10:00:00.000Z",
            status: "completed",
            conclusion: "failure",
            created_at: "2026-07-25T10:00:00Z",
            html_url: "https://github.test/runs/12",
          },
          {
            id: 13,
            display_title: "Daily analysis · adhoc · 123e4567-e89b-42d3-a456-426614174000",
            status: "queued",
            conclusion: null,
            created_at: "2026-07-25T09:00:00Z",
            html_url: "https://github.test/runs/13",
          },
        ],
      });
    }
    return Response.json({ workflow_runs: [] });
  };
  try {
    const profileResponse = await listRuns({
      request: new Request("https://workbench.test/api/runs?profile=profile-b"),
      env,
    });
    const profileRuns = (await profileResponse.json()).runs;
    assert.deepEqual(profileRuns.map((run) => run.id), [12]);
    assert.deepEqual(profileRuns[0].identity, {
      scope: "profile",
      kind: "monitor",
      runId: "12",
      profileId: "profile-b",
      requestId: null,
      slotId: "slot-b",
      scheduledFor: "2026-07-25T10:00:00.000Z",
    });

    const adhocResponse = await listRuns({
      request: new Request(
        "https://workbench.test/api/runs?requestId=123e4567-e89b-42d3-a456-426614174000",
      ),
      env,
    });
    const adhocRuns = (await adhocResponse.json()).runs;
    assert.deepEqual(adhocRuns.map((run) => run.id), [13]);
    assert.equal(adhocRuns[0].identity.scope, "adhoc");
    assert.ok(seenUrls.every((url) => url.includes("per_page=100")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("history, latest, and report audit selectors never mix profiles or adhoc requests", async () => {
  const originalFetch = globalThis.fetch;
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const batches = [
    {
      trade_date: "2026-07-25",
      generated_at: "2026-07-25T12:00:00Z",
      identity: {
        scope: "profile",
        kind: "manual",
        profileId: "profile-a",
        requestId: null,
        slotId: null,
        scheduledFor: null,
      },
      results: [{ ticker: "SPY", report: "reports/SPY/2026-07-25/complete_report.md" }],
    },
    {
      trade_date: "2026-07-25",
      generated_at: "2026-07-25T13:00:00Z",
      identity: {
        scope: "profile",
        kind: "monitor",
        profileId: "profile-b",
        requestId: null,
        slotId: "slot-b",
        scheduledFor: "2026-07-25T12:30:00.000Z",
      },
      results: [{ ticker: "SPY", report: "reports/SPY/2026-07-25-v2/complete_report.md" }],
    },
    {
      trade_date: "2026-07-25",
      generated_at: "2026-07-25T14:00:00Z",
      identity: {
        scope: "adhoc",
        kind: "adhoc",
        profileId: null,
        requestId,
        slotId: null,
        scheduledFor: null,
      },
      results: [{ ticker: "SPY", report: "reports/SPY/2026-07-25-v3/complete_report.md" }],
    },
    {
      trade_date: "2026-07-24",
      generated_at: "2026-07-24T12:00:00Z",
      results: [{ ticker: "SPY", report: "reports/SPY/2026-07-24/complete_report.md" }],
    },
  ];
  const audit = {
    version: 1,
    generatedAt: "2026-07-25T15:00:00Z",
    summary: {},
    reports: batches.map((batch) => ({
      ticker: "SPY",
      report: batch.results[0].report,
      auditStatus: "verified",
      analysisStatus: "rated",
      claimValidation: { status: "passed" },
      failureClass: null,
      identity: batch.identity,
    })),
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/data/history.json")) return Response.json(batches);
    if (String(url).endsWith("/data/report-audit.json")) return Response.json(audit);
    return Response.json({ unexpected: String(url) }, { status: 500 });
  };
  try {
    const historyA = await getHistory({
      request: new Request("https://workbench.test/api/history?profile=profile-a"),
    });
    assert.deepEqual((await historyA.json()).map((entry) => entry.identity.profileId), ["profile-a"]);

    const historyAdhoc = await getHistory({
      request: new Request(
        `https://workbench.test/api/history?requestId=${requestId}&profile=profile-a`,
      ),
    });
    assert.deepEqual((await historyAdhoc.json()).map((entry) => entry.identity.requestId), [requestId]);

    const latestB = await getLatest({
      request: new Request("https://workbench.test/api/latest?profile=profile-b"),
    });
    assert.equal((await latestB.json()).identity.profileId, "profile-b");

    const auditA = await getReportAudit({
      request: new Request("https://workbench.test/api/report-audit?profile=profile-a"),
    });
    const auditBody = await auditA.json();
    assert.deepEqual(auditBody.reports.map((entry) => entry.identity.profileId), ["profile-a"]);
    assert.equal(auditBody.summary.verifiedReports, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("latest, report audit, and report honor adhoc requestId selectors", async () => {
  const requestId = "11111111-2222-4333-8444-555555555555";
  const otherRequestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const historyPayload = [
    {
      generated_at: "2026-07-26T03:00:00Z",
      identity: {
        scope: "adhoc",
        kind: "adhoc",
        requestId,
        profileId: null,
        slotId: null,
        scheduledFor: null,
      },
      results: [{ report: "reports/MSFT/2026-07-26/complete_report.md" }],
    },
    {
      generated_at: "2026-07-26T04:00:00Z",
      identity: {
        scope: "adhoc",
        kind: "adhoc",
        requestId: otherRequestId,
        profileId: null,
        slotId: null,
        scheduledFor: null,
      },
      results: [{ report: "reports/NVDA/2026-07-26/complete_report.md" }],
    },
  ];
  const auditPayload = {
    reports: historyPayload.map((entry) => ({
      report: entry.results[0].report,
      identity: entry.identity,
      auditStatus: "verified",
      analysisStatus: "rated",
      claimValidation: { status: "passed" },
    })),
  };
  const manifestPayload = {
    ticker: "MSFT",
    tradeDate: "2026-07-26",
    auditStatus: "verified",
    analysisStatus: "rated",
    claimValidation: { status: "passed" },
    identity: historyPayload[0].identity,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes("/data/history.json")) {
      return Response.json(historyPayload);
    }
    if (path.includes("/data/report-audit.json")) {
      return Response.json(auditPayload);
    }
    if (path.includes("/reports/MSFT/2026-07-26/report_manifest.json")) {
      return Response.json(manifestPayload);
    }
    if (path.includes("/reports/MSFT/2026-07-26/complete_report.md")) {
      return new Response("# MSFT");
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const latest = await getLatest({
      request: new Request(`https://example.test/api/latest?requestId=${requestId}`),
    });
    assert.equal(latest.status, 200);
    assert.equal((await latest.json()).identity.requestId, requestId);

    const audit = await getReportAudit({
      request: new Request(`https://example.test/api/report-audit?requestId=${requestId}`),
    });
    assert.equal(audit.status, 200);
    assert.deepEqual((await audit.json()).reports.map((entry) => entry.report), [
      "reports/MSFT/2026-07-26/complete_report.md",
    ]);

    const report = await getReport({
      request: new Request(
        `https://example.test/api/report?requestId=${requestId}&path=reports%2FMSFT%2F2026-07-26%2Fcomplete_report.md`,
      ),
    });
    assert.equal(report.status, 200);
    assert.equal(await report.text(), "# MSFT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("identity APIs keep raw legacy responses unchanged when no selector is supplied", async () => {
  const originalFetch = globalThis.fetch;
  const fixtures = {
    "history.json": [{ trade_date: "2026-07-24", results: [] }],
    "latest.json": { trade_date: "2026-07-24", results: [] },
    "report-audit.json": { version: 1, summary: { successfulReports: 0 }, reports: [] },
  };
  globalThis.fetch = async (url) => {
    const name = Object.keys(fixtures).find((candidate) => String(url).endsWith(candidate));
    return Response.json(fixtures[name]);
  };
  try {
    assert.deepEqual(await (await getHistory({
      request: new Request("https://workbench.test/api/history"),
    })).json(), fixtures["history.json"]);
    assert.deepEqual(await (await getLatest({
      request: new Request("https://workbench.test/api/latest"),
    })).json(), fixtures["latest.json"]);
    assert.deepEqual(await (await getReportAudit({
      request: new Request("https://workbench.test/api/report-audit"),
    })).json(), fixtures["report-audit.json"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unscoped latest applies a verified report audit gate", async () => {
  const originalFetch = globalThis.fetch;
  const latest = {
    status: "ok",
    trade_date: "2026-07-24",
    results: [
      {
        ticker: "GOOD",
        report: "reports/GOOD/2026-07-24/complete_report.md",
      },
      {
        ticker: "UNVERIFIED",
        report: "reports/UNVERIFIED/2026-07-24/complete_report.md",
      },
    ],
  };
  const audit = {
    reports: [
      {
        report: latest.results[0].report,
        auditStatus: "verified",
        analysisStatus: "rated",
        claimValidation: { status: "passed" },
      },
      {
        report: latest.results[1].report,
        auditStatus: "legacy_unverified",
        analysisStatus: "insufficient_evidence",
        claimValidation: { status: "failed" },
      },
    ],
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/data/latest.json")) return Response.json(latest);
    if (String(url).endsWith("/data/report-audit.json")) return Response.json(audit);
    return new Response(null, { status: 404 });
  };
  try {
    const response = await getLatest({
      request: new Request("https://workbench.test/api/latest"),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.results.map((entry) => entry.ticker), ["GOOD"]);
    assert.equal(payload.evidenceGate.filteredCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("profile-scoped latest also removes reports invalidated after publication", async () => {
  const originalFetch = globalThis.fetch;
  const report = "reports/512480.SS/2026-07-29-v4/complete_report.md";
  const history = [{
    trade_date: "2026-07-29",
    generated_at: "2026-07-30T07:26:03+08:00",
    identity: {
      scope: "profile",
      kind: "manual",
      profileId: "cn-semi-comms",
      requestId: null,
      slotId: null,
      scheduledFor: null,
    },
    results: [{
      ticker: "512480.SS",
      report,
      analysis_status: "rated",
      audit_status: "verified",
    }],
  }];
  const audit = {
    reports: [{
      report,
      auditStatus: "invalidated",
      analysisStatus: "rated",
      claimValidation: { status: "passed" },
      identity: history[0].identity,
    }],
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/data/history.json")) return Response.json(history);
    if (String(url).endsWith("/data/report-audit.json")) return Response.json(audit);
    return new Response(null, { status: 404 });
  };
  try {
    const response = await getLatest({
      request: new Request(
        "https://workbench.test/api/latest?profile=cn-semi-comms",
      ),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.results, []);
    assert.equal(payload.evidenceGate.policy, "verified-only");
    assert.equal(payload.evidenceGate.filteredCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("profile-scoped report reads require a matching manifest and keep nested report tabs", async () => {
  const originalFetch = globalThis.fetch;
  const reportPath = "reports/SPY/2026-07-25/1_analysts/market.md";
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).includes("/reports/SPY/2026-07-25/report_manifest.json")) {
      return Response.json({
        ticker: "SPY",
        tradeDate: "2026-07-25",
        auditStatus: "verified",
        analysisStatus: "rated",
        claimValidation: { status: "passed", errorCodes: [] },
        identity: {
          scope: "profile",
          kind: "manual",
          profileId: "profile-b",
          requestId: null,
          slotId: null,
          scheduledFor: null,
        },
      });
    }
    if (String(url).includes("/data/report-audit.json")) {
      return Response.json({
        reports: [{
          report: "reports/SPY/2026-07-25/complete_report.md",
          auditStatus: "verified",
          analysisStatus: "rated",
          claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
        }],
      });
    }
    if (String(url).includes(`/${reportPath}`)) {
      return new Response("market report", { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  try {
    const denied = await getReport({
      request: new Request(
        `https://workbench.test/api/report?path=${encodeURIComponent(reportPath)}&profile=profile-a`,
      ),
    });
    assert.equal(denied.status, 404);
    assert.equal(fetched.some((url) => url.endsWith(`/${reportPath}`)), false);

    const allowed = await getReport({
      request: new Request(
        `https://workbench.test/api/report?path=${encodeURIComponent(reportPath)}&profile=profile-b`,
      ),
    });
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), "market report");

    fetched.length = 0;
    const legacy = await getReport({
      request: new Request(
        `https://workbench.test/api/report?path=${encodeURIComponent(reportPath)}`,
      ),
    });
    assert.equal(legacy.status, 200);
    assert.equal(fetched.some((url) => url.includes("report_manifest.json")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy unverified 510050 archive remains readable without a manifest and is prominently labeled", async () => {
  const originalFetch = globalThis.fetch;
  const base = "reports/510050.SS/2026-07-10";
  const rawPath = `${base}/1_analysts/market.md`;
  const completePath = `${base}/complete_report.md`;
  const fetched = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    fetched.push(value);
    if (value.includes("/data/report-audit.json")) {
      return Response.json({
        reports: [{
          ticker: "510050.SS",
          tradeDate: "2026-07-10",
          report: completePath,
          auditStatus: "legacy_unverified",
          analysisStatus: null,
          claimValidation: null,
          identity: {
            scope: "legacy",
            kind: "legacy",
            runId: null,
            profileId: null,
            requestId: null,
            slotId: null,
            scheduledFor: null,
          },
        }],
      });
    }
    if (value.includes("/report_manifest.json")) {
      return new Response(null, { status: 404 });
    }
    if (value.includes(`/${rawPath}`)) {
      return new Response("历史市场分析原文", { status: 200 });
    }
    if (value.includes(`/${completePath}`)) {
      return new Response("历史完整报告原文", { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  try {
    for (const [reportPath, originalText] of [
      [completePath, "历史完整报告原文"],
      [rawPath, "历史市场分析原文"],
    ]) {
      const response = await getReport({
        request: new Request(
          `https://workbench.test/api/report?path=${encodeURIComponent(reportPath)}`,
        ),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-report-audit-status"), "legacy_unverified");
      const body = await response.text();
      assert.match(body, /Historical unverified report/i);
      assert.match(body, new RegExp(originalText));
    }
    assert.equal(fetched.some((url) => url.includes("/report_manifest.json")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing manifests do not reopen invalidated or claim-failed legacy raw reports", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      base: "reports/515880.SS/2026-07-30-v9",
      auditStatus: "invalidated",
      analysisStatus: "rated",
      claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
    },
    {
      base: "reports/515880.SS/2026-07-29",
      auditStatus: "legacy_unverified",
      analysisStatus: "insufficient_evidence",
      claimValidation: { status: "failed", omittedUnsafeParagraphs: 1 },
    },
  ];
  try {
    for (const item of cases) {
      const rawPath = `${item.base}/1_analysts/market.md`;
      const completePath = `${item.base}/complete_report.md`;
      let rawFetched = false;
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.includes("/data/report-audit.json")) {
          return Response.json({
            reports: [{
              ticker: "515880.SS",
              tradeDate: "2026-07-30",
              report: completePath,
              auditStatus: item.auditStatus,
              analysisStatus: item.analysisStatus,
              claimValidation: item.claimValidation,
            }],
          });
        }
        if (value.includes("/report_manifest.json")) {
          return new Response(null, { status: 404 });
        }
        if (value.includes(`/${rawPath}`)) {
          rawFetched = true;
          return new Response("unsafe raw section", { status: 200 });
        }
        return new Response(null, { status: 404 });
      };

      const raw = await getReport({
        request: new Request(
          `https://workbench.test/api/report?path=${encodeURIComponent(rawPath)}`,
        ),
      });
      assert.equal(raw.status, 409);
      assert.equal(rawFetched, false);

      const complete = await getReport({
        request: new Request(
          `https://workbench.test/api/report?path=${encodeURIComponent(completePath)}`,
        ),
      });
      assert.equal(complete.status, 200);
      assert.match(await complete.text(), /Not Rated/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("profile-scoped claim-failed reports keep raw agent sections off the public report API", async () => {
  const originalFetch = globalThis.fetch;
  const base = "reports/515880.SS/2026-07-29";
  const rawPath = `${base}/1_analysts/market.md`;
  const completePath = `${base}/complete_report.md`;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).includes(`/${base}/report_manifest.json`)) {
      return Response.json({
        ticker: "515880.SS",
        tradeDate: "2026-07-29",
        claimValidation: {
          status: "failed",
          errorCodes: ["UNCITED_NUMERIC_CLAIM"],
        },
        identity: {
          scope: "profile",
          kind: "manual",
          profileId: "cn-semi-comms",
          requestId: null,
          slotId: null,
          scheduledFor: null,
        },
      });
    }
    if (String(url).includes("/data/report-audit.json")) {
      return Response.json({
        reports: [{
          report: completePath,
          auditStatus: "legacy_unverified",
          analysisStatus: "insufficient_evidence",
          claimValidation: {
            status: "failed",
            errorCodes: ["UNCITED_NUMERIC_CLAIM"],
            omittedUnsafeParagraphs: 1,
          },
        }],
      });
    }
    if (String(url).includes(`/${rawPath}`)) {
      return new Response("unsafe raw section", { status: 200 });
    }
    if (String(url).includes(`/${completePath}`)) {
      return new Response("Not Rated", { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  try {
    const denied = await getReport({
      request: new Request(
        `https://workbench.test/api/report?path=${encodeURIComponent(rawPath)}&profile=cn-semi-comms`,
      ),
    });
    assert.equal(denied.status, 409);
    assert.equal(
      fetched.some((url) => url.endsWith(`/${rawPath}`)),
      false,
    );

    const consolidated = await getReport({
      request: new Request(
        `https://workbench.test/api/report?path=${encodeURIComponent(completePath)}&profile=cn-semi-comms`,
      ),
    });
    assert.equal(consolidated.status, 200);
    assert.match(await consolidated.text(), /Not Rated/);
    assert.equal(
      fetched.some((url) => url.endsWith(`/${completePath}`)),
      false,
    );

    fetched.length = 0;
    const unscopedDenied = await getReport({
      request: new Request(
        `https://workbench.test/api/report?path=${encodeURIComponent(rawPath)}`,
      ),
    });
    assert.equal(unscopedDenied.status, 409);
    assert.equal(
      fetched.some((url) => url.endsWith(`/${rawPath}`)),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("report API rejects stale verified manifests invalidated by the current audit index", async () => {
  const originalFetch = globalThis.fetch;
  const base = "reports/515880.SS/2026-07-30-v6";
  const rawPath = `${base}/5_portfolio/decision.md`;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes(`/${base}/report_manifest.json`)) {
      return Response.json({
        ticker: "515880.SS",
        tradeDate: "2026-07-30",
        auditStatus: "verified",
        analysisStatus: "rated",
        claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
      });
    }
    if (value.includes("/data/report-audit.json")) {
      return Response.json({
        reports: [{
          report: `${base}/complete_report.md`,
          auditStatus: "invalidated",
          analysisStatus: "rated",
          claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
        }],
      });
    }
    if (value.includes(`/${rawPath}`)) {
      return new Response("评级：卖出", { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  try {
    const response = await getReport({
      request: new Request(
        `https://workbench.test/api/report?path=${encodeURIComponent(rawPath)}`,
      ),
    });
    assert.equal(response.status, 409);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("report API rechecks invalidation without serving a cached verified raw response", async () => {
  const originalFetch = globalThis.fetch;
  const base = "reports/515880.SS/2026-07-30-v7";
  const rawPath = `${base}/5_portfolio/decision.md`;
  let invalidated = false;
  const auditRequests = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes(`/${base}/report_manifest.json`)) {
      return Response.json({
        ticker: "515880.SS",
        tradeDate: "2026-07-30",
        auditStatus: "verified",
        analysisStatus: "rated",
        claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
      });
    }
    if (value.includes("/data/report-audit.json")) {
      auditRequests.push({ value, init });
      return Response.json({
        reports: [{
          report: `${base}/complete_report.md`,
          auditStatus: invalidated ? "invalidated" : "verified",
          analysisStatus: "rated",
          claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
        }],
      });
    }
    if (value.includes(`/${rawPath}`)) {
      return new Response("评级：持有", { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  try {
    const requestUrl = `https://workbench.test/api/report?path=${encodeURIComponent(rawPath)}`;
    const allowed = await getReport({ request: new Request(requestUrl) });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("cache-control"), "no-store");

    invalidated = true;
    const denied = await getReport({ request: new Request(requestUrl) });
    assert.equal(denied.status, 409);
    assert.equal(auditRequests.length, 2);
    assert.ok(auditRequests.every(({ value }) => value.includes("__tw_no_cache=")));
    assert.ok(auditRequests.every(({ init }) => init.headers?.["cache-control"] === "no-cache"));
    assert.ok(auditRequests.every(({ init }) => init.cf?.cacheTtl === 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("daily analysis workflow passes validated research controls without weakening its lock", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/daily-analysis.yml", import.meta.url),
    "utf8",
  );
  for (const input of [
    "tickers",
    "requestId",
    "analysts",
    "researchDepth",
    "profileId",
    "slotId",
    "scheduledFor",
  ]) {
    assert.match(workflow, new RegExp(`^\\s{6}${input}:`, "m"));
  }
  assert.match(workflow, /inputs\.requestId/);
  assert.match(workflow, /inputs\.profileId/);
  assert.match(workflow, /inputs\.slotId/);
  assert.match(workflow, /inputs\.scheduledFor/);
  assert.match(workflow, /TRADINGAGENTS_ANALYSTS:\s*\$\{\{\s*inputs\.analysts/);
  assert.match(workflow, /TRADINGAGENTS_MAX_DEBATE_ROUNDS:/);
  assert.match(workflow, /TRADINGAGENTS_MAX_RISK_ROUNDS:/);
  assert.match(workflow, /concurrency:\r?\n(?:  .*\r?\n)*  cancel-in-progress: false/);
});

test("an invalid access header is rejected before parsing a malformed body", async () => {
  const response = await analyze({ request: post("{not-json", "wrong"), env });
  assert.equal(response.status, 401);
});

test("settings and analysis reject oversized request bodies", async () => {
  const body = JSON.stringify({ tickers: ["NVDA"], padding: "x".repeat(65 * 1024) });
  const [analysisResponse, settingsResponse] = await Promise.all([
    analyze({ request: post(body), env }),
    saveSettings({ request: post(body), env }),
  ]);
  assert.equal(analysisResponse.status, 413);
  assert.equal(settingsResponse.status, 413);
});

test("legacy settings POST keeps its missing GitHub token response", async () => {
  const response = await saveSettings({
    request: post(JSON.stringify({ tickers: ["SPY"], settings: defaultSettings() })),
    env: { ACCESS_CODE: "correct-code" },
  });
  const payload = await response.json();
  assert.equal(response.status, 500);
  assert.equal(payload.error, "服务端未配置 GITHUB_DISPATCH_TOKEN");
});

test("legacy ticker-only saves merge into the current v2 settings without losing metadata", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  let currentReads = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("raw.githubusercontent.com")) {
      currentReads += 1;
      return Response.json(defaultSettings());
    }
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const response = await saveSettings({
      request: post(JSON.stringify({ tickers: ["spy", "000001"] })),
      env,
    });
    const payload = await response.json();
    const persisted = JSON.parse(dispatch.inputs.settings_json);
    assert.equal(response.status, 202);
    assert.equal(currentReads, 1);
    assert.deepEqual(payload.settings.tickers, ["SPY", "000001.SZ"]);
    assert.equal(persisted.profiles[0].id, "cn-semi-comms");
    assert.equal(persisted.profiles[0].objective.includes("传导影响"), true);
    assert.deepEqual(
      persisted.profiles[0].targets.filter((target) => target.analysis === "signal"),
      defaultSettings().profiles[0].targets.filter((target) => target.analysis === "signal"),
    );
    assert.deepEqual(persisted.profiles[0].systemBenchmarks, defaultSettings().profiles[0].systemBenchmarks);
    assert.equal(JSON.stringify(dispatch).includes("correct-code"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saving full-analysis tickers from the v2 page preserves signal targets and profile metadata", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  globalThis.fetch = async (_url, init) => {
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const response = await saveSettings({
      request: post(JSON.stringify({ tickers: ["515880", "512480"], settings: defaultSettings() })),
      env,
    });
    const payload = await response.json();
    const persisted = JSON.parse(dispatch.inputs.settings_json);
    assert.equal(response.status, 202);
    assert.equal(persisted.profiles[0].id, "cn-semi-comms");
    assert.equal(persisted.profiles[0].objective.includes("传导影响"), true);
    assert.deepEqual(
      persisted.profiles[0].targets.filter((target) => target.analysis === "signal"),
      defaultSettings().profiles[0].targets.filter((target) => target.analysis === "signal"),
    );
    assert.deepEqual(persisted.profiles[0].systemBenchmarks, defaultSettings().profiles[0].systemBenchmarks);
    assert.deepEqual(payload.settings.tickers, ["515880.SS", "512480.SS"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saving the primary profile leaves every other profile and target ownership unchanged", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  globalThis.fetch = async (_url, init) => {
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  const settings = defaultSettings();
  const secondProfile = structuredClone(settings.profiles[0]);
  secondProfile.id = "second-profile";
  secondProfile.name = "第二研究目标";
  secondProfile.targets = [
    { symbol: "SPY", name: "SPY", market: "US", role: "core", analysis: "full" },
    { symbol: "QQQ", name: "QQQ", market: "US", role: "benchmark", analysis: "signal" },
  ];
  settings.profiles.push(secondProfile);

  try {
    const response = await saveSettings({
      request: post(JSON.stringify({ tickers: ["515880", "512480"], settings })),
      env,
    });
    const persisted = JSON.parse(dispatch.inputs.settings_json);
    const primaryFullSymbols = persisted.profiles[0].targets
      .filter((target) => target.analysis === "full")
      .map((target) => target.symbol);

    assert.equal(response.status, 202);
    assert.deepEqual(primaryFullSymbols, ["515880.SS", "512480.SS"]);
    assert.deepEqual(persisted.profiles[1], secondProfile);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saving an existing signal symbol does not promote it to full analysis", async () => {
  const originalFetch = globalThis.fetch;
  let dispatch;
  globalThis.fetch = async (_url, init) => {
    dispatch = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const response = await saveSettings({
      request: post(JSON.stringify({ tickers: ["515880", "NVDA"], settings: defaultSettings() })),
      env,
    });
    const payload = await response.json();
    const [profile] = JSON.parse(dispatch.inputs.settings_json).profiles;
    const signalTargets = profile.targets.filter((target) => target.analysis === "signal");
    const nvda = profile.targets.find((target) => target.symbol === "NVDA");

    assert.equal(response.status, 202);
    assert.equal(signalTargets.length, 11);
    assert.equal(nvda.role, "driver");
    assert.equal(nvda.analysis, "signal");
    assert.deepEqual(payload.settings.tickers, ["515880.SS"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
