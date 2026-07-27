import assert from "node:assert/strict";
import test from "node:test";

import {
  collectSseFundNews,
  sseSearchUrl,
} from "../scripts/collect-sse-fund-news.mjs";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "test-token-must-never-appear-in-errors";
const NOW = new Date("2026-07-28T01:00:00.000Z");

function profile(id, enabled, symbols) {
  return {
    id,
    name: id,
    objective: `${id} objective`,
    enabled,
    timezone: "Asia/Shanghai",
    targets: symbols.map((symbol) => ({
      symbol,
      name: symbol,
      market: "CN",
      role: "core",
      analysis: "full",
    })),
    systemBenchmarks: [],
    schedules: {
      usCloseSnapshot: { enabled: true, time: "05:35" },
      preMarketBrief: { enabled: true, time: "08:25" },
      newsRefresh: { enabled: true, intervalMinutes: 60 },
      cnIntraday: {
        enabled: true,
        windows: [
          { start: "09:30", end: "11:30" },
          { start: "13:00", end: "15:00" },
        ],
        collectionIntervalMinutes: 5,
        signalIntervalMinutes: 15,
      },
      closeDeepAnalysis: { enabled: true, time: "15:20" },
    },
    alerts: {
      channels: { web: true, pushPlus: false },
      pushMinSeverity: "high",
      quietHours: { start: "22:30", end: "07:30" },
    },
    agentBudget: {
      intradayLightSummariesPerDay: 3,
      fullAnalysesPerDay: 1,
    },
  };
}

function ssePayload(code) {
  return `TradingWorkbenchSse(${JSON.stringify({
    code: "0",
    data: {
      originKeyword: code,
      knowledgeList: [{
        title: `${code} 基金公告`,
        createTime: "2026-07-27 08:30:00",
        extend: [{
          name: "CURL",
          value: `/disclosure/fund/announcement/c/new/2026-07-27/${code}_official.pdf`,
        }],
      }],
    },
  })})`;
}

test("official SSE search uses an exact code and a bounded 30-day window", () => {
  const result = sseSearchUrl("515880", NOW);
  const url = new URL(result.url);
  assert.equal(url.hostname, "query.sse.com.cn");
  assert.equal(url.searchParams.get("keyword"), "515880");
  assert.equal(url.searchParams.get("searchMode"), "preciseMulti");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(result.begin, "2026-06-28");
  assert.equal(result.end, "2026-07-28");
});

test("official SSE collector fans out only to enabled profiles and parameterizes the D1 write", async () => {
  const settings = {
    version: 2,
    profiles: [
      profile("both", true, ["515880.SS", "512480.SS"]),
      profile("semi-only", true, ["512480.SS"]),
      profile("disabled", false, ["515880.SS"]),
    ],
  };
  const d1Calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "api.cloudflare.com") {
      const body = JSON.parse(init.body);
      d1Calls.push({ headers: init.headers, body });
      if (/SELECT settings_json/.test(body.sql)) {
        return Response.json({
          success: true,
          result: [{ results: [{ settings_json: JSON.stringify(settings) }] }],
        });
      }
      return Response.json({ success: true, result: [{ success: true }] });
    }
    const code = url.searchParams.get("keyword");
    return new Response(ssePayload(code), {
      status: 200,
      headers: { "content-type": "text/javascript" },
    });
  };

  const result = await collectSseFundNews({
    apiToken: API_TOKEN,
    accountId: ACCOUNT_ID,
    now: NOW,
    fetchImpl,
  });

  assert.deepEqual(result.symbols, { "515880.SS": 1, "512480.SS": 1 });
  assert.equal(result.written, 3);
  assert.equal(d1Calls.length, 2);
  assert.deepEqual(d1Calls[0].body.params, [1]);
  assert.match(d1Calls[1].body.sql, /FROM json_each\(\?\)/);
  assert.equal(d1Calls[1].body.params.length, 1);
  const rows = JSON.parse(d1Calls[1].body.params[0]);
  assert.deepEqual(
    rows.map(({ profileId, symbol }) => `${profileId}:${symbol}`).sort(),
    ["both:512480.SS", "both:515880.SS", "semi-only:512480.SS"],
  );
  assert.equal(rows.every(({ sourceTier }) => sourceTier === "evidence"), true);
  assert.equal(rows.every(({ publisher }) => publisher === "上海证券交易所"), true);
  assert.equal(rows.every(({ url }) =>
    /^https:\/\/www\.sse\.com\.cn\/disclosure\/fund\/announcement\//.test(url)), true);
  assert.equal(d1Calls.every(({ headers }) =>
    headers.authorization === `Bearer ${API_TOKEN}`), true);
});

test("official SSE collector rejects invalid account IDs before network access", async () => {
  let called = false;
  await assert.rejects(
    collectSseFundNews({
      apiToken: API_TOKEN,
      accountId: "../invalid",
      fetchImpl: async () => {
        called = true;
        throw new Error("unexpected network call");
      },
    }),
    /CLOUDFLARE_ACCOUNT_ID_INVALID/,
  );
  assert.equal(called, false);
});

test("D1 failures expose only the status code, never the API token", async () => {
  const error = await collectSseFundNews({
    apiToken: API_TOKEN,
    accountId: ACCOUNT_ID,
    fetchImpl: async () => new Response("denied", { status: 403 }),
  }).then(() => null, (reason) => reason);
  assert.match(error.message, /D1_QUERY_FAILED_403/);
  assert.equal(error.message.includes(API_TOKEN), false);
});
