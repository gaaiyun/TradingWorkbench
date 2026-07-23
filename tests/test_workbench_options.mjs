import assert from "node:assert/strict";
import test from "node:test";

import {
  OPTIONS_FAST_REFRESH_MS,
  OPTIONS_SLOW_REFRESH_MS,
  normalizeVolguardPayload,
} from "../public/assets/workbench-options.mjs";

test("VolGuard payload keeps quote and model clocks separate", () => {
  const view = normalizeVolguardPayload({
    schema_version: 2,
    generated_at: "2026-07-24T10:15:00+08:00",
    market: {
      symbol: "510050.SS",
      spot: 3.12,
      change_pct: 1.25,
      data_asof: "2026-07-24T10:14:48+08:00",
      options_data_asof: "2026-07-24T10:14:45+08:00",
      options_quality: { status: "fresh" },
    },
    risk: {
      hv30: 18.4,
      iv_avg: 22.1,
      var_95: 3.8,
      var_method: "GARCH(1,1)",
      bsadf_stat: 1.9,
      bsadf_cv: 2.4,
    },
    exposure: {
      gex_net: 1.2,
      dex_net: -0.4,
      pcr_oi: 0.88,
      max_pain: 3.1,
      active_contract_count: 136,
    },
    options: [
      {
        代码: "CON_OP_1",
        名称: "50ETF购7月3100",
        类型: "认购",
        到期日: "2026-07-29",
        行权价: 3.1,
        最新价: 0.08,
        隐含波动率: 21.3,
        成交量: 100,
        持仓量: 200,
      },
    ],
  }, { mode: "live" });

  assert.equal(view.mode, "live");
  assert.equal(view.quoteAsOf, "2026-07-24T10:14:48+08:00");
  assert.equal(view.modelAsOf, "2026-07-24T10:15:00+08:00");
  assert.equal(view.risk.var95, 3.8);
  assert.equal(view.exposure.pcr, 0.88);
  assert.equal(view.contractCount, 136);
  assert.deepEqual(view.options[0], {
    code: "CON_OP_1",
    name: "50ETF购7月3100",
    type: "认购",
    expiry: "2026-07-29",
    strike: 3.1,
    last: 0.08,
    iv: 21.3,
    delta: null,
    gamma: null,
    vega: null,
    theta: null,
    volume: 100,
    openInterest: 200,
    bid: null,
    ask: null,
  });
});

test("edge live schema merges fast quotes with slow risk metrics", () => {
  const view = normalizeVolguardPayload({
    schema_version: 2,
    quote_generated_at: "2026-07-24T02:15:00.000Z",
    source_asof: {
      options_latest: "2026-07-24T10:14:45+08:00",
      underlying: "2026-07-24T10:14:48+08:00",
      slow_snapshot: "2026-07-24T10:10:00+08:00",
    },
    source_status: {
      overall: "live",
      market_phase: "open",
      options: { state: "ok", contracts: 92 },
    },
    underlying: {
      symbol: "510050.SS",
      last: 3.12,
      change_pct: 1.25,
    },
    quick_metrics: {
      contract_count: 92,
      put_call_oi_ratio: 0.88,
      put_call_volume_ratio: 0.91,
      front_max_pain: 3.1,
      front_expiry: "2026-07-29",
      median_relative_spread_pct: 2.5,
    },
    contracts: [{
      code: "CON_OP_1",
      name: "50ETF认购 2026-07-29 3.100",
      option_type: "call",
      expiry: "2026-07-29",
      strike: 3.1,
      last: 0.08,
      volume: 100,
      open_interest: 200,
      bid: 0.07,
      ask: 0.08,
    }],
    slow_metrics: {
      risk: { hv30: 18.4, iv_avg: 22.1, var_95: 3.8, bsadf_stat: 1.9 },
      exposure: { gex_net: 1.2, dex_net: -0.4 },
    },
  }, { mode: "live" });

  assert.equal(view.status, "ok");
  assert.equal(view.sourceState, "live");
  assert.equal(view.quoteAsOf, "2026-07-24T10:14:48+08:00");
  assert.equal(view.optionsAsOf, "2026-07-24T10:14:45+08:00");
  assert.equal(view.modelAsOf, "2026-07-24T10:10:00+08:00");
  assert.equal(view.market.spot, 3.12);
  assert.equal(view.risk.hv30, 18.4);
  assert.equal(view.exposure.gex, 1.2);
  assert.equal(view.exposure.pcr, 0.88);
  assert.equal(view.exposure.maxPain, 3.1);
  assert.equal(view.contractCount, 92);
  assert.equal(view.options[0].type, "call");
});

test("legacy snapshots degrade explicitly without inventing unavailable Greeks", () => {
  const view = normalizeVolguardPayload({
    schema_version: 1,
    generated_at: "2026-07-09T16:05:05+08:00",
    market: { symbol: "510050.SS", spot: 3.089, data_asof: "2026-07-09T00:00:00" },
    risk: { hv30: 22.2, iv_avg: 23.5 },
    exposure: { gex_net: 1.4, dex_net: 0.09, max_pain: 3 },
    options: [{ 代码: "OLD", 名称: "旧快照", 行权价: 3, 最新价: 0.1 }],
  }, { mode: "snapshot", fallbackReason: "upstream 404" });

  assert.equal(view.status, "stale");
  assert.equal(view.mode, "snapshot");
  assert.equal(view.fallbackReason, "upstream 404");
  assert.equal(view.options[0].delta, null);
  assert.equal(view.exposure.pcr, null);
});

test("options refresh clocks preserve fast quotes and slower model work", () => {
  assert.equal(OPTIONS_FAST_REFRESH_MS, 30_000);
  assert.equal(OPTIONS_SLOW_REFRESH_MS, 5 * 60_000);
});
