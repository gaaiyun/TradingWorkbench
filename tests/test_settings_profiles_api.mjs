import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FakeD1 } from "./helpers/fake_d1.mjs";

const [profilesIndexApi, profileApi, profileCopyApi] = await Promise.all([
  import("../functions/api/settings/profiles/index.js").catch(() => ({})),
  import("../functions/api/settings/profiles/[profileId].js").catch(() => ({})),
  import("../functions/api/settings/profiles/[profileId]/copy.js").catch(() => ({})),
]);

const staticSettings = JSON.parse(
  readFileSync(new URL("../public/data/workbench-settings.json", import.meta.url), "utf8"),
);
const INITIAL_REVISION = "2026-07-23T00:00:00.000Z";

function settingsRow(settings = staticSettings, updatedAt = INITIAL_REVISION) {
  return {
    version: settings.version,
    settings_json: JSON.stringify(settings),
    updated_at: updatedAt,
  };
}

function request(method, path, body, {
  code = "correct-code",
  includeHeader = true,
} = {}) {
  const headers = { "content-type": "application/json" };
  if (includeHeader) headers["x-access-code"] = code;
  return new Request(`https://workbench.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function context(method, path, body, {
  DB = new FakeD1({ settings: settingsRow() }),
  params = {},
  code,
  includeHeader,
} = {}) {
  return {
    request: request(method, path, body, { code, includeHeader }),
    env: { DB, ACCESS_CODE: "correct-code" },
    params,
  };
}

test("profile routes expose Cloudflare Pages method handlers", () => {
  assert.equal(typeof profilesIndexApi.onRequestPost, "function");
  assert.equal(typeof profileApi.onRequestPatch, "function");
  assert.equal(typeof profileApi.onRequestDelete, "function");
  assert.equal(typeof profileCopyApi.onRequestPost, "function");
});

test("profile creation accepts a blank profile and returns the latest settings and revision", async () => {
  assert.equal(typeof profilesIndexApi.onRequestPost, "function");
  const DB = new FakeD1({ settings: settingsRow() });
  const response = await profilesIndexApi.onRequestPost(context(
    "POST",
    "/api/settings/profiles",
    {
      revision: INITIAL_REVISION,
      profile: {
        id: "us_tech",
        name: "美国科技",
        objective: "跟踪美国科技股。",
        timezone: "America/New_York",
      },
    },
    { DB },
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.revision, payload.updatedAt);
  assert.notEqual(payload.revision, INITIAL_REVISION);
  assert.equal(payload.settings.profiles.length, 2);
  assert.deepEqual(payload.settings.profiles[1].targets, []);
  assert.equal(payload.settings.profiles[1].enabled, false);
  assert.equal(DB.settings.updated_at, payload.revision);
  assert.equal(
    DB.calls.some(({ sql, params }) =>
      /UPDATE\s+workbench_settings/i.test(sql) && params.at(-1) === INITIAL_REVISION),
    true,
  );
});

test("PATCH updates one profile without replacing nested siblings and cannot change its id", async () => {
  assert.equal(typeof profileApi.onRequestPatch, "function");
  const DB = new FakeD1({ settings: settingsRow() });
  const response = await profileApi.onRequestPatch(context(
    "PATCH",
    "/api/settings/profiles/cn-semi-comms",
    {
      revision: INITIAL_REVISION,
      patch: {
        name: "更新后的名称",
        enabled: false,
        alerts: { pushMinSeverity: "critical" },
      },
    },
    { DB, params: { profileId: "cn-semi-comms" } },
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.settings.profiles[0].name, "更新后的名称");
  assert.equal(payload.settings.profiles[0].enabled, false);
  assert.equal(payload.settings.profiles[0].alerts.pushMinSeverity, "critical");
  assert.deepEqual(
    payload.settings.profiles[0].alerts.channels,
    staticSettings.profiles[0].alerts.channels,
  );

  const immutable = await profileApi.onRequestPatch(context(
    "PATCH",
    "/api/settings/profiles/cn-semi-comms",
    { revision: payload.revision, patch: { id: "renamed" } },
    { DB, params: { profileId: "cn-semi-comms" } },
  ));
  assert.equal(immutable.status, 400);
  assert.equal((await immutable.json()).error_code, "IMMUTABLE_PROFILE_ID");
});

test("copy generates a disabled unique id and delete protects the final profile", async () => {
  assert.equal(typeof profileCopyApi.onRequestPost, "function");
  assert.equal(typeof profileApi.onRequestDelete, "function");
  const DB = new FakeD1({ settings: settingsRow() });
  const copiedResponse = await profileCopyApi.onRequestPost(context(
    "POST",
    "/api/settings/profiles/cn-semi-comms/copy",
    { revision: INITIAL_REVISION },
    { DB, params: { profileId: "cn-semi-comms" } },
  ));
  const copiedPayload = await copiedResponse.json();
  const copy = copiedPayload.settings.profiles[1];

  assert.equal(copiedResponse.status, 200);
  assert.equal(copy.id, "cn-semi-comms-copy");
  assert.equal(copy.enabled, false);

  const deletedResponse = await profileApi.onRequestDelete(context(
    "DELETE",
    `/api/settings/profiles/${copy.id}`,
    { revision: copiedPayload.revision },
    { DB, params: { profileId: copy.id } },
  ));
  const deletedPayload = await deletedResponse.json();
  assert.equal(deletedResponse.status, 200);
  assert.equal(deletedPayload.settings.profiles.length, 1);

  const finalDelete = await profileApi.onRequestDelete(context(
    "DELETE",
    "/api/settings/profiles/cn-semi-comms",
    { revision: deletedPayload.revision },
    { DB, params: { profileId: "cn-semi-comms" } },
  ));
  assert.equal(finalDelete.status, 409);
  assert.equal((await finalDelete.json()).error_code, "LAST_PROFILE_REQUIRED");
});

test("profile mutations reject stale revisions and return the latest winning document", async () => {
  assert.equal(typeof profileApi.onRequestPatch, "function");
  const DB = new FakeD1({ settings: settingsRow() });
  const response = await profileApi.onRequestPatch(context(
    "PATCH",
    "/api/settings/profiles/cn-semi-comms",
    {
      revision: "2026-07-22T00:00:00.000Z",
      patch: { enabled: false },
    },
    { DB, params: { profileId: "cn-semi-comms" } },
  ));
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error_code, "SETTINGS_CONFLICT");
  assert.equal(payload.revision, INITIAL_REVISION);
  assert.equal(payload.settings.profiles[0].enabled, true);
  assert.equal(DB.settings.updated_at, INITIAL_REVISION);
});

test("new profile writes accept only the access-code header", async () => {
  assert.equal(typeof profilesIndexApi.onRequestPost, "function");
  const response = await profilesIndexApi.onRequestPost(context(
    "POST",
    "/api/settings/profiles",
    {
      code: "correct-code",
      revision: INITIAL_REVISION,
      profile: {
        id: "body_code_only",
        name: "Body code",
        objective: "Body code must not authorize.",
      },
    },
    { includeHeader: false },
  ));

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error_code, "INVALID_ACCESS_CODE");
});

test("profile writes fail closed when D1 is absent or unavailable", async () => {
  assert.equal(typeof profilesIndexApi.onRequestPost, "function");
  const input = {
    revision: INITIAL_REVISION,
    profile: {
      id: "no_storage",
      name: "No storage",
      objective: "Must not dispatch asynchronously.",
    },
  };
  const absent = await profilesIndexApi.onRequestPost(context(
    "POST",
    "/api/settings/profiles",
    input,
    { DB: null },
  ));
  const unavailable = await profilesIndexApi.onRequestPost(context(
    "POST",
    "/api/settings/profiles",
    input,
    { DB: new FakeD1({ fail: true }) },
  ));

  assert.equal(absent.status, 503);
  assert.equal(unavailable.status, 503);
  assert.equal((await absent.json()).error_code, "SETTINGS_STORAGE_UNAVAILABLE");
  assert.equal((await unavailable.json()).error_code, "SETTINGS_STORAGE_UNAVAILABLE");
});
