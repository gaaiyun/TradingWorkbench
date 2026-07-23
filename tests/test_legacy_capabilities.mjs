import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { onRequestPost as analyze } from "../functions/api/analyze.js";
import { onRequestGet as volguard } from "../functions/api/volguard.js";

const rootFile = (path) => new URL(`../${path}`, import.meta.url);

test("options monitor remains deployed as a dedicated product with a local fallback API", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/live")) {
      return Response.json({ schema_version: 2, source_status: { overall: "healthy" } });
    }
    return Response.json({ schema_version: 1 });
  };
  try {
    const response = await volguard({
      env: {
        VOLGUARD_LIVE_URL: "https://options.test/live",
        VOLGUARD_SNAPSHOT_URL: "https://options.test/snapshot",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-volguard-mode"), "live");
    assert.equal((await response.json()).schema_version, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TradingAgents core, CLI, report reader, and scheduled workflow remain present", () => {
  for (const path of [
    "tradingagents/graph/trading_graph.py",
    "cli/main.py",
    "scripts/run_daily.py",
    "functions/api/analyze.js",
    "functions/api/latest.js",
    "functions/api/report.js",
    "functions/api/history.js",
    ".github/workflows/daily-analysis.yml",
    ".github/workflows/analysis-request.yml",
  ]) {
    assert.equal(existsSync(rootFile(path)), true, `${path} must remain available`);
  }

  const graph = readFileSync(rootFile("tradingagents/graph/trading_graph.py"), "utf8");
  const workflow = readFileSync(rootFile(".github/workflows/daily-analysis.yml"), "utf8");
  assert.match(graph, /class TradingAgentsGraph/);
  assert.match(workflow, /scripts\/run_daily\.py/);
});

test("manual analysis still dispatches the TradingAgents workflow", async () => {
  const originalFetch = globalThis.fetch;
  let dispatched = null;
  globalThis.fetch = async (_url, init) => {
    dispatched = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const request = new Request("https://workbench.test/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-code": "correct-code" },
      body: JSON.stringify({ tickers: ["515880.SS", "512480.SS"] }),
    });
    const response = await analyze({
      request,
      env: {
        ACCESS_CODE: "correct-code",
        GITHUB_DISPATCH_TOKEN: "dispatch-token",
      },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(dispatched.inputs, { tickers: "515880.SS,512480.SS" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
