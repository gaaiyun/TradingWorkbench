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
  const configured = {
    access_gate: Boolean(env.ACCESS_CODE),
    chat: Boolean(env.OPENAI_COMPATIBLE_API_KEY),
    analysis_dispatch: Boolean(env.GITHUB_DISPATCH_TOKEN),
    shared_conversations: Boolean(env.DB || env.WORKBENCH_KV),
  };
  return {
    status: checks.every((item) => item.ok) ? "ok" : "degraded",
    checked_at: checkedAt.toISOString(),
    configured,
    checks,
  };
}
