export async function checkJson(
  name,
  url,
  init = {},
  { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {},
) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
    let detail = null;
    if (response.ok) {
      try {
        const body = await response.json();
        detail = {
          generated_at: body?.quote_generated_at || body?.generated_at || null,
          status: body?.source_status?.overall || body?.status || null,
        };
      } catch {
        detail = null;
      }
    }
    return {
      name,
      ok: response.ok,
      status: response.status,
      latency_ms: Date.now() - started,
      detail,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: 0,
      latency_ms: Date.now() - started,
      error: error?.name === "AbortError" ? "timeout" : "unreachable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildHealthPayload(env, checks, checkedAt = new Date()) {
  const rawCommitSha = String(env.CF_PAGES_COMMIT_SHA || "").trim().toLowerCase();
  const rawBranch = String(env.CF_PAGES_BRANCH || "").trim();
  let deploymentUrl = null;
  try {
    const parsed = new URL(String(env.CF_PAGES_URL || ""));
    if (parsed.protocol === "https:") deploymentUrl = parsed.href;
  } catch {
    deploymentUrl = null;
  }
  const deployment = {
    service: "pages-functions",
    commitSha: /^[0-9a-f]{7,64}$/.test(rawCommitSha) ? rawCommitSha : "unknown",
    branch: /^[A-Za-z0-9._/-]{1,128}$/.test(rawBranch) ? rawBranch : "unknown",
    url: deploymentUrl,
  };
  const configured = {
    access_gate: Boolean(env.ACCESS_CODE),
    chat: Boolean(env.OPENAI_COMPATIBLE_API_KEY),
    analysis_dispatch: Boolean(env.GITHUB_DISPATCH_TOKEN),
    shared_conversations: Boolean(env.DB || env.WORKBENCH_KV),
  };
  const unhealthyDetailStatuses = new Set([
    "failed",
    "error",
    "unavailable",
    "data_validation_failed",
  ]);
  const healthy = checks.every((item) => (
    item.ok
    && !(
      item.name === "reports"
      && unhealthyDetailStatuses.has(String(item.detail?.status || "").toLowerCase())
    )
  ));
  return {
    status: healthy ? "ok" : "degraded",
    checked_at: checkedAt.toISOString(),
    deployment,
    configured,
    checks,
  };
}
