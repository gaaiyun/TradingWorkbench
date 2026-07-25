import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { onRequestPost as analyze } from "../functions/api/analyze.js";
import { onRequestGet as listRuns } from "../functions/api/runs.js";
import { onRequestPost as saveSettings } from "../functions/api/settings.js";

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
