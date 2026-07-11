import { REPO, ghHeaders, json } from "./_util.js";

const WORKFLOWS = ["daily-analysis.yml", "analysis-request.yml"];

// GET /api/runs → 最近的分析运行状态（两个工作流合并，按时间倒序）
export async function onRequestGet({ env }) {
  const all = [];
  for (const wf of WORKFLOWS) {
    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${wf}/runs?per_page=6`,
      { headers: ghHeaders(env), cf: { cacheTtl: 15, cacheEverything: true } },
    );
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const r of data.workflow_runs || []) {
      all.push({
        id: r.id,
        workflow: wf.replace(".yml", ""),
        title: r.display_title,
        status: r.status,            // queued | in_progress | completed
        conclusion: r.conclusion,    // success | failure | ...
        created_at: r.created_at,
        url: r.html_url,
      });
    }
  }
  all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return json({ runs: all.slice(0, 10) }, 200, { "cache-control": "public, max-age=15" });
}
