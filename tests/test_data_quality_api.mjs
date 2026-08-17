import assert from "node:assert/strict";
import test from "node:test";

import * as catalogApi from "../functions/api/data-catalog.js";
import * as universeApi from "../functions/api/universe.js";
import { fetchCnUniverse } from "../scripts/update-universe.mjs";

function request(path) {
  return new Request(`https://workbench.test${path}`);
}

test("data catalog identifies the external 1092-stock table as reference only", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    version: 1,
    generatedAt: "2026-08-18T00:00:00.000Z",
    externalReferences: [{
      id: "external-stock-signal-features",
      stockCount: 1092,
      productionSource: false,
      note: "外部系统内部股票池，不代表全市场",
    }],
    sources: [],
    datasets: [],
  }), { status: 200 }));

  const response = await catalogApi.onRequestGet();
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.externalReferences[0].productionSource, false);
  assert.match(payload.externalReferences[0].note, /内部股票池.*不代表全市场/);
});

test("universe summary exposes current coverage without downloading instrument rows", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    version: 1,
    generatedAt: "2026-08-18T00:00:00.000Z",
    status: "degraded",
    coverage: {
      cnCurrentListed: 5896,
      usCore: 9,
      hkCore: 1,
      historicalDelisted: "unavailable",
    },
    sources: [{ id: "eastmoney-clist", quality: "best_effort" }],
    instruments: [{ symbol: "000001.SZ" }],
  }), { status: 200 }));

  const response = await universeApi.onRequestGet({
    request: request("/api/universe?summary=1"),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.status, "degraded");
  assert.equal(payload.coverage.cnCurrentListed, 5896);
  assert.equal(payload.coverage.historicalDelisted, "unavailable");
  assert.deepEqual(payload.data, []);
});

test("universe filtering reports the full match count before applying the response limit", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    status: "degraded",
    instruments: [
      { symbol: "000001.SZ", market: "CN" },
      { symbol: "000002.SZ", market: "CN" },
      { symbol: "NVDA", market: "US" },
    ],
  }), { status: 200 }));

  const response = await universeApi.onRequestGet({
    request: request("/api/universe?market=CN&limit=1"),
  });
  const payload = await response.json();
  assert.equal(payload.data.length, 1);
  assert.equal(payload.totalMatched, 2);
});

test("universe refresh uses the bounded Eastmoney current-listed contract", async () => {
  let requestedUrl;
  const instruments = await fetchCnUniverse(async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({
      data: {
        total: 1,
        diff: {
          0: { f12: "000001", f13: 0, f14: "平安银行", f100: "银行", f26: "19910403" },
        },
      },
    }), { status: 200 });
  });

  assert.equal(requestedUrl.hostname, "82.push2.eastmoney.com");
  assert.equal(requestedUrl.searchParams.get("pz"), "100");
  assert.equal(requestedUrl.searchParams.get("np"), "2");
  assert.ok(requestedUrl.searchParams.get("ut"));
  assert.equal(instruments[0].symbol, "000001.SZ");
});
