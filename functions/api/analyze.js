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
} from "./_workbench_settings.mjs";
import {
  AnalysisRequestError,
  enforceAnalysisWorkload,
  normalizeAnalysts,
  normalizeRequestId,
  normalizeResearchDepth,
} from "./_analysis_request.mjs";

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
    tickers: tickerList,
    analysts,
    researchDepth,
    message: "已受理，分析会在后台顺序执行",
  }, 202);
}
