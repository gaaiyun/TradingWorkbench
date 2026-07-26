import { json, proxyRaw } from "./_util.js";
import {
  identityMatches,
  parseRunSelectors,
} from "./_run_identity.mjs";

// GET /api/latest → main 分支上最新的 latest.json（随每次运行 commit 更新）
export async function onRequestGet({ request } = {}) {
  let selectors;
  try {
    selectors = parseRunSelectors(request);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  if (!selectors.hasSelector) {
    // The unscoped endpoint feeds the homepage, notifications, and other
    // "latest opinion" consumers.  It must never expose a report that the
    // evidence gate rejected.  Keep the raw response shape, but apply the
    // audit index as a second, independent gate before returning results.
    const [latestResponse, auditResponse] = await Promise.all([
      proxyRaw("data/latest.json", { cacheSeconds: 60 }),
      proxyRaw("data/report-audit.json", { cacheSeconds: 60 }),
    ]);
    if (!latestResponse.ok) return latestResponse;
    if (!auditResponse.ok) {
      return json(
        { status: "unavailable", error: "最新观点审计索引不可用", results: [] },
        503,
      );
    }
    let latest;
    let audit;
    try {
      latest = await latestResponse.json();
      audit = await auditResponse.json();
    } catch {
      return json(
        { status: "unavailable", error: "最新观点数据或审计索引无效", results: [] },
        502,
      );
    }
    if (!latest || !Array.isArray(latest.results) || !audit || !Array.isArray(audit.reports)) {
      return json(
        { status: "unavailable", error: "最新观点数据或审计索引无效", results: [] },
        502,
      );
    }
    const verifiedReports = new Set(
      audit.reports
        .filter((entry) =>
          entry?.auditStatus === "verified" &&
          entry?.analysisStatus === "rated" &&
          entry?.claimValidation?.status === "passed")
        .map((entry) => String(entry.report || "")),
    );
    const results = latest.results.filter((entry) =>
      verifiedReports.has(String(entry?.report || "")),
    );
    if (latest.results.length === 0) {
      return new Response(JSON.stringify(latest), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=60",
        },
      });
    }
    return json(
      {
        ...latest,
        results,
        evidenceGate: {
          policy: "verified-only",
          source: "data/report-audit.json",
          filteredCount: latest.results.length - results.length,
        },
      },
      200,
      { "cache-control": "public, max-age=60" },
    );
  }
  const response = await proxyRaw("data/history.json", { cacheSeconds: 60 });
  if (!response.ok) return response;
  let history;
  try {
    history = await response.json();
  } catch {
    return json({ error: "历史索引无效" }, 502);
  }
  if (!Array.isArray(history)) return json({ error: "历史索引无效" }, 502);
  const matches = history.filter(
    (entry) => identityMatches(entry?.identity, selectors),
  );
  matches.sort((left, right) => String(
    right?.generated_at || right?.trade_date || "",
  ).localeCompare(String(left?.generated_at || left?.trade_date || "")));
  if (!matches.length) return json({ error: "没有匹配的运行结果" }, 404);
  return json(matches[0], 200, { "cache-control": "public, max-age=60" });
}
