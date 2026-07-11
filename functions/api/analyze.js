import { REPO, gate, ghHeaders, json, readJsonBody } from "./_util.js";

// POST /api/analyze {code, tickers} → 触发 GitHub Actions daily-analysis 工作流
export async function onRequestPost({ request, env }) {
  const body = await readJsonBody(request);
  if (!body) return json({ error: "请求体不是合法 JSON" }, 400);
  if (!gate(env, body.code)) return json({ error: "访问码不正确" }, 401);

  const tickers = String(body.tickers || "")
    .split(/[,，\s]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 5)
    .join(",");
  if (!tickers) return json({ error: "缺少标的代码" }, 400);
  if (!env.GITHUB_DISPATCH_TOKEN) return json({ error: "服务端未配置 GITHUB_DISPATCH_TOKEN" }, 500);

  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/daily-analysis.yml/dispatches`,
    {
      method: "POST",
      headers: { ...ghHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { tickers } }),
    },
  );
  if (resp.status !== 204) {
    const detail = await resp.text();
    return json({ error: `GitHub dispatch 失败 (${resp.status})`, detail: detail.slice(0, 300) }, 502);
  }
  return json({ ok: true, tickers, message: "已受理，分析约需 5–20 分钟" }, 202);
}
