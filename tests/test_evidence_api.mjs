import assert from "node:assert/strict";
import test from "node:test";

import { onRequestGet, onRequestPost } from "../functions/api/evidence.js";

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

function fakeWriterDb(calls) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const statement = { sql, params };
          calls.push(statement);
          return statement;
        },
      };
    },
    async batch(statements) {
      assert.equal(statements.length, calls.length);
      return statements.map(() => ({ success: true }));
    },
  };
}

function validPacket(symbol = "GOOGL") {
  return {
    schemaVersion: "EvidencePacketV1",
    status: "ok",
    asOf: "2026-07-24T20:00:00Z",
    generatedAt: "2026-07-24T20:05:00Z",
    instrument: { symbol, assetType: symbol.endsWith(".HK") ? "hk_equity" : "us_equity" },
    bars: [{ id: "M-001", ts: "2026-07-24T20:00:00Z", close: 192.1 }],
    corporateActions: [],
    news: [],
    sources: [{ id: "S-001", source: "yahoo", sourceTier: "discovery" }],
    integrity: { errors: [], warnings: [] },
    canRate: true,
    contentHash: "a".repeat(64),
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
    request: request(
      "/api/evidence?symbol=03887&asOf=2026-07-24T00:00:00Z&depth=summary",
      { authorization: "Bearer read-token" },
    ),
    env: {
      EVIDENCE_READ_TOKEN: "read-token",
      DB: fakeDb({
        symbol: "3887.HK",
        as_of: "2026-07-23T08:00:00Z",
        status: "ok",
        packet_json: JSON.stringify(packet),
      }, "3887.HK"),
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.data.instrument.symbol, "3887.HK");
  assert.deepEqual(body.sources, packet.sources);
});

test("evidence API fails closed when the read token is missing or invalid", async () => {
  const denied = await onRequestGet({
    request: request("/api/evidence?symbol=GOOGL", { authorization: "Bearer wrong" }),
    env: { EVIDENCE_READ_TOKEN: "right", DB: fakeDb(null, "GOOGL") },
  });
  assert.equal(denied.status, 401);

  const missing = await onRequestGet({
    request: request("/api/evidence?symbol=GOOGL"),
    env: { DB: fakeDb(null, "GOOGL") },
  });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error, "READ_NOT_CONFIGURED");
});

test("evidence API accepts only authenticated validated bundles and upserts packet plus manifest", async () => {
  const calls = [];
  const packet = validPacket("3887.HK");
  const response = await onRequestPost({
    request: new Request("https://example.test/api/evidence", {
      method: "POST",
      headers: {
        authorization: "Bearer write-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        packet,
        report: "reports/3887.HK/2026-07-24-v2/complete_report.md",
        manifest: {
          schemaVersion: 1,
          ticker: "3887.HK",
          tradeDate: "2026-07-24",
          generatedAt: "2026-07-24T20:05:00Z",
          analysisStatus: "rated",
          auditStatus: "verified",
          evidence: {
            schemaVersion: "EvidencePacketV1",
            asOf: packet.asOf,
            contentHash: packet.contentHash,
            status: "ok",
          },
        },
      }),
    }),
    env: {
      EVIDENCE_WRITE_TOKEN: "write-token",
      DB: fakeWriterDb(calls),
    },
  });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, "ok");
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /INSERT INTO evidence_packets/i);
  assert.match(calls[1].sql, /INSERT INTO report_manifests/i);
  assert.equal(calls[0].params[1], "3887.HK");
  assert.equal(calls[1].params[0], "reports/3887.HK/2026-07-24-v2/complete_report.md");
});

test("evidence API write path fails closed and rejects malformed or oversized packets", async () => {
  const packet = validPacket();
  const missingSecret = await onRequestPost({
    request: new Request("https://example.test/api/evidence", {
      method: "POST",
      body: JSON.stringify({ packet }),
    }),
    env: { DB: fakeWriterDb([]) },
  });
  assert.equal(missingSecret.status, 503);

  const denied = await onRequestPost({
    request: new Request("https://example.test/api/evidence", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({ packet }),
    }),
    env: { EVIDENCE_WRITE_TOKEN: "right", DB: fakeWriterDb([]) },
  });
  assert.equal(denied.status, 401);

  const malformed = await onRequestPost({
    request: new Request("https://example.test/api/evidence", {
      method: "POST",
      headers: { authorization: "Bearer right" },
      body: JSON.stringify({ packet: { ...packet, contentHash: "bad" } }),
    }),
    env: { EVIDENCE_WRITE_TOKEN: "right", DB: fakeWriterDb([]) },
  });
  assert.equal(malformed.status, 400);

  const oversized = await onRequestPost({
    request: new Request("https://example.test/api/evidence", {
      method: "POST",
      headers: {
        authorization: "Bearer right",
        "content-length": String(1024 * 1024 + 1),
      },
      body: "{}",
    }),
    env: { EVIDENCE_WRITE_TOKEN: "right", DB: fakeWriterDb([]) },
  });
  assert.equal(oversized.status, 413);
});

test("EvidencePacketV1 versioned entrypoint requires strict bearer auth and keeps the body limit", async () => {
  const versioned = await import("../functions/api/v1/evidence.js");
  assert.equal(typeof versioned.onRequestGet, "function");
  assert.equal(typeof versioned.onRequestPost, "function");

  const rawReadToken = await versioned.onRequestGet({
    request: request("/api/v1/evidence?symbol=GOOGL", {
      authorization: "read-token",
    }),
    env: {
      EVIDENCE_READ_TOKEN: "read-token",
      DB: fakeDb(null, "GOOGL"),
    },
  });
  assert.equal(rawReadToken.status, 401);

  const missingReadConfiguration = await versioned.onRequestGet({
    request: request("/api/v1/evidence?symbol=GOOGL"),
    env: { DB: fakeDb(null, "GOOGL") },
  });
  assert.equal(missingReadConfiguration.status, 503);
  assert.equal(
    (await missingReadConfiguration.json()).error,
    "READ_NOT_CONFIGURED",
  );

  const bearerReadToken = await versioned.onRequestGet({
    request: request("/api/v1/evidence?symbol=GOOGL", {
      authorization: "Bearer read-token",
    }),
    env: {
      EVIDENCE_READ_TOKEN: "read-token",
      DB: fakeDb(null, "GOOGL"),
    },
  });
  assert.equal(bearerReadToken.status, 200);

  const rawWriteToken = await versioned.onRequestPost({
    request: new Request("https://example.test/api/v1/evidence", {
      method: "POST",
      headers: { authorization: "write-token" },
      body: "{}",
    }),
    env: {
      EVIDENCE_WRITE_TOKEN: "write-token",
      DB: fakeWriterDb([]),
    },
  });
  assert.equal(rawWriteToken.status, 401);

  const oversized = await versioned.onRequestPost({
    request: new Request("https://example.test/api/v1/evidence", {
      method: "POST",
      headers: {
        authorization: "Bearer write-token",
        "content-length": String(1024 * 1024 + 1),
      },
      body: "{}",
    }),
    env: {
      EVIDENCE_WRITE_TOKEN: "write-token",
      DB: fakeWriterDb([]),
    },
  });
  assert.equal(oversized.status, 413);
});
