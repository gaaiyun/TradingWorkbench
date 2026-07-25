import {
  REPO,
  RequestBodyTooLargeError,
  gate,
  ghHeaders,
  json,
  proxyRaw,
  readJsonBody,
} from "./_util.js";
import {
  WorkbenchSettingsError,
  parseWorkbenchSettings,
  updateWorkbenchFullAnalysisTargets,
} from "./_workbench_settings.mjs";
import {
  d1Binding,
  mutateSettingsInD1,
  readSettingsFromD1,
  SettingsConflictError,
  writeSettingsToD1,
} from "./_d1_repository.mjs";

// GET /api/settings -> D1 中即时生效的设置；不可用时回退到静态/GitHub 快照。
export async function onRequestGet({ env } = {}) {
  const db = d1Binding(env);
  if (db) {
    try {
      const stored = await readSettingsFromD1(db);
      if (stored) return json({
        ...parseWorkbenchSettings(stored.settings),
        updatedAt: stored.updatedAt,
        revision: stored.updatedAt,
        storage: { source: "d1" },
      });
    } catch {
      // D1 故障或数据损坏不应使设置页不可用。
    }
  }
  return proxyRaw("data/workbench-settings.json", { cacheSeconds: 5 });
}

function settingsResponse(settings) {
  return { ...settings, tickers: settings.tickers };
}

function providedRevision(body) {
  const hasExpectedUpdatedAt = Object.prototype.hasOwnProperty.call(
    body,
    "expectedUpdatedAt",
  );
  const hasRevision = Object.prototype.hasOwnProperty.call(body, "revision");
  if (!hasExpectedUpdatedAt && !hasRevision) {
    return { present: false, value: undefined };
  }
  if (
    hasExpectedUpdatedAt &&
    hasRevision &&
    body.expectedUpdatedAt !== body.revision
  ) {
    throw new WorkbenchSettingsError(
      "INVALID_EXPECTED_UPDATED_AT",
      "revision 与 expectedUpdatedAt 必须一致",
    );
  }
  return {
    present: true,
    value: hasRevision ? body.revision : body.expectedUpdatedAt,
  };
}

function validateRevision(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || Number.isNaN(new Date(value).valueOf())) {
    throw new WorkbenchSettingsError(
      "INVALID_EXPECTED_UPDATED_AT",
      "expectedUpdatedAt 必须是 ISO 时间或 null",
    );
  }
  return value;
}

function expectedRevision(body, stored, { requireExisting = false } = {}) {
  const provided = providedRevision(body);
  if (!provided.present) {
    if (requireExisting && stored) {
      throw new WorkbenchSettingsError(
        "SETTINGS_REVISION_REQUIRED",
        "覆盖已有设置必须提供 revision",
      );
    }
    return stored?.updatedAt ?? null;
  }
  return validateRevision(provided.value);
}

function atomicRevision(body) {
  const provided = providedRevision(body);
  if (!provided.present) return undefined;
  if (provided.value === null) {
    throw new WorkbenchSettingsError(
      "INVALID_EXPECTED_UPDATED_AT",
      "profile 写入的 revision 必须是 ISO 时间",
    );
  }
  return validateRevision(provided.value);
}

function storageFailure() {
  return json(
    { error: "设置存储暂不可用", error_code: "SETTINGS_STORAGE_UNAVAILABLE" },
    503,
  );
}

function latestSettingsFields(stored) {
  if (!stored) return {};
  const settings = parseWorkbenchSettings(stored.settings);
  return {
    settings: settingsResponse(settings),
    revision: stored.updatedAt,
    updatedAt: stored.updatedAt,
  };
}

async function settingsConflict(db, stored = null) {
  let latest = stored;
  if (!latest) {
    try {
      latest = await readSettingsFromD1(db);
    } catch {
      return storageFailure();
    }
  }
  try {
    return json(
      {
        error: "设置已被其他请求更新，请刷新后重试",
        error_code: "SETTINGS_CONFLICT",
        ...latestSettingsFields(latest),
      },
      409,
    );
  } catch {
    return storageFailure();
  }
}

async function saveToD1(db, settings, expectedUpdatedAt) {
  try {
    const updatedAt = await writeSettingsToD1(db, settings, expectedUpdatedAt);
    return json({
      ok: true,
      settings: settingsResponse(settings),
      updatedAt,
      revision: updatedAt,
      message: "设置已保存并即时生效",
    });
  } catch (error) {
    if (error instanceof SettingsConflictError) {
      return settingsConflict(db, error.latest);
    }
    return storageFailure();
  }
}

async function dispatchSettings(env, settings, { legacy = false } = {}) {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    if (legacy) return json({ error: "服务端未配置 GITHUB_DISPATCH_TOKEN" }, 500);
    return json(
      { error: "设置存储暂不可用", error_code: "SETTINGS_STORAGE_UNAVAILABLE" },
      503,
    );
  }
  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/settings-update.yml/dispatches`,
    {
      method: "POST",
      headers: { ...ghHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: { settings_json: JSON.stringify(settings) },
      }),
    },
  );
  if (resp.status !== 204) {
    const detail = await resp.text();
    return json(
      { error: `GitHub dispatch 失败 (${resp.status})`, detail: detail.slice(0, 300) },
      502,
    );
  }
  return json(
    { ok: true, settings: settingsResponse(settings), message: "清单更新已受理，通常会在一分钟内生效" },
    202,
  );
}

// PUT /api/settings -> 以 D1 为即时主存储，同时接受 v1/v2 设置。
export async function onRequestPut({ request, env }) {
  const headerCode = request.headers.get("x-access-code");
  if (!gate(env, headerCode)) return json({ error: "访问码不正确" }, 401);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: "请求体过大" }, 413);
    }
    throw error;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "请求体不是合法 JSON 对象" }, 400);
  }

  const db = d1Binding(env);
  let stored = null;
  if (db) {
    try {
      stored = await readSettingsFromD1(db);
    } catch {
      return storageFailure();
    }
  }

  let settings;
  let expectedUpdatedAt;
  try {
    expectedUpdatedAt = expectedRevision(body, stored, {
      requireExisting: body.tickers === undefined,
    });
    const current = body.settings ?? stored?.settings ?? body;
    settings = body.tickers === undefined
      ? parseWorkbenchSettings(current)
      : updateWorkbenchFullAnalysisTargets(current, body.tickers);
  } catch (error) {
    if (error instanceof WorkbenchSettingsError) {
      if (error.code === "SETTINGS_REVISION_REQUIRED") {
        return json(
          {
            error: error.message,
            error_code: error.code,
            ...latestSettingsFields(stored),
          },
          428,
        );
      }
      return json({ error: error.message, error_code: error.code }, 400);
    }
    throw error;
  }

  if (db) {
    return saveToD1(db, settings, expectedUpdatedAt);
  }
  return dispatchSettings(env, settings);
}

// POST /api/settings {code, tickers, settings?} -> 校验后异步触发持久化工作流。
export async function onRequestPost({ request, env }) {
  const headerCode = request.headers.get("x-access-code");
  if (headerCode !== null && !gate(env, headerCode)) {
    return json({ error: "访问码不正确" }, 401);
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: "请求体过大" }, 413);
    }
    throw error;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "请求体不是合法 JSON 对象" }, 400);
  }
  if (!gate(env, headerCode ?? body.code)) return json({ error: "访问码不正确" }, 401);

  const db = d1Binding(env);
  let stored = null;
  if (db) {
    try {
      stored = await readSettingsFromD1(db);
    } catch {
      return storageFailure();
    }
  }

  const hasExpectedRevision = Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt");
  let currentSettings = hasExpectedRevision
    ? body.settings ?? stored?.settings
    : stored?.settings ?? body.settings;
  const loadedCurrentSettings = !currentSettings;
  if (loadedCurrentSettings) {
    let currentResponse;
    try {
      currentResponse = await proxyRaw("data/workbench-settings.json", { cacheSeconds: 5 });
    } catch {
      return json(
        { error: "无法读取当前工作台设置", error_code: "CURRENT_SETTINGS_UNAVAILABLE" },
        502,
      );
    }
    if (!currentResponse.ok) {
      return json(
        { error: "无法读取当前工作台设置", error_code: "CURRENT_SETTINGS_UNAVAILABLE" },
        502,
      );
    }
    try {
      currentSettings = await currentResponse.json();
    } catch {
      return json(
        { error: "当前工作台设置不是合法 JSON", error_code: "CURRENT_SETTINGS_INVALID" },
        502,
      );
    }
  }

  let settings;
  let expectedUpdatedAt;
  try {
    expectedUpdatedAt = expectedRevision(body, stored);
    settings = updateWorkbenchFullAnalysisTargets(currentSettings, body.tickers);
  } catch (error) {
    if (error instanceof WorkbenchSettingsError) {
      if (loadedCurrentSettings) {
        return json(
          { error: "当前工作台设置无法通过校验", error_code: "CURRENT_SETTINGS_INVALID" },
          502,
        );
      }
      return json({ error: error.message, error_code: error.code }, 400);
    }
    throw error;
  }

  if (db) return saveToD1(db, settings, expectedUpdatedAt);
  return dispatchSettings(env, settings, { legacy: true });
}

function profileErrorStatus(code) {
  if (code === "PROFILE_NOT_FOUND") return 404;
  if (
    code === "DUPLICATE_PROFILE_ID" ||
    code === "TOO_MANY_PROFILES" ||
    code === "LAST_PROFILE_REQUIRED"
  ) {
    return 409;
  }
  return 400;
}

export async function mutateProfileSettings({ request, env }, mutation) {
  const headerCode = request.headers.get("x-access-code");
  if (!gate(env, headerCode)) {
    return json(
      { error: "访问码不正确", error_code: "INVALID_ACCESS_CODE" },
      401,
      { "cache-control": "no-store" },
    );
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: "请求体过大", error_code: "REQUEST_BODY_TOO_LARGE" }, 413);
    }
    throw error;
  }
  if (body === null && request.body) {
    return json({ error: "请求体不是合法 JSON 对象", error_code: "INVALID_JSON" }, 400);
  }
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
    return json({ error: "请求体不是合法 JSON 对象", error_code: "INVALID_JSON" }, 400);
  }
  body ??= {};

  const db = d1Binding(env);
  if (!db) return storageFailure();

  let expectedUpdatedAt;
  try {
    expectedUpdatedAt = atomicRevision(body);
  } catch (error) {
    if (error instanceof WorkbenchSettingsError) {
      return json({ error: error.message, error_code: error.code }, 400);
    }
    throw error;
  }

  try {
    const result = await mutateSettingsInD1(
      db,
      (settings) => mutation(settings, body),
      expectedUpdatedAt,
    );
    if (!result) return storageFailure();
    return json({
      ok: true,
      settings: settingsResponse(result.settings),
      revision: result.updatedAt,
      updatedAt: result.updatedAt,
      message: "profile 设置已保存并即时生效",
    }, 200, { "cache-control": "no-store" });
  } catch (error) {
    if (error instanceof SettingsConflictError) {
      return settingsConflict(db, error.latest);
    }
    if (error instanceof WorkbenchSettingsError) {
      return json(
        { error: error.message, error_code: error.code },
        profileErrorStatus(error.code),
        { "cache-control": "no-store" },
      );
    }
    return storageFailure();
  }
}
