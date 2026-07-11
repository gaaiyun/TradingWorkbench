import { json, proxyRaw } from "./_util.js";

// GET /api/report?path=reports/NVDA/2026-07-10/complete_report.md
// 只允许 reports/ 下的 .md，防任意路径代理。
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const path = url.searchParams.get("path") || "";
  if (!/^reports\/[A-Za-z0-9._\-\/]+\.md$/.test(path) || path.includes("..")) {
    return json({ error: "非法报告路径" }, 400);
  }
  return proxyRaw(path, { cacheSeconds: 300 });
}
