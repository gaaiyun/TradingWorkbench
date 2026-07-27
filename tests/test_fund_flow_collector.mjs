import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectFundFlows,
  fetchBoundedJson,
  marginUrl,
  parseMarginPage,
  parseShareSnapshot,
  parseSseScalePage,
  parseUnadjustedCloses,
  shareSnapshotUrl,
  sseScaleUrl,
  unadjustedCloseUrl,
} from "../scripts/collect-fund-flows.mjs";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "never-print-this-test-token";
const NOW = new Date("2026-07-28T12:30:00.000Z");

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
    agentBudget: { intradayLightSummariesPerDay: 3, fullAnalysesPerDay: 1 },
  };
}

function marginPayload(code) {
  return {
    success: true,
    code: 0,
    result: {
      pages: 1,
      count: 1,
      data: [{
        DATE: "2026-07-24 00:00:00",
        SCODE: code,
        RZYE: 1_000_000,
        RZMRE: 200_000,
        RZJME: -50_000,
      }],
    },
  };
}

function scalePayload(code) {
  return {
    result: [{
      FUND_CODE: code,
      TRADE_DATE: "2026-07-24",
      SCALE: "12.3456",
    }],
    pageHelp: { pageCount: 1, total: 1 },
  };
}

test("fund-flow URLs pin exact codes, unadjusted prices, and bounded pages", () => {
  const margin = new URL(marginUrl("515880", 2, 500));
  assert.equal(margin.hostname, "datacenter-web.eastmoney.com");
  assert.equal(margin.searchParams.get("filter"), '(SCODE="515880")');
  assert.equal(margin.searchParams.get("pageNumber"), "2");
  assert.equal(margin.searchParams.get("pageSize"), "500");

  const scale = new URL(sseScaleUrl("512480", 3, {
    begin: "20260701",
    end: "20260727",
  }));
  assert.equal(scale.hostname, "query.sse.com.cn");
  assert.equal(scale.searchParams.get("FUND_CODE"), "512480");
  assert.equal(scale.searchParams.get("pageHelp.pageNo"), "3");

  const close = new URL(unadjustedCloseUrl("1.515880", 2000));
  assert.equal(close.searchParams.get("fqt"), "0");
  assert.equal(close.searchParams.get("secid"), "1.515880");

  const shares = new URL(shareSnapshotUrl("0.159995"));
  assert.equal(shares.hostname, "push2delay.eastmoney.com");
  assert.match(shares.searchParams.get("fields"), /f84/);
});

test("parsers retain negative financing, exact CNY units, and derived inputs", () => {
  const margin = parseMarginPage(marginPayload("515880"), "515880");
  assert.equal(margin.rows.length, 1);
  assert.equal(margin.rows[0].values.margin_net_buy, -50_000);
  assert.equal(margin.rows[0].ts, "2026-07-23T16:00:00.000Z");

  const scale = parseSseScalePage(scalePayload("515880"), "515880");
  assert.equal(scale.rows[0].scaleCny, 1_234_560_000);

  const closes = parseUnadjustedCloses({
    rc: 0,
    data: { code: "515880", klines: ["2026-07-24,1,2.5,3,0.5,100"] },
  }, "515880");
  assert.equal(closes.get("2026-07-24"), 2.5);

  const snapshot = parseShareSnapshot({
    rc: 0,
    data: { f57: "159995", f43: 1278, f84: 22_806_126_080, f116: 29_146_229_130.24 },
  }, "159995", NOW);
  assert.equal(snapshot.shares, 22_806_126_080);
  assert.equal(snapshot.price, 1.278);
});

test("collector fans out only to enabled profiles and parameterizes monotonic D1 upserts", async () => {
  const settings = {
    version: 2,
    profiles: [
      profile("enabled", true, ["515880.SS", "512480.SS", "159995.SZ"]),
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
    if (url.hostname === "datacenter-web.eastmoney.com") {
      const code = /SCODE="(\d{6})"/.exec(url.searchParams.get("filter"))[1];
      return Response.json(marginPayload(code));
    }
    if (url.hostname === "query.sse.com.cn") {
      return Response.json(scalePayload(url.searchParams.get("FUND_CODE")));
    }
    if (url.hostname === "push2his.eastmoney.com") {
      const code = url.searchParams.get("secid").split(".")[1];
      return Response.json({
        rc: 0,
        data: { code, klines: ["2026-07-24,1,2,3,0.5,100"] },
      });
    }
    if (url.hostname === "push2delay.eastmoney.com") {
      return Response.json({
        rc: 0,
        data: { f57: "159995", f43: 1000, f84: 5_000_000, f116: 5_000_000 },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await collectFundFlows({
    apiToken: API_TOKEN,
    accountId: ACCOUNT_ID,
    mode: "daily",
    now: NOW,
    fetchImpl,
    delayImpl: async () => {},
    randomImpl: () => 0,
  });

  assert.equal(result.written, 14);
  assert.deepEqual(result.profiles, ["enabled"]);
  const writeCalls = d1Calls.filter(({ body }) => /INSERT INTO fund_flows/.test(body.sql));
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0].body.sql, /FROM json_each\(\?\)/);
  assert.match(writeCalls[0].body.sql, /excluded\.fetched_at >= fund_flows\.fetched_at/);
  const rows = JSON.parse(writeCalls[0].body.params[0]);
  assert.equal(rows.every(({ profileId }) => profileId === "enabled"), true);
  assert.equal(rows.some(({ flowType, value }) =>
    flowType === "margin_net_buy" && value === -50_000), true);
  assert.equal(rows.some(({ flowType, value, quality }) =>
    flowType === "shares_outstanding_derived"
    && value === 617_280_000
    && quality === "derived"), true);
  assert.equal(rows.some(({ flowType, quality }) =>
    flowType === "shares_outstanding_snapshot"
    && quality === "snapshot_unstamped"), true);
  assert.equal(d1Calls.every(({ headers }) =>
    headers.authorization === `Bearer ${API_TOKEN}`), true);
});

test("blocked sources fail immediately and errors never expose response bodies", async () => {
  let calls = 0;
  const error = await fetchBoundedJson(async () => {
    calls += 1;
    return new Response(`secret ${API_TOKEN}`, { status: 403 });
  }, marginUrl("515880"), {
    delayImpl: async () => {},
  }).then(() => null, (reason) => reason);
  assert.equal(calls, 1);
  assert.equal(error.message, "UPSTREAM_BLOCKED");
  assert.equal(error.message.includes(API_TOKEN), false);
});

test("SSE scale requests mirror the public page request shape", async () => {
  let captured;
  await fetchBoundedJson(async (_input, init) => {
    captured = init;
    return Response.json(scalePayload("515880"));
  }, sseScaleUrl("515880", 1), { delayImpl: async () => {} });

  assert.equal(captured.headers.accept, "application/json, text/javascript, */*; q=0.01");
  assert.equal(captured.headers.referer, "https://etf.sse.com.cn/fundlist/scalelist/index.shtml");
  assert.match(captured.headers["user-agent"], /^Mozilla\/5\.0/);
});

test("non-retryable HTTP 4xx fails once while 503 remains bounded", async () => {
  let calls = 0;
  await assert.rejects(fetchBoundedJson(async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  }, marginUrl("515880"), { delayImpl: async () => {} }), /UPSTREAM_HTTP_400/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(fetchBoundedJson(async () => {
    calls += 1;
    return new Response("busy", { status: 503 });
  }, marginUrl("515880"), { delayImpl: async () => {}, randomImpl: () => 0 }), /UPSTREAM_HTTP_503/);
  assert.equal(calls, 3);
});

test("fund-flow workflow is manual-only until migration and production smoke finish", async () => {
  const workflow = await readFile(".github/workflows/fund-flow.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /timeout-minutes:\s*15/);
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read/);
  assert.match(workflow, /concurrency:\s*\r?\n\s+group:\s*fund-flow/);
  assert.match(workflow, /collect-fund-flows\.mjs --mode=/);
  assert.doesNotMatch(workflow, /EVIDENCE|report_manifests|VolGuard/i);
});
