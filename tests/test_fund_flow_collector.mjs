import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  aggregateConstituentMargin,
  collectFundFlows,
  fetchBoundedJson,
  fundHoldingsUrl,
  marginUrl,
  parseLatestTopHoldings,
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
        SPJ: 2,
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

function holdingsPayload(code, entries = [
  { code: "300502", name: "新易盛", weight: 15.6 },
  { code: "300308", name: "中际旭创", weight: 14.61 },
  { code: "601138", name: "工业富联", weight: 9.12 },
  { code: "600487", name: "亨通光电", weight: 6.89 },
  { code: "300394", name: "天孚通信", weight: 6.33 },
  { code: "600522", name: "中天科技", weight: 5.3 },
  { code: "002281", name: "光迅科技", weight: 3.98 },
  { code: "000063", name: "中兴通讯", weight: 3.73 },
  { code: "300136", name: "信维通信", weight: 3.69 },
  { code: "600105", name: "永鼎股份", weight: 2.52 },
]) {
  const rows = entries.map((entry, index) => `<tr><td>${index + 1}</td><td><a href='//quote.eastmoney.com/unify/r/0.${entry.code}'>${entry.code}</a></td><td class='tol'><a href='//quote.eastmoney.com/unify/r/0.${entry.code}'>${entry.name}</a></td><td class='tor'><span></span></td><td class='tor'><span></span></td><td class='xglj'>资讯</td><td class='tor'>${entry.weight}%</td></tr>`).join("");
  const html = `<div><a href='http://fund.eastmoney.com/${code}.html'>${code}</a>截止至：<font class='px12'>2026-06-30</font><table><tbody>${rows}</tbody></table></div>`;
  return `var apidata={ content:${JSON.stringify(html)}, arryear:[2026], curyear:2026 };`;
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

  const holdings = new URL(fundHoldingsUrl("515880"));
  assert.equal(holdings.hostname, "fundf10.eastmoney.com");
  assert.equal(holdings.searchParams.get("type"), "jjcc");
  assert.equal(holdings.searchParams.get("code"), "515880");
  assert.equal(holdings.searchParams.get("topline"), "10");
});

test("parsers retain negative financing, exact CNY units, and derived inputs", () => {
  const margin = parseMarginPage(marginPayload("515880"), "515880");
  assert.equal(margin.rows.length, 1);
  assert.equal(margin.rows[0].values.margin_net_buy, -50_000);
  assert.equal(margin.rows[0].ts, "2026-07-23T16:00:00.000Z");
  assert.equal(margin.rows[0].close, 2);

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

  const basket = parseLatestTopHoldings(holdingsPayload("515880", [
    { code: "300502", name: "新易盛", weight: 15.6 },
    { code: "300308", name: "中际旭创", weight: 14.61 },
  ]), "515880", 2);
  assert.equal(basket.disclosedAt, "2026-06-30");
  assert.deepEqual(basket.holdings, [
    { code: "300502", name: "新易盛", weightPct: 15.6 },
    { code: "300308", name: "中际旭创", weightPct: 14.61 },
  ]);
  assert.throws(() => parseLatestTopHoldings(holdingsPayload("515880", [
    { code: "300502", name: "新易盛", weight: 15.6 },
    { code: "300502", name: "新易盛", weight: 15.6 },
  ]), "515880", 2), /UPSTREAM_SCHEMA/);
});

test("margin rows preserve the Shanghai trade date and reject weekend ghosts", () => {
  const friday = parseMarginPage(marginPayload("515880"), "515880").rows[0];
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(friday.ts));
  const values = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  assert.equal(`${values.year}-${values.month}-${values.day}`, "2026-07-24");
  assert.equal(values.weekday, "Fri");

  const weekend = marginPayload("515880");
  weekend.result.data[0].DATE = "2026-07-26 00:00:00";
  assert.throws(() => parseMarginPage(weekend, "515880"), /UPSTREAM_SCHEMA/);
});

test("constituent aggregation aligns dates, keeps signs, and rejects thin coverage", () => {
  const basket = parseLatestTopHoldings(holdingsPayload("515880", [
    { code: "300502", name: "新易盛", weight: 15.6 },
    { code: "300308", name: "中际旭创", weight: 14.61 },
    { code: "601138", name: "工业富联", weight: 9.12 },
  ]), "515880", 3);
  const first = parseMarginPage(marginPayload("300502"), "300502").rows;
  const second = parseMarginPage({
    ...marginPayload("300308"),
    result: {
      ...marginPayload("300308").result,
      data: [{ ...marginPayload("300308").result.data[0], RZYE: 2_000_000, RZJME: 75_000 }],
    },
  }, "300308").rows;
  const aggregated = aggregateConstituentMargin(basket, new Map([
    ["300502", [...first, ...first]],
    ["300308", second],
  ]), { minCoverageRatio: 2 / 3 });
  assert.equal(aggregated.holdingCount, 3);
  assert.equal(aggregated.rows.length, 1);
  assert.equal(aggregated.rows[0].values.constituent_margin_balance, 3_000_000);
  assert.equal(aggregated.rows[0].values.constituent_margin_net_buy, 25_000);
  assert.equal(aggregated.rows[0].coverage.constituent_margin_net_buy, 2);

  const rejected = aggregateConstituentMargin(basket, new Map([["300502", first]]));
  assert.deepEqual(rejected.rows, []);
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
    if (url.hostname === "fundf10.eastmoney.com") {
      return new Response(holdingsPayload(url.searchParams.get("code")));
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
      const code = url.searchParams.get("secid").split(".")[1];
      return Response.json({
        rc: 0,
        data: { f57: code, f43: 1000, f84: 5_000_000, f116: 5_000_000 },
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

  assert.equal(result.written, 22);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.profiles, ["enabled"]);
  const writeCalls = d1Calls.filter(({ body }) => /INSERT INTO fund_flows/.test(body.sql));
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0].body.sql, /FROM json_each\(\?\)/);
  assert.match(writeCalls[0].body.sql, /excluded\.fetched_at >= fund_flows\.fetched_at/);
  assert.match(writeCalls[0].body.sql, /fund_flows\.quality NOT LIKE '%_partial'/);
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
  assert.equal(rows.some(({ flowType, value, source, method, quality }) =>
    flowType === "constituent_margin_net_buy"
    && value === -500_000
    && source === "eastmoney-constituent-margin"
    && /@2026-06-30;coverage=10\/10$/.test(method)
    && quality === "current_top_10_approximation"), true);
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

test("blocked SSE history degrades to a current share snapshot without losing margin rows", async () => {
  const settings = { version: 2, profiles: [profile("enabled", true, ["515880.SS"])] };
  const writes = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "api.cloudflare.com") {
      const body = JSON.parse(init.body);
      if (/SELECT settings_json/.test(body.sql)) {
        return Response.json({ success: true, result: [{ results: [{ settings_json: JSON.stringify(settings) }] }] });
      }
      writes.push(...JSON.parse(body.params[0]));
      return Response.json({ success: true, result: [{ success: true }] });
    }
    if (url.hostname === "datacenter-web.eastmoney.com") {
      const code = /SCODE="(\d{6})"/.exec(url.searchParams.get("filter"))[1];
      return Response.json(marginPayload(code));
    }
    if (url.hostname === "fundf10.eastmoney.com") {
      return new Response(holdingsPayload(url.searchParams.get("code")));
    }
    if (url.hostname === "query.sse.com.cn") return new Response("blocked", { status: 403 });
    if (url.hostname === "push2delay.eastmoney.com") {
      return Response.json({ rc: 0, data: { f57: "515880", f43: 2000, f84: 5_000_000, f116: 10_000_000 } });
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

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.failures, [{
    symbol: "515880.SS",
    source: "sse-fund-scale-daily",
    reason: "UPSTREAM_BLOCKED",
  }]);
  assert.equal(writes.some(({ flowType }) => flowType === "margin_net_buy"), true);
  assert.equal(writes.some(({ flowType }) => flowType === "shares_outstanding_snapshot"), true);
  assert.equal(writes.some(({ flowType }) => flowType === "shares_outstanding_derived"), false);
});

test("one ETF margin failure does not discard other symbols or constituent aggregates", async () => {
  const settings = { version: 2, profiles: [profile("enabled", true, ["515880.SS", "512480.SS"])] };
  const writes = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "api.cloudflare.com") {
      const body = JSON.parse(init.body);
      if (/SELECT settings_json/.test(body.sql)) {
        return Response.json({ success: true, result: [{ results: [{ settings_json: JSON.stringify(settings) }] }] });
      }
      writes.push(...JSON.parse(body.params[0]));
      return Response.json({ success: true, result: [{ success: true }] });
    }
    if (url.hostname === "datacenter-web.eastmoney.com") {
      const code = /SCODE="(\d{6})"/.exec(url.searchParams.get("filter"))[1];
      if (code === "515880") throw new Error("network down");
      return Response.json(marginPayload(code));
    }
    if (url.hostname === "fundf10.eastmoney.com") return new Response(holdingsPayload(url.searchParams.get("code")));
    if (url.hostname === "query.sse.com.cn") return Response.json(scalePayload(url.searchParams.get("FUND_CODE")));
    if (url.hostname === "push2delay.eastmoney.com") {
      const code = url.searchParams.get("secid").split(".")[1];
      return Response.json({ rc: 0, data: { f57: code, f43: 1000, f84: 5_000_000, f116: 5_000_000 } });
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

  assert.equal(result.status, "degraded");
  assert.equal(result.failures.some(({ symbol, source }) => (
    symbol === "515880.SS" && source === "eastmoney-margin-daily"
  )), true);
  assert.equal(writes.some(({ symbol, flowType }) => (
    symbol === "512480.SS" && flowType === "margin_net_buy"
  )), true);
  assert.equal(writes.some(({ symbol, flowType }) => (
    symbol === "515880.SS" && flowType === "constituent_margin_net_buy"
  )), true);
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

test("fund-flow workflow schedules a daily collection only after production smoke", async () => {
  const workflow = await readFile(".github/workflows/fund-flow.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\s*\r?\n\s+- cron:\s*"17 12 \* \* 1-5"/);
  assert.match(workflow, /timeout-minutes:\s*15/);
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read/);
  assert.match(workflow, /concurrency:\s*\r?\n\s+group:\s*fund-flow/);
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' \|\| vars\.FUND_FLOW_COLLECTION_ENABLED != 'false'/,
  );
  assert.match(workflow, /github\.event_name == 'schedule' && 'daily' \|\| inputs\.mode/);
  assert.doesNotMatch(workflow, /EVIDENCE|report_manifests|VolGuard/i);
});
