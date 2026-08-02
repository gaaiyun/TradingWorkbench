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
          trade_date: body?.trade_date || null,
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

function expectedReportDate(now) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map(({ type, value }) => [type, value]),
  );
  let candidate = new Date(
    `${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`,
  );
  if (Number(parts.hour) * 60 + Number(parts.minute) < 16 * 60) {
    candidate = new Date(candidate.valueOf() - 24 * 60 * 60 * 1000);
  }
  while (["Sat", "Sun"].includes(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(candidate))) {
    candidate = new Date(candidate.valueOf() - 24 * 60 * 60 * 1000);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(candidate);
}

export async function checkDeploymentManifest(
  url,
  expectedCommitSha,
  { fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {},
) {
  const started = Date.now();
  const expected = String(expectedCommitSha || "").trim().toLowerCase();
  if (!url || !/^[0-9a-f]{7,64}$/.test(expected)) {
    return {
      name: "deployment_manifest",
      ok: false,
      status: 0,
      latency_ms: Date.now() - started,
      error: "metadata_unavailable",
      detail: null,
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        name: "deployment_manifest",
        ok: false,
        status: response.status,
        latency_ms: Date.now() - started,
        error: "metadata_unavailable",
        detail: null,
      };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const commitSha = String(body?.commitSha || "").trim().toLowerCase();
    const deployedAt = String(body?.deployedAt || "").trim();
    const branch = String(body?.branch || "").trim();
    const validDate = (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(deployedAt)
      && Number.isFinite(Date.parse(deployedAt))
    );
    if (
      commitSha !== expected
      || !validDate
      || !/^[A-Za-z0-9._/-]{1,128}$/.test(branch)
    ) {
      return {
        name: "deployment_manifest",
        ok: false,
        status: response.status,
        latency_ms: Date.now() - started,
        error: commitSha && commitSha !== expected
          ? "revision_mismatch"
          : "invalid_metadata",
        detail: null,
      };
    }
    return {
      name: "deployment_manifest",
      ok: true,
      status: response.status,
      latency_ms: Date.now() - started,
      detail: { commitSha, deployedAt, branch },
    };
  } catch (error) {
    return {
      name: "deployment_manifest",
      ok: false,
      status: 0,
      latency_ms: Date.now() - started,
      error: error?.name === "AbortError" ? "timeout" : "unreachable",
      detail: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkDeploymentState(
  db,
  expectedCommitSha,
  { timeoutMs = 2500 } = {},
) {
  const started = Date.now();
  const expected = String(expectedCommitSha || "").trim().toLowerCase();
  if (!db?.prepare || !/^[0-9a-f]{7,64}$/.test(expected)) {
    return {
      name: "deployment_manifest",
      ok: false,
      status: 0,
      latency_ms: Date.now() - started,
      error: "metadata_unavailable",
      detail: null,
    };
  }
  const timedOut = Symbol("deployment-state-timeout");
  let timer;
  try {
    const query = db.prepare(`
      SELECT commit_sha, deployed_at, branch, url
      FROM deployment_metadata
      WHERE service = ? AND commit_sha = ?
      LIMIT 1
    `).bind("pages-functions", expected).first();
    const row = await Promise.race([
      query,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (row === timedOut) throw new Error("timeout");
    const commitSha = String(row?.commit_sha || "").trim().toLowerCase();
    const deployedAt = String(row?.deployed_at || "").trim();
    const branch = String(row?.branch || "").trim();
    if (
      commitSha !== expected
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(deployedAt)
      || !Number.isFinite(Date.parse(deployedAt))
      || !/^[A-Za-z0-9._/-]{1,128}$/.test(branch)
    ) {
      return {
        name: "deployment_manifest",
        ok: false,
        status: 0,
        latency_ms: Date.now() - started,
        error: "invalid_metadata",
        detail: null,
      };
    }
    return {
      name: "deployment_manifest",
      ok: true,
      status: 200,
      latency_ms: Date.now() - started,
      detail: { commitSha, deployedAt, branch, source: "d1" },
    };
  } catch (error) {
    return {
      name: "deployment_manifest",
      ok: false,
      status: 0,
      latency_ms: Date.now() - started,
      error: error?.message === "timeout" ? "timeout" : "metadata_unavailable",
      detail: null,
    };
  } finally {
    clearTimeout(timer);
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
  const deploymentManifest = checks.find(
    ({ name }) => name === "deployment_manifest",
  );
  const manifestMatches = (
    deploymentManifest?.ok
    && deploymentManifest.detail?.commitSha === rawCommitSha
  );
  const deployment = {
    service: "pages-functions",
    commitSha: /^[0-9a-f]{7,64}$/.test(rawCommitSha) ? rawCommitSha : "unknown",
    deployedAt: manifestMatches
      ? deploymentManifest.detail.deployedAt
      : "unknown",
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
  const expectedTradeDate = expectedReportDate(checkedAt);
  const reports = checks.find(({ name }) => name === "reports");
  const reportLag = Boolean(
    reports?.ok
    && /^\d{4}-\d{2}-\d{2}$/.test(String(reports.detail?.trade_date || ""))
    && reports.detail.trade_date < expectedTradeDate
  );
  if (reportLag) {
    reports.error = "report_lag";
    reports.detail = {
      ...reports.detail,
      expected_trade_date: expectedTradeDate,
      freshness: "stale",
    };
  }
  const healthy = checks.every((item) => (
    item.ok
    && !(
      item.name === "reports"
      && unhealthyDetailStatuses.has(String(item.detail?.status || "").toLowerCase())
    )
  )) && !reportLag;
  return {
    status: healthy ? "ok" : "degraded",
    checked_at: checkedAt.toISOString(),
    deployment,
    configured,
    checks,
  };
}
