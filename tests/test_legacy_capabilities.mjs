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
    assert.equal(dispatched.inputs.tickers, "515880.SS,512480.SS");
    assert.equal(dispatched.inputs.analysts, "market,news,fundamentals");
    assert.equal(dispatched.inputs.researchDepth, "standard");
    assert.equal(
      dispatched.inputs.requestId,
      "",
      "legacy monitor-combination runs must not enter the ad-hoc workload guard",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production workflows scope secrets and deploy the latest main under one lock", () => {
  const daily = readFileSync(rootFile(".github/workflows/daily-analysis.yml"), "utf8");
  const deploy = readFileSync(rootFile(".github/workflows/deploy-workbench.yml"), "utf8");
  const requested = readFileSync(rootFile(".github/workflows/analysis-request.yml"), "utf8");
  const ci = readFileSync(rootFile(".github/workflows/ci.yml"), "utf8");

  assert.match(daily, /^permissions:\r?\n  contents: read$/m);
  assert.match(ci, /^permissions:\r?\n  contents: read$/m);

  const dailyAnalysis = daily.match(
    /^  analyze-and-persist:[\s\S]*?(?=^  deploy-github-pages:)/m,
  )?.[0] || "";
  assert.match(dailyAnalysis, /permissions:\r?\n      contents: write/);
  assert.doesNotMatch(
    dailyAnalysis.slice(0, dailyAnalysis.indexOf("    steps:")),
    /\$\{\{\s*secrets\./,
  );
  assert.match(
    dailyAnalysis,
    /Run multi-agent analysis[\s\S]*?EVIDENCE_API_URL:\s*https:\/\/tradingagents-board\.pages\.dev\/api\/v1\/evidence/,
  );
  assert.match(
    dailyAnalysis,
    /name:\s*Run multi-agent analysis[\s\S]*?id:\s*analysis[\s\S]*?continue-on-error:\s*true/,
  );
  assert.match(
    dailyAnalysis,
    /name:\s*Persist reports to main[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/,
  );
  assert.match(
    dailyAnalysis,
    /name:\s*Fail when analysis failed[\s\S]*?steps\.analysis\.outcome == 'failure'/,
  );

  assert.doesNotMatch(daily, /^  deploy-cloudflare:/m);
  assert.doesNotMatch(daily, /wrangler@[\d.]+ pages deploy/);
  assert.doesNotMatch(daily, /persist_reports\.sh[^\r\n]*\[skip ci\]/);

  const deployHeader = deploy.slice(0, deploy.indexOf("    steps:"));
  assert.doesNotMatch(deployHeader, /\$\{\{\s*secrets\./);
  assert.match(
    deploy,
    /uses: actions\/checkout@v4\r?\n        with:\r?\n(?:          #.*\r?\n)*          ref: main/,
  );
  assert.match(
    deploy,
    /concurrency:\r?\n  group: cloudflare-workbench\r?\n  cancel-in-progress: false/,
  );

  assert.match(
    requested,
    /concurrency:\r?\n  group: report-analysis-persistence\r?\n  cancel-in-progress: false/,
  );
  assert.match(requested, /^permissions:\r?\n  contents: read$/m);
  const requestedAnalysis = requested.match(
    /^  analyze-request:[\s\S]*?(?=^  deploy-github-pages:)/m,
  )?.[0] || "";
  assert.match(
    requestedAnalysis,
    /permissions:\r?\n      contents: write\r?\n      issues: write/,
  );
  assert.doesNotMatch(requestedAnalysis, /^\s+pages: write$/m);
  assert.doesNotMatch(requestedAnalysis, /^\s+id-token: write$/m);
  assert.doesNotMatch(
    requested.slice(0, requested.indexOf("    steps:")),
    /\$\{\{\s*secrets\./,
  );
  const requestedGitHubPages = requested.match(
    /^  deploy-github-pages:[\s\S]*$/m,
  )?.[0] || "";
  assert.match(
    requestedGitHubPages,
    /permissions:\r?\n      contents: read\r?\n      pages: write\r?\n      id-token: write/,
  );
  assert.doesNotMatch(requested, /^  deploy-cloudflare:/m);
  assert.doesNotMatch(requested, /wrangler@[\d.]+ pages deploy/);
  assert.doesNotMatch(requested, /persist_reports\.sh[^\r\n]*\[skip ci\]/);
});
