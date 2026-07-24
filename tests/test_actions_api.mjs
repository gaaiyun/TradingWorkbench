import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { onRequestPost as analyze } from "../functions/api/analyze.js";
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an invalid access header is rejected before parsing a malformed body", async () => {
  const response = await analyze({ request: post("{not-json", "wrong"), env });
  assert.equal(response.status, 401);
});

test("settings and analysis reject oversized request bodies", async () => {
  const body = JSON.stringify({ tickers: ["NVDA"], padding: "x".repeat(17 * 1024) });
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
