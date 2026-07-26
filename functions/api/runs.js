import { REPO, ghHeaders, json } from "./_util.js";
import {
  identityMatches,
  parseRunSelectors,
  runIdentityFromTitle,
} from "./_run_identity.mjs";

const WORKFLOWS = ["daily-analysis.yml", "analysis-request.yml"];

// GET /api/runs → 最近的分析运行状态（两个工作流合并，按时间倒序）
export async function onRequestGet({ request, env }) {
  let selectors;
  try {
    selectors = parseRunSelectors(request, { requestId: true });
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const all = [];
  for (const wf of WORKFLOWS) {
    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${wf}/runs?per_page=100`,
      { headers: ghHeaders(env), cf: { cacheTtl: 15, cacheEverything: true } },
    );
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const r of data.workflow_runs || []) {
      const identity = {
        ...runIdentityFromTitle(r.display_title),
        runId: String(r.id),
      };
      all.push({
        id: r.id,
        workflow: wf.replace(".yml", ""),
        title: r.display_title,
        status: r.status,            // queued | in_progress | completed
        conclusion: r.conclusion,    // success | failure | ...
        created_at: r.created_at,
        url: r.html_url,
        identity,
        requestId: identity.requestId,
        profileId: identity.profileId,
        slotId: identity.slotId,
        scheduledFor: identity.scheduledFor,
      });
    }
  }
  all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const selected = selectors.hasSelector
    ? all.filter((run) => identityMatches(run.identity, selectors))
    : all;
  return json(
    { runs: selected.slice(0, 10) },
    200,
    { "cache-control": "public, max-age=15" },
  );
}
