import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  queryEvidencePacket,
  upsertEvidenceBundle,
} from "../functions/api/_d1_repository.mjs";
import { onRequestGet, onRequestPost } from "../functions/api/evidence.js";
import { SqliteD1 } from "./helpers/sqlite_d1.mjs";

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

async function evidenceD1(t) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return null;
  }
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "../migrations/0011_evidence_packets.sql",
    "../migrations/0014_chat_evidence_scope.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
  }
  const DB = new SqliteD1(sqlite);
  DB.batch = (statements) => Promise.all(statements.map((statement) => statement.run()));
  return { sqlite, DB };
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

test("evidence packets with the same symbol are isolated by exact profile scope", async (t) => {
  const fixture = await evidenceD1(t);
  if (!fixture) return;
  const packetA = validPacket("GOOGL");
  const packetB = {
    ...validPacket("GOOGL"),
    generatedAt: "2026-07-24T20:06:00Z",
    contentHash: "b".repeat(64),
  };
  const legacyPacket = {
    ...validPacket("GOOGL"),
    generatedAt: "2026-07-24T20:07:00Z",
    contentHash: "c".repeat(64),
  };
  const expiresAt = "2099-01-01T00:00:00.000Z";

  await upsertEvidenceBundle(fixture.DB, {
    packet: packetA,
    identity: {
      scope: "profile",
      profileId: "profile-a",
      requestId: null,
      slotId: "slot-a",
      runId: "run-a",
    },
    expiresAt,
  });
  await upsertEvidenceBundle(fixture.DB, {
    packet: packetB,
    identity: {
      scope: "profile",
      profileId: "profile-b",
      requestId: null,
      slotId: "slot-b",
      runId: "run-b",
    },
    expiresAt,
  });
  await upsertEvidenceBundle(fixture.DB, {
    packet: legacyPacket,
    identity: {
      scope: "legacy",
      profileId: null,
      requestId: null,
      slotId: null,
      runId: null,
    },
    expiresAt,
  });

  const rowA = await queryEvidencePacket(fixture.DB, {
    symbol: "GOOGL",
    scope: "profile",
    profileId: "profile-a",
    asOf: "2026-07-25T00:00:00.000Z",
  });
  const rowB = await queryEvidencePacket(fixture.DB, {
    symbol: "GOOGL",
    scope: "profile",
    profileId: "profile-b",
    asOf: "2026-07-25T00:00:00.000Z",
  });
  const missing = await queryEvidencePacket(fixture.DB, {
    symbol: "GOOGL",
    scope: "profile",
    profileId: "profile-c",
    asOf: "2026-07-25T00:00:00.000Z",
  });
  assert.equal(rowA.content_hash, packetA.contentHash);
  assert.equal(rowB.content_hash, packetB.contentHash);
  assert.equal(missing, null);
  assert.notEqual(rowA.id, rowB.id);
});

test("profile evidence API does not fall back to another profile or legacy rows", async (t) => {
  const fixture = await evidenceD1(t);
  if (!fixture) return;
  const packet = validPacket("GOOGL");
  await upsertEvidenceBundle(fixture.DB, {
    packet,
    identity: {
      scope: "profile",
      profileId: "profile-b",
      requestId: null,
      slotId: null,
      runId: "run-b",
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await upsertEvidenceBundle(fixture.DB, {
    packet: { ...packet, contentHash: "d".repeat(64) },
    identity: {
      scope: "legacy",
      profileId: null,
      requestId: null,
      slotId: null,
      runId: null,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  });

  const response = await onRequestGet({
    request: request("/api/evidence?symbol=GOOGL&profile=profile-a", {
      authorization: "Bearer read-token",
    }),
    env: { EVIDENCE_READ_TOKEN: "read-token", DB: fixture.DB },
  });
  const body = await response.json();
  assert.equal(body.status, "unavailable");
  assert.equal(body.data, null);
});

test("legacy, adhoc, and global evidence reads require their explicit selectors", async (t) => {
  const fixture = await evidenceD1(t);
  if (!fixture) return;
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const expiresAt = "2099-01-01T00:00:00.000Z";
  for (const [identity, contentHash] of [
    [{
      scope: "legacy",
      profileId: null,
      requestId: null,
      slotId: null,
      runId: null,
    }, "1".repeat(64)],
    [{
      scope: "adhoc",
      profileId: null,
      requestId,
      slotId: null,
      runId: "run-adhoc",
    }, "2".repeat(64)],
    [{
      scope: "global",
      profileId: null,
      requestId: null,
      slotId: null,
      runId: "run-global",
    }, "3".repeat(64)],
  ]) {
    await upsertEvidenceBundle(fixture.DB, {
      packet: { ...validPacket("GOOGL"), contentHash },
      identity,
      expiresAt,
    });
  }

  const env = { EVIDENCE_READ_TOKEN: "read-token", DB: fixture.DB };
  for (const [selector, expectedHash] of [
    ["", "1".repeat(64)],
    [`&requestId=${requestId}`, "2".repeat(64)],
    ["&scope=global", "3".repeat(64)],
  ]) {
    const response = await onRequestGet({
      request: request(`/api/evidence?symbol=GOOGL&depth=full${selector}`, {
        authorization: "Bearer read-token",
      }),
      env,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.contentHash, expectedHash);
  }
});

test("adhoc and global evidence scopes remain explicit and reject profile absorption", async () => {
  const packet = validPacket();
  for (const identity of [
    {
      scope: "adhoc",
      profileId: "profile-a",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      slotId: null,
    },
    {
      scope: "global",
      profileId: "profile-a",
      requestId: null,
      slotId: null,
    },
  ]) {
    const response = await onRequestPost({
      request: new Request("https://example.test/api/evidence", {
        method: "POST",
        headers: { authorization: "Bearer write-token" },
        body: JSON.stringify({ packet, identity }),
      }),
      env: {
        EVIDENCE_WRITE_TOKEN: "write-token",
        DB: fakeWriterDb([]),
      },
    });
    assert.equal(response.status, 400);
  }

  const ambiguousRead = await onRequestGet({
    request: request(
      "/api/evidence?symbol=GOOGL&profile=profile-a&requestId=123e4567-e89b-42d3-a456-426614174000",
      { authorization: "Bearer read-token" },
    ),
    env: {
      EVIDENCE_READ_TOKEN: "read-token",
      DB: fakeDb(null, "GOOGL"),
    },
  });
  assert.equal(ambiguousRead.status, 400);
});

test("report and evidence identities must describe the same owner", async () => {
  const packet = validPacket();
  const response = await onRequestPost({
    request: new Request("https://example.test/api/evidence", {
      method: "POST",
      headers: { authorization: "Bearer write-token" },
      body: JSON.stringify({
        packet,
        report: "reports/GOOGL/2026-07-24/complete_report.md",
        manifest: {
          schemaVersion: 1,
          ticker: "GOOGL",
          tradeDate: "2026-07-24",
          generatedAt: packet.generatedAt,
          analysisStatus: "rated",
          auditStatus: "verified",
          evidence: { contentHash: packet.contentHash },
          identity: {
            scope: "profile",
            profileId: "profile-b",
            requestId: null,
            slotId: null,
            runId: "run-b",
          },
        },
        identity: {
          scope: "profile",
          profileId: "profile-a",
          requestId: null,
          slotId: null,
          runId: "run-a",
        },
      }),
    }),
    env: {
      EVIDENCE_WRITE_TOKEN: "write-token",
      DB: fakeWriterDb([]),
    },
  });
  assert.equal(response.status, 400);
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

test("evidence API rejects semantically invalid market bars before D1", async () => {
  for (const bar of [
    { ts: "2026-07-24T20:00:00Z", close: "NaN" },
    { ts: "2026-07-24T20:00:00Z", close: "Infinity" },
    { ts: "not-a-time", close: 192.1 },
    { ts: "2026-07-24T20:00:00Z", close: 192.1, volume: -1 },
    {
      ts: "2026-07-24T20:00:00Z",
      open: -1,
      high: 193,
      low: 191,
      close: 192.1,
      volume: 1,
    },
    {
      ts: "2026-07-24T20:00:00Z",
      open: 192,
      high: 190,
      low: 191,
      close: 192.1,
      volume: 1,
    },
  ]) {
    const calls = [];
    const packet = { ...validPacket(), bars: [bar] };
    const response = await onRequestPost({
      request: new Request("https://example.test/api/evidence", {
        method: "POST",
        headers: { authorization: "Bearer write-token" },
        body: JSON.stringify({ packet }),
      }),
      env: {
        EVIDENCE_WRITE_TOKEN: "write-token",
        DB: fakeWriterDb(calls),
      },
    });

    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  }
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
