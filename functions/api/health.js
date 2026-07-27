import { RAW_BASE, REPO, ghHeaders, json } from "./_util.js";
import {
  buildHealthPayload,
  checkDeploymentManifest,
  checkDeploymentState,
  checkJson,
} from "./_health.mjs";

const VOLGUARD_LIVE = "https://sh50-volguard.pages.dev/api/live";

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
  const checks = await Promise.all([
    checkJson("reports", `${RAW_BASE}/data/latest.json?ts=${Date.now()}`),
    checkJson("actions", `https://api.github.com/repos/${REPO}/actions/runs?per_page=1`, {
      headers: ghHeaders(env),
    }),
    checkJson("options_live", `${env.VOLGUARD_LIVE_URL || VOLGUARD_LIVE}?ts=${Date.now()}`),
    checkDeploymentManifest(
      deploymentManifestUrl,
      env.CF_PAGES_COMMIT_SHA,
    ),
  ]);
  if (!checks.at(-1)?.ok) {
    checks[checks.length - 1] = await checkDeploymentState(
      env.DB,
      env.CF_PAGES_COMMIT_SHA,
    );
  }

  return json(
    buildHealthPayload(env, checks),
    200,
    { "cache-control": "no-store" },
  );
}
