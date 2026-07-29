import { json, proxyRaw } from "./_util.js";
import {
  identityMatches,
  parseRunSelectors,
} from "./_run_identity.mjs";

// GET /api/report?path=reports/NVDA/2026-07-10/complete_report.md
// 只允许 reports/ 下的 .md，防任意路径代理。
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const path = url.searchParams.get("path") || "";
  if (!/^reports\/[A-Za-z0-9._\-\/]+\.md$/.test(path) || path.includes("..")) {
    return json({ error: "非法报告路径" }, 400);
  }
  let selectors;
  try {
    selectors = parseRunSelectors(request);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  if (selectors.hasSelector) {
    const parts = path.split("/");
    if (parts.length < 4) return json({ error: "报告不存在" }, 404);
    const manifestPath = `${parts.slice(0, 3).join("/")}/report_manifest.json`;
    const manifestResponse = await proxyRaw(manifestPath, { cacheSeconds: 300 });
    if (!manifestResponse.ok) {
      return manifestResponse.status === 404
        ? json({ error: "报告不存在" }, 404)
        : manifestResponse;
    }
    let manifest;
    try {
      manifest = await manifestResponse.json();
    } catch {
      return json({ error: "报告不存在" }, 404);
    }
    if (!identityMatches(manifest?.identity, selectors)) {
      return json({ error: "报告不存在" }, 404);
    }
    if (
      manifest?.claimValidation?.status === "failed" &&
      !path.endsWith("/complete_report.md")
    ) {
      return json({
        error: "报告未通过证据门禁，仅可读取完整报告",
      }, 409);
    }
  }
  return proxyRaw(path, { cacheSeconds: 300 });
}
