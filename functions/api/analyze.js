import {
  REPO,
  RequestBodyTooLargeError,
  gate,
  ghHeaders,
  json,
  readJsonBody,
} from "./_util.js";
import {
  WorkbenchSettingsError,
  normalizeWorkbenchTickers,
  parseWorkbenchSettings,
} from "./_workbench_settings.mjs";
import {
  d1Binding,
  readSettingsFromD1,
} from "./_d1_repository.mjs";
import {
  AnalysisRequestError,
  enforceAnalysisWorkload,
  normalizeAnalysts,
  normalizeRequestId,
  normalizeResearchDepth,
} from "./_analysis_request.mjs";
import {
  adhocRunIdentity,
  isValidProfileId,
  legacyRunIdentity,
  profileManualIdentity,
} from "./_run_identity.mjs";

// POST /api/analyze {code, tickers, requestId?, analysts?, researchDepth?}
// → 触发 GitHub Actions daily-analysis 工作流
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
  if (!body) return json({ error: "请求体不是合法 JSON" }, 400);
  if (!gate(env, headerCode ?? body.code)) return json({ error: "访问码不正确" }, 401);

  let tickerList;
  let requestId;
  let analysts;
  let researchDepth;
  const hasCallerRequestId =
    typeof body.requestId === "string" && body.requestId.trim() !== "";
  const hasProfileId = body.profileId !== undefined && body.profileId !== null;
  const profileId = typeof body.profileId === "string"
    ? body.profileId.trim()
    : "";
  if (hasProfileId && hasCallerRequestId) {
    return json({
      error: "profileId 与 requestId 不能同时提供",
      error_code: "ambiguous_run_identity",
    }, 400);
  }
  if (hasProfileId && !isValidProfileId(profileId)) {
    return json({
      error: "profileId 无效",
      error_code: "invalid_profile_id",
    }, 400);
  }
  try {
    tickerList = normalizeWorkbenchTickers(body.tickers);
    requestId = normalizeRequestId(body.requestId);
    analysts = normalizeAnalysts(body.analysts, {
      capabilities: env.ANALYSIS_CAPABILITIES,
    });
    researchDepth = normalizeResearchDepth(body.researchDepth);
    if (hasCallerRequestId) {
      enforceAnalysisWorkload(tickerList.length, researchDepth);
    }
  } catch (error) {
    if (error instanceof WorkbenchSettingsError) {
      return json({ error: error.message, error_code: error.code }, 400);
    }
    if (error instanceof AnalysisRequestError) {
      return json(
        { error: error.message, error_code: error.code, ...error.details },
        400,
      );
    }
    throw error;
  }
  if (hasProfileId) {
    const db = d1Binding(env);
    if (!db) {
      return json({
        error: "无法验证监控组设置",
        error_code: "settings_unavailable",
      }, 503);
    }
    let stored;
    try {
      stored = await readSettingsFromD1(db);
      if (!stored) throw new Error("settings missing");
      const settings = parseWorkbenchSettings(stored.settings);
      if (!settings.profiles.some((profile) => profile.id === profileId)) {
        return json({
          error: "监控组不存在",
          error_code: "profile_not_found",
        }, 404);
      }
    } catch (error) {
      if (error instanceof WorkbenchSettingsError) {
        return json({
          error: "无法验证监控组设置",
          error_code: "settings_unavailable",
        }, 503);
      }
      if (error?.message === "settings missing") {
        return json({
          error: "无法验证监控组设置",
          error_code: "settings_unavailable",
        }, 503);
      }
      return json({
        error: "无法验证监控组设置",
        error_code: "settings_unavailable",
      }, 503);
    }
  }
  const tickers = tickerList.join(",");
  if (!env.GITHUB_DISPATCH_TOKEN) return json({ error: "服务端未配置 GITHUB_DISPATCH_TOKEN" }, 500);

  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/daily-analysis.yml/dispatches`,
    {
      method: "POST",
      headers: { ...ghHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          tickers,
          requestId: hasCallerRequestId ? requestId : "",
          analysts: analysts.join(","),
          researchDepth,
          ...(hasProfileId ? { profileId } : {}),
        },
      }),
    },
  );
  if (resp.status !== 204) {
    const detail = await resp.text();
    return json({ error: `GitHub dispatch 失败 (${resp.status})`, detail: detail.slice(0, 300) }, 502);
  }
  return json({
    ok: true,
    requestId,
    identity: hasProfileId
      ? profileManualIdentity(profileId)
      : hasCallerRequestId
        ? adhocRunIdentity(requestId)
        : legacyRunIdentity(),
    tickers: tickerList,
    analysts,
    researchDepth,
    message: "已受理，分析会在后台顺序执行",
  }, 202);
}
