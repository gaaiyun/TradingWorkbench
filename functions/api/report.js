import { json, proxyRaw } from "./_util.js";
import {
  identityMatches,
  parseRunSelectors,
} from "./_run_identity.mjs";

function safeFailClosedReport(manifest) {
  const ticker = /^[A-Za-z0-9._-]+$/.test(String(manifest?.ticker || ""))
    ? String(manifest.ticker)
    : "Unknown";
  const tradeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(manifest?.tradeDate || ""))
    ? String(manifest.tradeDate)
    : "unknown";
  return new Response(
    `# Trading Analysis Report: ${ticker}\n\n`
      + `Trade date: ${tradeDate}\n\n`
      + "## Research conclusion\n\n"
      + "**Not Rated**\n\n"
      + "This report did not pass the evidence gate. Directional, allocation, and trading "
      + "conclusions are not published. Raw agent sections remain available only in the "
      + "GitHub audit record.\n",
    {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function claimGatePassed(claimValidation) {
  return claimValidation?.status === "passed"
    && Number(claimValidation?.omittedUnsafeParagraphs || 0) === 0;
}

function readableLegacyArchive(auditEntry, completeReportPath) {
  return auditEntry?.report === completeReportPath
    && auditEntry?.auditStatus === "legacy_unverified"
    && auditEntry?.analysisStatus !== "insufficient_evidence"
    && auditEntry?.claimValidation?.status !== "failed";
}

function legacyArchiveBanner(auditEntry) {
  const ticker = /^[A-Za-z0-9._-]+$/.test(String(auditEntry?.ticker || ""))
    ? String(auditEntry.ticker)
    : "Unknown";
  const tradeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(auditEntry?.tradeDate || ""))
    ? String(auditEntry.tradeDate)
    : "unknown";
  return "# Historical unverified report\n\n"
    + `> **Archive notice:** ${ticker} · ${tradeDate}. This is read-only historical output `
    + "that has not passed the current evidence gate. It is not current research or a "
    + "trading recommendation.\n\n---\n\n";
}

async function serveLegacyArchive(path, auditEntry) {
  const response = await proxyRaw(path, { cacheSeconds: 0 });
  if (!response.ok) return response;
  return new Response(`${legacyArchiveBanner(auditEntry)}${await response.text()}`, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Report-Audit-Status": "legacy_unverified",
    },
  });
}

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
  const parts = path.split("/");
  if (parts.length < 4) return json({ error: "报告不存在" }, 404);
  const completeReportPath = `${parts.slice(0, 3).join("/")}/complete_report.md`;
  // 门禁状态必须逐请求读取；报告失效后不能继续命中旧的 verified 缓存。
  const auditResponse = await proxyRaw("data/report-audit.json", { cacheSeconds: 0 });
  let auditEntry = null;
  if (auditResponse.ok) {
    try {
      const audit = await auditResponse.json();
      auditEntry = Array.isArray(audit?.reports)
        ? audit.reports.find((entry) => entry?.report === completeReportPath)
        : null;
    } catch {
      auditEntry = null;
    }
  }
  if (readableLegacyArchive(auditEntry, completeReportPath)) {
    if (selectors.hasSelector && !identityMatches(auditEntry?.identity, selectors)) {
      return json({ error: "报告不存在" }, 404);
    }
    return serveLegacyArchive(path, auditEntry);
  }

  const manifestPath = `${parts.slice(0, 3).join("/")}/report_manifest.json`;
  const manifestResponse = await proxyRaw(manifestPath, { cacheSeconds: 0 });
  if (!manifestResponse.ok) {
    if (auditEntry) {
      return path.endsWith("/complete_report.md")
        ? safeFailClosedReport(auditEntry)
        : json({
          error: "报告未通过证据门禁，仅可读取完整的 Not Rated 报告",
        }, 409);
    }
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
  if (selectors.hasSelector && !identityMatches(manifest?.identity, selectors)) {
    return json({ error: "报告不存在" }, 404);
  }
  const verified = auditEntry?.auditStatus === "verified"
    && auditEntry?.analysisStatus === "rated"
    && claimGatePassed(auditEntry?.claimValidation)
    && manifest?.auditStatus === "verified"
    && manifest?.analysisStatus === "rated"
    && claimGatePassed(manifest?.claimValidation);
  if (!verified) {
    if (path.endsWith("/complete_report.md")) {
      return safeFailClosedReport(manifest);
    }
    return json({
      error: "报告未通过证据门禁，仅可读取完整的 Not Rated 报告",
    }, 409);
  }
  // 即使当前已验证，也不允许客户端缓存 raw 响应越过后续失效判定。
  return proxyRaw(path, { cacheSeconds: 0 });
}
