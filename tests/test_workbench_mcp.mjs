import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOLS,
  callTool,
  handleJsonRpc,
} from "../scripts/workbench-mcp.mjs";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("MCP exposes exactly the five planned read-only tools", () => {
  assert.deepEqual(
    TOOLS.map(({ name }) => name),
    [
      "list_monitor_profiles",
      "get_monitor_snapshot",
      "get_market_bars",
      "search_market_news",
      "get_research_run",
    ],
  );
  assert.equal(
    TOOLS.some(({ name }) => /(run|write|save|delete|analyze)/i.test(name) && name !== "get_research_run"),
    false,
  );
});

test("market and news tools validate inputs and issue GET-only requests", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ status: "ok", data: { rows: [] }, sources: [] });
  };

  await callTool(
    "get_market_bars",
    { symbol: "GOOGL", timeframe: "1d", limit: 1260 },
    { baseUrl: "https://board.example/", fetchImpl },
  );
  await callTool(
    "search_market_news",
    { symbol: "3887.HK", importance: "high", limit: 20 },
    { baseUrl: "https://board.example/", fetchImpl },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ init }) => init.method === "GET"), true);
  assert.match(calls[0].url, /\/api\/market\?/);
  assert.match(calls[0].url, /symbol=GOOGL/);
  assert.match(calls[0].url, /timeframe=1d/);
  assert.match(calls[1].url, /\/api\/news\?/);
  assert.match(calls[1].url, /symbol=3887.HK/);
  await assert.rejects(
    () => callTool(
      "get_market_bars",
      { symbol: "GOOGL", timeframe: "tick", limit: 5000 },
      { baseUrl: "https://board.example/", fetchImpl },
    ),
    /timeframe/,
  );
});

test("research tool joins history with audit state without mutating the workbench", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, method: init.method });
    if (parsed.pathname === "/data/history.json") {
      return jsonResponse([
        {
          trade_date: "2026-07-24",
          generated_at: "2026-07-25T08:00:00Z",
          provider: "openai_compatible",
          results: [
            {
              ticker: "GOOGL",
              rating: "Not Rated",
              report: "reports/GOOGL/2026-07-24-v2/complete_report.md",
              analysis_status: "insufficient_evidence",
            },
          ],
        },
      ]);
    }
    if (parsed.pathname === "/data/report-audit.json") {
      return jsonResponse({
        reports: [
          {
            ticker: "GOOGL",
            tradeDate: "2026-07-24",
            report: "reports/GOOGL/2026-07-24-v2/complete_report.md",
            auditStatus: "legacy_unverified",
          },
        ],
      });
    }
    throw new Error(`unexpected request ${parsed.pathname}`);
  };

  const result = await callTool(
    "get_research_run",
    { symbol: "GOOGL", tradeDate: "2026-07-24" },
    { baseUrl: "https://board.example/", fetchImpl },
  );

  assert.equal(result.result.analysis_status, "insufficient_evidence");
  assert.equal(result.audit.auditStatus, "legacy_unverified");
  assert.equal(result.reportUrl, "https://board.example/reports/GOOGL/2026-07-24-v2/complete_report.md");
  assert.equal(calls.every(({ method }) => method === "GET"), true);
});

test("read-only GET retries one transient network failure", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("temporary connect failure");
    return jsonResponse({ version: 2, profiles: [] });
  };

  const result = await callTool(
    "list_monitor_profiles",
    {},
    { baseUrl: "https://board.example/", fetchImpl },
  );

  assert.equal(attempts, 2);
  assert.equal(result.version, 2);
});

test("JSON-RPC initialize and tools/list stay protocol-compatible", async () => {
  const initialized = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(initialized.result.serverInfo.name, "trading-workbench-readonly");
  assert.equal(initialized.result.capabilities.tools.listChanged, false);

  const listed = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.equal(listed.result.tools.length, 5);

  const rejected = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "run_deep_analysis", arguments: {} },
  });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /unknown read-only tool/);
});
