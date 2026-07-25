import assert from "node:assert/strict";
import test from "node:test";

import { buildHealthPayload, checkJson } from "../functions/api/_health.mjs";

test("checkJson reports upstream status and freshness without leaking the body", async () => {
  const result = await checkJson(
    "reports",
    "https://example.test/latest.json",
    {},
    {
      fetchImpl: async () =>
        new Response(JSON.stringify({ generated_at: "2026-07-22T10:00:00Z", status: "ok", secret: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.detail, {
    generated_at: "2026-07-22T10:00:00Z",
    status: "ok",
  });
  assert.equal("secret" in result.detail, false);
});

test("checkJson converts network failures into a stable degraded result", async () => {
  const result = await checkJson("actions", "https://example.test/runs", {}, {
    fetchImpl: async () => {
      throw new TypeError("socket closed");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, "unreachable");
});

test("checkJson understands the realtime options freshness contract", async () => {
  const result = await checkJson("options_live", "https://example.test/api/live", {}, {
    fetchImpl: async () =>
      new Response(JSON.stringify({
        quote_generated_at: "2026-07-22T18:42:00+08:00",
        source_status: { overall: "market_closed" },
      }), { status: 200 }),
  });

  assert.deepEqual(result.detail, {
    generated_at: "2026-07-22T18:42:00+08:00",
    status: "market_closed",
  });
});

test("buildHealthPayload exposes booleans only and marks partial failure degraded", () => {
  const payload = buildHealthPayload(
    {
      ACCESS_CODE: "do-not-return",
      OPENAI_COMPATIBLE_API_KEY: "do-not-return",
      GITHUB_DISPATCH_TOKEN: "do-not-return",
    },
    [{ name: "reports", ok: true }, { name: "options_live", ok: false }],
    new Date("2026-07-22T10:00:00Z"),
  );

  assert.equal(payload.status, "degraded");
  assert.equal(payload.checked_at, "2026-07-22T10:00:00.000Z");
  assert.deepEqual(payload.configured, {
    access_gate: true,
    chat: true,
    analysis_dispatch: true,
    shared_conversations: false,
  });
  assert.equal(JSON.stringify(payload).includes("do-not-return"), false);
});

test("health reports D1-backed persistent conversations as available", () => {
  const payload = buildHealthPayload(
    { DB: { prepare() {} } },
    [{ name: "reports", ok: true }],
    new Date("2026-07-22T10:00:00Z"),
  );
  assert.equal(payload.configured.shared_conversations, true);
});
