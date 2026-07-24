import assert from "node:assert/strict";
import test from "node:test";

import { onRequestGet } from "../functions/api/evidence.js";

function request(url, headers = {}) {
  return new Request(`https://example.test${url}`, { headers });
}

function fakeDb(row, expectedSymbol = null) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              assert.match(sql, /evidence_packets/i);
              if (expectedSymbol) assert.equal(params[0], expectedSymbol);
              return row;
            },
          };
        },
      };
    },
  };
}

test("evidence API returns a point-in-time packet and supports HK normalization", async () => {
  const packet = {
    schemaVersion: "EvidencePacketV1",
    status: "ok",
    asOf: "2026-07-23T08:00:00Z",
    instrument: { symbol: "3887.HK", assetType: "hk_equity" },
    sources: [{ source: "hkexnews", sourceTier: "evidence" }],
    contentHash: "abc",
  };
  const response = await onRequestGet({
    request: request("/api/evidence?symbol=03887&asOf=2026-07-24T00:00:00Z&depth=summary"),
    env: { DB: fakeDb({
      symbol: "3887.HK",
      as_of: "2026-07-23T08:00:00Z",
      status: "ok",
      packet_json: JSON.stringify(packet),
    }, "3887.HK") },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.data.instrument.symbol, "3887.HK");
  assert.deepEqual(body.sources, packet.sources);
});

test("evidence API requires the configured read token and returns unavailable without a packet", async () => {
  const denied = await onRequestGet({
    request: request("/api/evidence?symbol=GOOGL", { authorization: "Bearer wrong" }),
    env: { EVIDENCE_READ_TOKEN: "right", DB: fakeDb(null, "GOOGL") },
  });
  assert.equal(denied.status, 401);

  const missing = await onRequestGet({
    request: request("/api/evidence?symbol=GOOGL"),
    env: { DB: fakeDb(null, "GOOGL") },
  });
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).status, "unavailable");
});
