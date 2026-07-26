import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as settingsApi from "../functions/api/settings.js";
import { writeSettingsToD1 } from "../functions/api/_d1_repository.mjs";
import { FakeD1 } from "./helpers/fake_d1.mjs";

const staticSettings = JSON.parse(
  readFileSync(new URL("../public/data/workbench-settings.json", import.meta.url), "utf8"),
);

function writeRequest(method, body, code = "correct-code") {
  return new Request("https://workbench.test/api/settings", {
    method,
    headers: {
      "content-type": "application/json",
      "x-access-code": code,
    },
    body: JSON.stringify(body),
  });
}

const put = (body, code) => writeRequest("PUT", body, code);
const post = (body, code) => writeRequest("POST", body, code);

function settingsRow(settings, updatedAt = "2026-07-23T00:00:00.000Z") {
  return {
    version: settings.version,
    settings_json: JSON.stringify(settings),
    updated_at: updatedAt,
  };
}

const MAXIMAL_TARGET_SYMBOLS = [
  "AAAAA", "AAAAB", "AAAAC", "AAAAD", "AAAAE", "AAAAF", "AAAAG",
  "AAAAH", "AAAAI", "AAAAJ", "AAAAK", "AAAAL", "AAAAM", "AAAAN",
];

function largeEightProfileSettings({ objectiveBytes = 200 } = {}) {
  const template = structuredClone(staticSettings.profiles[0]);
  const windows = Array.from({ length: 8 }, (_, index) => {
    const hour = String(index * 2).padStart(2, "0");
    const endHour = String(index * 2 + 1).padStart(2, "0");
    return { start: `${hour}:00`, end: `${endHour}:00` };
  });
  return {
    version: 2,
    profiles: Array.from({ length: 8 }, (_, profileIndex) => ({
      ...structuredClone(template),
      id: `profile-${profileIndex + 1}`.padEnd(64, "x"),
      name: "n".repeat(96),
      objective: "o".repeat(objectiveBytes),
      timezone: "America/Argentina/Buenos_Aires",
      targets: MAXIMAL_TARGET_SYMBOLS.map((symbol) => ({
        symbol,
        name: "t".repeat(96),
        market: "M".repeat(16),
        role: "core",
        analysis: "full",
      })),
      systemBenchmarks: Array.from({ length: 12 }, (_, benchmarkIndex) => ({
        id: `${benchmarkIndex}`.padEnd(64, "b"),
        name: "b".repeat(96),
        market: "M".repeat(16),
      })),
      schedules: {
        ...structuredClone(template.schedules),
        newsRefresh: { enabled: true, intervalMinutes: 60 },
        cnIntraday: {
          ...structuredClone(template.schedules.cnIntraday),
          windows,
        },
      },
    })),
  };
}

test("PUT persists v1 settings in D1 and GET reads the normalized value immediately", async () => {
  assert.equal(typeof settingsApi.onRequestPut, "function");
  const DB = new FakeD1();
  const env = { DB, ACCESS_CODE: "correct-code" };

  const saved = await settingsApi.onRequestPut({
    request: put({ settings: { version: 1, tickers: ["spy", "600519"] }, expectedUpdatedAt: null }),
    env,
  });
  const savePayload = await saved.json();
  const loaded = await settingsApi.onRequestGet({ env });
  const loadPayload = await loaded.json();

  assert.equal(saved.status, 200);
  assert.equal(savePayload.ok, true);
  assert.equal(savePayload.settings.version, 2);
  assert.deepEqual(savePayload.settings.tickers, ["SPY", "600519.SS"]);
  assert.equal(loaded.status, 200);
  assert.equal(loadPayload.version, 2);
  assert.equal(loadPayload.updatedAt, savePayload.updatedAt);
  assert.deepEqual(
    loadPayload.profiles[0].targets.map(({ symbol }) => symbol),
    ["SPY", "600519.SS"],
  );
  assert.equal(DB.calls.some(({ sql }) => /INSERT\s+INTO\s+workbench_settings/i.test(sql)), true);
  assert.equal(JSON.stringify(DB.calls).includes("correct-code"), false);
});

test("the first D1 PUT may omit a revision for compatibility", async () => {
  const DB = new FakeD1();
  const response = await settingsApi.onRequestPut({
    request: put({ settings: { version: 1, tickers: ["SPY"] } }),
    env: { DB, ACCESS_CODE: "correct-code" },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.revision, payload.updatedAt);
  assert.deepEqual(payload.settings.tickers, ["SPY"]);
});

test("a full PUT over existing D1 settings requires the observed revision", async () => {
  const initialUpdatedAt = "2026-07-23T00:00:00.000Z";
  const DB = new FakeD1({ settings: settingsRow(staticSettings, initialUpdatedAt) });
  const response = await settingsApi.onRequestPut({
    request: put({ settings: staticSettings }),
    env: { DB, ACCESS_CODE: "correct-code" },
  });
  const payload = await response.json();

  assert.equal(response.status, 428);
  assert.equal(payload.error_code, "SETTINGS_REVISION_REQUIRED");
  assert.equal(payload.revision, initialUpdatedAt);
  assert.equal(payload.settings.version, 2);
  assert.equal(DB.settings.updated_at, initialUpdatedAt);
});

test("legacy POST with a D1 binding updates D1 and GET immediately observes the new settings", async () => {
  const DB = new FakeD1({ settings: settingsRow(staticSettings) });
  const env = {
    DB,
    ACCESS_CODE: "correct-code",
    GITHUB_DISPATCH_TOKEN: "must-not-be-used",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("D1-backed POST must not dispatch GitHub");
  };
  try {
    const saved = await settingsApi.onRequestPost({
      request: post({ tickers: ["SPY"], settings: staticSettings }),
      env,
    });
    const loaded = await settingsApi.onRequestGet({ env });
    const payload = await loaded.json();

    assert.equal(saved.status, 200);
    assert.deepEqual(payload.profiles[0].targets
      .filter(({ analysis }) => analysis === "full")
      .map(({ symbol }) => symbol), ["SPY"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("D1 write failures never report a successful GitHub fallback", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 204 });
  };
  const env = {
    DB: new FakeD1({ fail: true }),
    ACCESS_CODE: "correct-code",
    GITHUB_DISPATCH_TOKEN: "dispatch-token",
  };
  try {
    const [putResponse, postResponse] = await Promise.all([
      settingsApi.onRequestPut({
        request: put({ settings: { version: 1, tickers: ["SPY"] }, expectedUpdatedAt: null }),
        env,
      }),
      settingsApi.onRequestPost({
        request: post({ tickers: ["SPY"], settings: staticSettings }),
        env,
      }),
    ]);
    assert.equal(putResponse.status, 503);
    assert.equal(postResponse.status, 503);
    assert.equal((await putResponse.json()).error_code, "SETTINGS_STORAGE_UNAVAILABLE");
    assert.equal((await postResponse.json()).error_code, "SETTINGS_STORAGE_UNAVAILABLE");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings writes enforce expectedUpdatedAt and leave the winning value intact on conflict", async () => {
  const initialUpdatedAt = "2026-07-23T00:00:00.000Z";
  const DB = new FakeD1({ settings: settingsRow(staticSettings, initialUpdatedAt) });
  const env = { DB, ACCESS_CODE: "correct-code" };

  const conflict = await settingsApi.onRequestPut({
    request: put({
      settings: { version: 1, tickers: ["SPY"] },
      expectedUpdatedAt: "2026-07-22T00:00:00.000Z",
    }),
    env,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error_code, "SETTINGS_CONFLICT");
  assert.equal(DB.settings.updated_at, initialUpdatedAt);

  const saved = await settingsApi.onRequestPut({
    request: put({
      settings: { version: 1, tickers: ["SPY"] },
      expectedUpdatedAt: initialUpdatedAt,
    }),
    env,
  });
  assert.equal(saved.status, 200);
  assert.notEqual((await saved.json()).updatedAt, initialUpdatedAt);
});

test("D1 revisions remain strictly monotonic when repeated writes share a fixed clock", async () => {
  const initialUpdatedAt = "2026-07-23T00:00:00.000Z";
  const fixedNow = new Date(initialUpdatedAt);
  const DB = new FakeD1({ settings: settingsRow(staticSettings, initialUpdatedAt) });

  const first = await writeSettingsToD1(DB, staticSettings, initialUpdatedAt, fixedNow);
  const second = await writeSettingsToD1(DB, staticSettings, first, fixedNow);
  const third = await writeSettingsToD1(DB, staticSettings, second, fixedNow);

  assert.deepEqual(
    [first, second, third],
    [
      "2026-07-23T00:00:00.001Z",
      "2026-07-23T00:00:00.002Z",
      "2026-07-23T00:00:00.003Z",
    ],
  );
  assert.equal(DB.settings.updated_at, third);
});

test("PUT and legacy POST accept an explicit large eight-profile document below 64 KiB", async () => {
  const settings = largeEightProfileSettings();
  const putBody = { settings, revision: "2026-07-23T00:00:00.000Z" };
  const encodedBytes = new TextEncoder().encode(JSON.stringify(putBody)).byteLength;
  assert.ok(encodedBytes > 16 * 1024);
  assert.ok(encodedBytes < 64 * 1024);

  const putDB = new FakeD1({ settings: settingsRow(staticSettings) });
  const putResponse = await settingsApi.onRequestPut({
    request: put(putBody),
    env: { DB: putDB, ACCESS_CODE: "correct-code" },
  });
  const putPayload = await putResponse.json();

  const postDB = new FakeD1({ settings: settingsRow(staticSettings) });
  const postResponse = await settingsApi.onRequestPost({
    request: post({
      settings,
      tickers: MAXIMAL_TARGET_SYMBOLS.slice(0, 10),
      revision: "2026-07-23T00:00:00.000Z",
    }),
    env: { DB: postDB, ACCESS_CODE: "correct-code" },
  });
  const postPayload = await postResponse.json();

  assert.equal(putResponse.status, 200, JSON.stringify(putPayload));
  assert.equal(putPayload.settings.profiles.length, 8);
  assert.equal(postResponse.status, 200);
  assert.equal(postPayload.settings.profiles.length, 8);
});

test("a response-shaped bare v2 PUT is a full replacement even when it contains tickers", async () => {
  const initialUpdatedAt = "2026-07-23T00:00:00.000Z";
  const DB = new FakeD1({ settings: settingsRow(staticSettings, initialUpdatedAt) });
  const submitted = structuredClone(staticSettings);
  submitted.profiles[0].name = "裸 V2 PUT 已修改";

  const response = await settingsApi.onRequestPut({
    request: put({ ...submitted, tickers: ["SPY"], revision: initialUpdatedAt }),
    env: { DB, ACCESS_CODE: "correct-code" },
  });
  const payload = await response.json();
  const persisted = JSON.parse(DB.settings.settings_json);

  assert.equal(response.status, 200);
  assert.equal(payload.settings.profiles[0].name, "裸 V2 PUT 已修改");
  assert.deepEqual(payload.settings.tickers, ["515880.SS", "512480.SS"]);
  assert.equal(persisted.profiles[0].name, "裸 V2 PUT 已修改");
  assert.equal(Object.hasOwn(persisted, "revision"), false);
  assert.equal(Object.hasOwn(persisted, "tickers"), false);
});

test("response-shaped and wrapped full PUTs require revision and never become legacy updates", async () => {
  const initialUpdatedAt = "2026-07-23T00:00:00.000Z";
  const missingDB = new FakeD1({ settings: settingsRow(staticSettings, initialUpdatedAt) });
  const missing = await settingsApi.onRequestPut({
    request: put({ ...staticSettings, tickers: ["SPY"] }),
    env: { DB: missingDB, ACCESS_CODE: "correct-code" },
  });
  assert.equal(missing.status, 428);
  assert.equal((await missing.json()).error_code, "SETTINGS_REVISION_REQUIRED");
  assert.equal(missingDB.settings.updated_at, initialUpdatedAt);

  const wrapped = structuredClone(staticSettings);
  wrapped.profiles[0].name = "包装完整 PUT";
  const wrappedDB = new FakeD1({ settings: settingsRow(staticSettings, initialUpdatedAt) });
  const wrappedResponse = await settingsApi.onRequestPut({
    request: put({
      settings: wrapped,
      tickers: ["SPY"],
      revision: initialUpdatedAt,
    }),
    env: { DB: wrappedDB, ACCESS_CODE: "correct-code" },
  });
  const wrappedPayload = await wrappedResponse.json();
  assert.equal(wrappedResponse.status, 200);
  assert.equal(wrappedPayload.settings.profiles[0].name, "包装完整 PUT");
  assert.deepEqual(wrappedPayload.settings.tickers, ["515880.SS", "512480.SS"]);

  const legacyDB = new FakeD1({ settings: settingsRow(staticSettings, initialUpdatedAt) });
  const legacyResponse = await settingsApi.onRequestPut({
    request: put({ tickers: ["SPY"], revision: initialUpdatedAt }),
    env: { DB: legacyDB, ACCESS_CODE: "correct-code" },
  });
  const legacyPayload = await legacyResponse.json();
  assert.equal(legacyResponse.status, 200);
  assert.deepEqual(legacyPayload.settings.tickers, ["SPY"]);
});

test("PUT and legacy POST reject a normalized settings document above the total byte cap", async () => {
  const oversizedSettings = largeEightProfileSettings({ objectiveBytes: 512 });
  const requestBytes = new TextEncoder().encode(JSON.stringify({
    settings: oversizedSettings,
    revision: "2026-07-23T00:00:00.000Z",
  })).byteLength;
  assert.ok(requestBytes < 64 * 1024);

  const putDB = new FakeD1({ settings: settingsRow(staticSettings) });
  const putResponse = await settingsApi.onRequestPut({
    request: put({
      settings: oversizedSettings,
      revision: "2026-07-23T00:00:00.000Z",
    }),
    env: { DB: putDB, ACCESS_CODE: "correct-code" },
  });
  assert.equal(putResponse.status, 400);
  assert.equal((await putResponse.json()).error_code, "SETTINGS_TOO_LARGE");
  assert.equal(putDB.settings.updated_at, "2026-07-23T00:00:00.000Z");

  const postDB = new FakeD1({ settings: settingsRow(staticSettings) });
  const postResponse = await settingsApi.onRequestPost({
    request: post({
      settings: oversizedSettings,
      tickers: MAXIMAL_TARGET_SYMBOLS.slice(0, 10),
      revision: "2026-07-23T00:00:00.000Z",
    }),
    env: { DB: postDB, ACCESS_CODE: "correct-code" },
  });
  assert.equal(postResponse.status, 400);
  assert.equal((await postResponse.json()).error_code, "SETTINGS_TOO_LARGE");
  assert.equal(postDB.settings.updated_at, "2026-07-23T00:00:00.000Z");
});

test("GET falls back to the static GitHub settings when D1 is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return Response.json(staticSettings);
  };
  try {
    const response = await settingsApi.onRequestGet({ env: { DB: new FakeD1({ fail: true }) } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), staticSettings);
    assert.match(requestedUrl, /data\/workbench-settings\.json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PUT falls back to the existing GitHub persistence path when D1 is absent", async () => {
  const originalFetch = globalThis.fetch;
  let dispatchBody;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("raw.githubusercontent.com")) return Response.json(staticSettings);
    dispatchBody = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  try {
    const response = await settingsApi.onRequestPut({
      request: put({ settings: { version: 1, tickers: ["nvda"] } }),
      env: {
        ACCESS_CODE: "correct-code",
        GITHUB_DISPATCH_TOKEN: "dispatch-token",
      },
    });
    assert.equal(response.status, 202);
    assert.equal(JSON.parse(dispatchBody.inputs.settings_json).version, 2);
    assert.equal(JSON.stringify(dispatchBody).includes("correct-code"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
