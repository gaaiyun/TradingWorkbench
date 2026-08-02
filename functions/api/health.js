import { RAW_BASE, REPO, ghHeaders, json } from "./_util.js";
import {
  buildHealthPayload,
  checkDeploymentManifest,
  checkDeploymentState,
  checkJson,
} from "./_health.mjs";
import {
  DEFAULT_SNAPSHOT_URL as VOLGUARD_SNAPSHOT,
  loadVolguardData,
} from "./_volguard.mjs";

const VOLGUARD_LIVE = "https://sh50-volguard.pages.dev/api/live";

async function checkVolguard(env) {
  const startedAt = Date.now();
  const result = await loadVolguardData({
    liveUrl: env.VOLGUARD_LIVE_URL || VOLGUARD_LIVE,
    snapshotUrl: env.VOLGUARD_SNAPSHOT_URL || VOLGUARD_SNAPSHOT,
    liveTimeoutMs: 5000,
    snapshotTimeoutMs: 3000,
  });
  if (!result.ok) {
    return {
      name: "options_live",
      ok: false,
      status: 0,
      latency_ms: Date.now() - startedAt,
      error: "unavailable",
    };
  }
  return {
    name: "options_live",
    ok: true,
    status: 200,
    latency_ms: Date.now() - startedAt,
    detail: {
      status: result.data?.source_status?.overall
        || result.data?.status
        || result.mode,
      mode: result.mode,
      fallback: result.fallback_reason || null,
    },
  };
}

// GET /api/health
// 只暴露能力是否已配置，不返回任何 secret、token 或访问码。
export async function onRequestGet({ env, request }) {
  let deploymentManifestUrl = null;
  for (const candidate of [env.CF_PAGES_URL, request?.url]) {
    try {
      const parsed = new URL(String(candidate || ""));
      if (parsed.protocol !== "https:") continue;
      deploymentManifestUrl = new URL(
        `/data/deployment.json?ts=${Date.now()}`,
        parsed,
      ).href;
      break;
    } catch {
      // The health payload reports missing deployment metadata below.
    }
  }
  const [
    reportsCheck,
    actionsCheck,
    volguardCheck,
    manifestCheck,
    stateCheck,
  ] = await Promise.all([
    checkJson("reports", `${RAW_BASE}/data/latest.json?ts=${Date.now()}`),
    checkJson("actions", `https://api.github.com/repos/${REPO}/actions/runs?per_page=1`, {
      headers: ghHeaders(env),
    }),
    checkVolguard(env),
    checkDeploymentManifest(
      deploymentManifestUrl,
      env.CF_PAGES_COMMIT_SHA,
    ),
    // 与静态 manifest fetch 同时发起，不等它失败后才顺序回退——
    // 生产实测过顺序回退会把两次探测的延迟叠加，稳定撞满 D1 独立预算。
    checkDeploymentState(env.DB, env.CF_PAGES_COMMIT_SHA),
  ]);
  const checks = [
    reportsCheck,
    actionsCheck,
    volguardCheck,
    manifestCheck.ok ? manifestCheck : stateCheck,
  ];

  return json(
    buildHealthPayload(env, checks),
    200,
    { "cache-control": "no-store" },
  );
}
