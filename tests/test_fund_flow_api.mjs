import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FakeD1 } from "./helpers/fake_d1.mjs";
import { SqliteD1 } from "./helpers/sqlite_d1.mjs";

const flowsApi = await import("../functions/api/flows.js").catch(() => null);

const ALL_CAPABILITIES = {
  marketFlowV1: true,
  marginDaily: true,
  etfSharesDaily: true,
  historicalPercentile: true,
};

function request(path) {
  return new Request(`https://workbench.test${path}`);
}

function flow(overrides = {}) {
  return {
    id: "flow-1",
    profile_id: "cn-semi",
    symbol: "515880.SS",
    flow_type: "margin_balance",
    period: "1d",
    ts: "2026-07-27T00:00:00.000Z",
    value: 123456,
    unit: "CNY",
    currency: "CNY",
    source: "exchange",
    method: "reported",
    as_of: "2026-07-27T00:00:00.000Z",
    fetched_at: "2026-07-27T01:00:00.000Z",
    freshness: "fresh",
    adjustment: "none",
    quality: "good",
    expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("fund-flow endpoint module exists", () => {
  assert.ok(flowsApi);
});

test("Pages enables the fund-flow capability after migration and production smoke", () => {
  const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /\[vars\][\s\S]*FUND_FLOW_ENABLED\s*=\s*"true"/);
});

test("disabled fund-flow feature returns an explicit unavailable envelope without D1 access", async () => {
  if (!flowsApi) return;
  for (const FUND_FLOW_ENABLED of [undefined, "false", false, 1]) {
    const DB = new FakeD1({ fail: true });
    const response = await flowsApi.onRequestGet({
      request: request("/api/flows?symbol=515880.SS"),
      env: { DB, FUND_FLOW_ENABLED },
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(payload, {
      status: "unavailable",
      asOf: null,
      data: [],
      sources: [],
      reason: "feature_disabled",
      capabilities: {
        marketFlowV1: false,
        marginDaily: false,
        etfSharesDaily: false,
        historicalPercentile: false,
      },
      cursor: null,
    });
    assert.equal(DB.calls.length, 0);
  }
});

test("fund-flow capabilities follow the explicit symbol allowlists", async () => {
  if (!flowsApi) return;
  const cases = [
    ["515880.SS", ALL_CAPABILITIES],
    ["512480.SS", ALL_CAPABILITIES],
    ["159995.SZ", ALL_CAPABILITIES],
    ["SPY", {
      marketFlowV1: true,
      marginDaily: false,
      etfSharesDaily: false,
      historicalPercentile: false,
    }],
  ];
  for (const [symbol, capabilities] of cases) {
    const DB = new FakeD1();
    const response = await flowsApi.onRequestGet({
      request: request(`/api/flows?symbol=${symbol}`),
      env: { DB, FUND_FLOW_ENABLED: "true" },
    });
    const payload = await response.json();
    assert.deepEqual(payload.capabilities, capabilities);
    assert.deepEqual(payload.data, []);
  }
});

test("fund-flow feature accepts the boolean true used by local bindings", async () => {
  if (!flowsApi) return;
  const DB = new FakeD1();
  const response = await flowsApi.onRequestGet({
    request: request("/api/flows?symbol=515880.SS"),
    env: { DB, FUND_FLOW_ENABLED: true },
  });
  assert.equal(DB.calls.length, 1);
  assert.deepEqual((await response.json()).capabilities, ALL_CAPABILITIES);
});

test("fund-flow endpoint parameterizes every supported filter", async () => {
  if (!flowsApi) return;
  const source = "exchange-cn";
  const DB = new FakeD1({ rows: { fund_flows: [flow({ source })] } });
  const response = await flowsApi.onRequestGet({
    request: request(`/api/flows?symbol=515880.ss&profile=cn-semi&type=margin_balance&period=1d&source=${source}&from=2026-07-26&to=2026-07-28&limit=25`),
    env: { DB, FUND_FLOW_ENABLED: "true" },
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.status, "ok");
  assert.deepEqual(payload.data, [flow({ source })]);
  assert.deepEqual(payload.capabilities, ALL_CAPABILITIES);
  const [{ sql, params }] = DB.calls;
  assert.equal(sql.includes(source), false);
  for (const column of ["symbol", "profile_id", "flow_type", "period", "source"]) {
    assert.match(sql, new RegExp(`${column}\\s*=\\s*\\?`, "i"));
  }
  assert.match(sql, /ts\s*>=\s*\?/i);
  assert.match(sql, /ts\s*<=\s*\?/i);
  assert.deepEqual(params.slice(0, 7), [
    "515880.SS",
    "cn-semi",
    "margin_balance",
    "1d",
    source,
    "2026-07-26T00:00:00.000Z",
    "2026-07-28T00:00:00.000Z",
  ]);
  assert.equal(typeof params[7], "string");
  assert.equal(params[8], 25);
});

test("fund-flow endpoint rejects unsupported, unknown, and inconsistent parameters before D1", async () => {
  if (!flowsApi) return;
  const DB = new FakeD1();
  const paths = [
    "/api/flows?type=unknown",
    "/api/flows?period=5m",
    "/api/flows?symbol=SPY%27%20OR%201%3D1--",
    "/api/flows?source=exchange%27%20OR%201%3D1--",
    "/api/flows?after=not-a-cursor",
    "/api/flows?from=2026-07-28&to=2026-07-27",
    "/api/flows?timeframe=1d",
  ];
  for (const path of paths) {
    const response = await flowsApi.onRequestGet({
      request: request(path),
      env: { DB, FUND_FLOW_ENABLED: "true" },
    });
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).status, "unavailable");
  }
  assert.equal(DB.calls.length, 0);
});

test("fund-flow type applicability permits snapshot fallback but rejects unavailable derived history", async () => {
  if (!flowsApi) return;
  const fallbackDB = new FakeD1({ rows: { fund_flows: [flow({
    symbol: "515880.SS",
    flow_type: "shares_outstanding_snapshot",
  })] } });
  const fallbackResponse = await flowsApi.onRequestGet({
    request: request("/api/flows?symbol=515880.SS&type=shares_outstanding_snapshot"),
    env: { DB: fallbackDB, FUND_FLOW_ENABLED: "true" },
  });
  assert.equal((await fallbackResponse.json()).data.length, 1);

  const rejectedDB = new FakeD1({ rows: { fund_flows: [flow({
    symbol: "159995.SZ",
    flow_type: "shares_outstanding_derived",
  })] } });
  const rejectedResponse = await flowsApi.onRequestGet({
    request: request("/api/flows?symbol=159995.SZ&type=shares_outstanding_derived"),
    env: { DB: rejectedDB, FUND_FLOW_ENABLED: "true" },
  });
  assert.deepEqual((await rejectedResponse.json()).data, []);
  assert.equal(rejectedDB.calls.length, 0);
});

test("fund-flow endpoint pages equal timestamps with a composite [ts,id] cursor", async (t) => {
  if (!flowsApi) return;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  }
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0016_fund_flows.sql", import.meta.url), "utf8"));
  const insert = sqlite.prepare(`
    INSERT INTO fund_flows (
      id, profile_id, symbol, flow_type, ts, value, unit, currency, source,
      as_of, fetched_at, freshness, quality, expires_at
    ) VALUES (?, 'cn-semi', '515880.SS', ?, ?, 1, 'CNY', 'CNY',
      'exchange', ?, ?, 'fresh', 'good', '2099-01-01T00:00:00.000Z')
  `);
  const oldTs = "2026-07-26T00:00:00.000Z";
  insert.run("flow-old", "margin_balance", oldTs, oldTs, oldTs);
  const ts = "2026-07-27T00:00:00.000Z";
  const types = [
    "fund_scale",
    "margin_balance",
    "margin_buy",
    "margin_net_buy",
    "shares_outstanding_derived",
  ];
  for (let index = 1; index <= types.length; index += 1) {
    insert.run(`flow-${index}`, types[index - 1], ts, ts, ts);
  }
  const DB = new SqliteD1(sqlite);
  const seen = [];
  let after = oldTs;
  for (let page = 0; page < 3; page += 1) {
    const response = await flowsApi.onRequestGet({
      request: request(`/api/flows?symbol=515880.SS&limit=2&after=${encodeURIComponent(after)}`),
      env: { DB, FUND_FLOW_ENABLED: "true" },
    });
    const payload = await response.json();
    seen.push(...payload.data.map(({ id }) => id));
    after = payload.cursor;
  }
  assert.deepEqual(seen, ["flow-1", "flow-2", "flow-3", "flow-4", "flow-5"]);
  assert.equal(after, `[\"${ts}\",\"flow-5\"]`);
});

test("fund-flow endpoint excludes expired rows and fails soft for missing, empty, or failing D1", async () => {
  if (!flowsApi) return;
  const DB = new FakeD1({ rows: { fund_flows: [
    flow({ id: "expired", expires_at: "2000-01-01T00:00:00.000Z" }),
    flow({ id: "active", value: 999 }),
  ] } });
  const activeResponse = await flowsApi.onRequestGet({
    request: request("/api/flows?symbol=515880.SS"),
    env: { DB, FUND_FLOW_ENABLED: "true" },
  });
  assert.deepEqual((await activeResponse.json()).data.map(({ id }) => id), ["active"]);

  for (const env of [
    { FUND_FLOW_ENABLED: "true" },
    { FUND_FLOW_ENABLED: "true", DB: new FakeD1() },
    { FUND_FLOW_ENABLED: "true", DB: new FakeD1({ fail: true }) },
  ]) {
    const response = await flowsApi.onRequestGet({
      request: request("/api/flows?symbol=515880.SS"),
      env,
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(payload.status, "unavailable");
    assert.deepEqual(payload.data, []);
    assert.deepEqual(payload.sources, []);
    assert.deepEqual(payload.capabilities, ALL_CAPABILITIES);
    assert.equal(payload.cursor, null);
  }
});
