import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as settingsDomain from "../functions/api/_workbench_settings.mjs";
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
const DENSE_TARGET_SYMBOLS = [
  "AAAAA", "AAAAB", "AAAAC", "AAAAD", "AAAAE", "AAAAF", "AAAAG",
  "AAAAH", "AAAAI", "AAAAJ", "AAAAK", "AAAAL", "AAAAM", "AAAAN",
];

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

function denseSettings({ profileCount = 8, objectiveBytes = 512 } = {}) {
  const template = structuredClone(staticSettings.profiles[0]);
  const windows = Array.from({ length: 8 }, (_, index) => ({
    start: `${String(index * 2).padStart(2, "0")}:00`,
    end: `${String(index * 2 + 1).padStart(2, "0")}:00`,
  }));
  return {
    version: 2,
    profiles: Array.from({ length: profileCount }, (_, profileIndex) => ({
      ...structuredClone(template),
      id: `profile-${profileIndex + 1}`.padEnd(64, "x"),
      name: "n".repeat(96),
      objective: "o".repeat(objectiveBytes),
      timezone: "America/Argentina/Buenos_Aires",
      targets: DENSE_TARGET_SYMBOLS.map((symbol) => ({
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

function assertSettingsError(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof settingsDomain.WorkbenchSettingsError);
    assert.equal(error.code, code);
    return true;
  });
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

test("every profile mutation requires revision before any D1 write", async () => {
  const twoProfiles = structuredClone(staticSettings);
  twoProfiles.profiles.push({
    ...structuredClone(twoProfiles.profiles[0]),
    id: "second-profile",
  });
  const cases = [
    {
      api: profilesIndexApi.onRequestPost,
      method: "POST",
      path: "/api/settings/profiles",
      body: {
        profile: {
          id: "missing-revision",
          name: "Missing revision",
          objective: "Must fail before writing.",
        },
      },
      params: {},
      settings: staticSettings,
    },
    {
      api: profileApi.onRequestPatch,
      method: "PATCH",
      path: "/api/settings/profiles/cn-semi-comms",
      body: { patch: { enabled: false } },
      params: { profileId: "cn-semi-comms" },
      settings: staticSettings,
    },
    {
      api: profileCopyApi.onRequestPost,
      method: "POST",
      path: "/api/settings/profiles/cn-semi-comms/copy",
      body: {},
      params: { profileId: "cn-semi-comms" },
      settings: staticSettings,
    },
    {
      api: profileApi.onRequestDelete,
      method: "DELETE",
      path: "/api/settings/profiles/second-profile",
      body: {},
      params: { profileId: "second-profile" },
      settings: twoProfiles,
    },
  ];

  for (const candidate of cases) {
    const DB = new FakeD1({ settings: settingsRow(candidate.settings) });
    const before = structuredClone(DB.settings);
    const response = await candidate.api(context(
      candidate.method,
      candidate.path,
      candidate.body,
      { DB, params: candidate.params },
    ));
    const payload = await response.json();

    assert.equal(response.status, 428, `${candidate.method} ${candidate.path}`);
    assert.equal(payload.error_code, "SETTINGS_REVISION_REQUIRED");
    assert.deepEqual(DB.settings, before);
    assert.equal(
      DB.calls.some(({ sql }) => /\b(?:INSERT|UPDATE)\b/i.test(sql)),
      false,
    );
  }
});

test("profile strings and nested collection sizes have bounded UTF-8 contracts", () => {
  const cases = [
    {
      code: "PROFILE_FIELD_TOO_LONG",
      mutate(settings) {
        settings.profiles[0].name = "n".repeat(97);
      },
    },
    {
      code: "PROFILE_FIELD_TOO_LONG",
      mutate(settings) {
        settings.profiles[0].objective = "o".repeat(513);
      },
    },
    {
      code: "TARGET_FIELD_TOO_LONG",
      mutate(settings) {
        settings.profiles[0].targets[0].name = "t".repeat(97);
      },
    },
    {
      code: "TARGET_FIELD_TOO_LONG",
      mutate(settings) {
        settings.profiles[0].targets[0].market = "M".repeat(17);
      },
    },
    {
      code: "BENCHMARK_FIELD_TOO_LONG",
      mutate(settings) {
        settings.profiles[0].systemBenchmarks[0].id = "b".repeat(65);
      },
    },
    {
      code: "BENCHMARK_FIELD_TOO_LONG",
      mutate(settings) {
        settings.profiles[0].systemBenchmarks[0].name = "b".repeat(97);
      },
    },
    {
      code: "BENCHMARK_FIELD_TOO_LONG",
      mutate(settings) {
        settings.profiles[0].systemBenchmarks[0].market = "M".repeat(17);
      },
    },
    {
      code: "TOO_MANY_BENCHMARKS",
      mutate(settings) {
        settings.profiles[0].systemBenchmarks = Array.from(
          { length: 13 },
          (_, index) => ({ id: `b-${index}`, name: `Benchmark ${index}`, market: "US" }),
        );
      },
    },
    {
      code: "TOO_MANY_SCHEDULE_WINDOWS",
      mutate(settings) {
        settings.profiles[0].schedules.cnIntraday.windows = Array.from(
          { length: 9 },
          (_, index) => ({
            start: `${String(index * 2).padStart(2, "0")}:00`,
            end: `${String(index * 2 + 1).padStart(2, "0")}:00`,
          }),
        );
      },
    },
  ];

  for (const candidate of cases) {
    const settings = structuredClone(staticSettings);
    candidate.mutate(settings);
    assertSettingsError(candidate.code, () => settingsDomain.buildWorkbenchSettings(settings));
  }

  const multibyte = structuredClone(staticSettings);
  multibyte.profiles[0].name = "研".repeat(33);
  assertSettingsError(
    "PROFILE_FIELD_TOO_LONG",
    () => settingsDomain.buildWorkbenchSettings(multibyte),
  );
});

test("profile patch rejects prototype-pollution keys", () => {
  const malicious = JSON.parse(
    '{"alerts":{"__proto__":{"polluted":true}},"constructor":{"prototype":{"owned":true}}}',
  );
  assertSettingsError("UNSAFE_PROFILE_PATCH", () =>
    settingsDomain.updateWorkbenchProfile(staticSettings, "cn-semi-comms", malicious));
  assert.equal({}.polluted, undefined);
  assert.equal({}.owned, undefined);
});

test("profile text fields reject control characters", () => {
  const cases = [
    (settings) => { settings.profiles[0].name = "bad\u0000name"; },
    (settings) => { settings.profiles[0].objective = "line\nbreak"; },
    (settings) => { settings.profiles[0].targets[0].name = "bad\tname"; },
    (settings) => { settings.profiles[0].systemBenchmarks[0].name = "bad\u007fname"; },
    (settings) => { settings.profiles[0].timezone = "Asia/Shanghai\n"; },
  ];
  for (const mutate of cases) {
    const settings = structuredClone(staticSettings);
    mutate(settings);
    assertSettingsError(
      "CONTROL_CHAR_NOT_ALLOWED",
      () => settingsDomain.buildWorkbenchSettings(settings),
    );
  }
});

test("copy default names truncate safely at UTF-8 boundaries and preserve the suffix", () => {
  const cases = [
    { source: "a".repeat(96), expected: `${"a".repeat(89)} 副本` },
    { source: "研".repeat(32), expected: `${"研".repeat(29)} 副本` },
  ];
  for (const { source, expected } of cases) {
    const settings = structuredClone(staticSettings);
    settings.profiles[0].name = source;
    const copied = settingsDomain.copyWorkbenchProfile(settings, "cn-semi-comms");
    const copy = copied.profiles[1];
    assert.equal(copy.name, expected);
    assert.equal(copy.name.endsWith(" 副本"), true);
    assert.ok(new TextEncoder().encode(copy.name).byteLength <= 96);
  }
});

test("profile POST, PATCH, and copy cannot persist a document above the total byte cap", async () => {
  const sevenDenseProfiles = denseSettings({ profileCount: 7, objectiveBytes: 512 });
  const createDB = new FakeD1({ settings: settingsRow(sevenDenseProfiles) });
  const createResponse = await profilesIndexApi.onRequestPost(context(
    "POST",
    "/api/settings/profiles",
    {
      revision: INITIAL_REVISION,
      profile: {
        ...denseSettings({ profileCount: 1, objectiveBytes: 512 }).profiles[0],
        id: "profile-new".padEnd(64, "x"),
      },
    },
    { DB: createDB },
  ));
  assert.equal(createResponse.status, 400);
  assert.equal((await createResponse.json()).error_code, "SETTINGS_TOO_LARGE");
  assert.equal(createDB.settings.updated_at, INITIAL_REVISION);

  const legalEightProfiles = denseSettings({ profileCount: 8, objectiveBytes: 300 });
  const patchId = legalEightProfiles.profiles[0].id;
  const patchDB = new FakeD1({ settings: settingsRow(legalEightProfiles) });
  const patchResponse = await profileApi.onRequestPatch(context(
    "PATCH",
    `/api/settings/profiles/${patchId}`,
    {
      revision: INITIAL_REVISION,
      patch: { objective: "o".repeat(512) },
    },
    { DB: patchDB, params: { profileId: patchId } },
  ));
  assert.equal(patchResponse.status, 400);
  assert.equal((await patchResponse.json()).error_code, "SETTINGS_TOO_LARGE");
  assert.equal(patchDB.settings.updated_at, INITIAL_REVISION);

  const copyId = sevenDenseProfiles.profiles[0].id;
  const copyDB = new FakeD1({ settings: settingsRow(sevenDenseProfiles) });
  const copyResponse = await profileCopyApi.onRequestPost(context(
    "POST",
    `/api/settings/profiles/${copyId}/copy`,
    { revision: INITIAL_REVISION },
    { DB: copyDB, params: { profileId: copyId } },
  ));
  assert.equal(copyResponse.status, 400);
  assert.equal((await copyResponse.json()).error_code, "SETTINGS_TOO_LARGE");
  assert.equal(copyDB.settings.updated_at, INITIAL_REVISION);
});

test("copy accepts only explicit options or compatible newId/newName aliases", async () => {
  const conflictDB = new FakeD1({ settings: settingsRow() });
  const conflict = await profileCopyApi.onRequestPost(context(
    "POST",
    "/api/settings/profiles/cn-semi-comms/copy",
    {
      revision: INITIAL_REVISION,
      options: { id: "nested-copy", name: "Nested copy" },
      newId: "top-copy",
      newName: "Top copy",
    },
    { DB: conflictDB, params: { profileId: "cn-semi-comms" } },
  ));
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).error_code, "COPY_OPTIONS_CONFLICT");
  assert.equal(conflictDB.settings.updated_at, INITIAL_REVISION);

  const unsafeDB = new FakeD1({ settings: settingsRow() });
  const unsafe = await profileCopyApi.onRequestPost(context(
    "POST",
    "/api/settings/profiles/cn-semi-comms/copy",
    {
      revision: INITIAL_REVISION,
      profile: { enabled: true },
    },
    { DB: unsafeDB, params: { profileId: "cn-semi-comms" } },
  ));
  assert.equal(unsafe.status, 400);
  assert.equal((await unsafe.json()).error_code, "INVALID_COPY_OPTIONS");

  const compatibleDB = new FakeD1({ settings: settingsRow() });
  const compatible = await profileCopyApi.onRequestPost(context(
    "POST",
    "/api/settings/profiles/cn-semi-comms/copy",
    {
      revision: INITIAL_REVISION,
      newId: "custom-copy",
      newName: "自定义副本",
    },
    { DB: compatibleDB, params: { profileId: "cn-semi-comms" } },
  ));
  const payload = await compatible.json();
  assert.equal(compatible.status, 200);
  assert.equal(payload.settings.profiles[1].id, "custom-copy");
  assert.equal(payload.settings.profiles[1].name, "自定义副本");
  assert.equal(payload.settings.profiles[1].enabled, false);
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
