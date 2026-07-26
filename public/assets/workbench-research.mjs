const STAGE_IDS = Object.freeze(["analysts", "debate", "trader", "risk"]);
const DEFAULT_ANALYSTS = Object.freeze(["market", "news", "fundamentals"]);
const VERIFIED_ANALYSTS = new Set(DEFAULT_ANALYSTS);
const RESEARCH_TICKER_LIMITS = Object.freeze({ standard: 6, deep: 3 });
const REQUEST_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ARCHIVE_FILE_COLUMNS = Object.freeze([
  Object.freeze({ id: "market", label: "技术 / 市场", relative: "1_analysts/market.md" }),
  Object.freeze({ id: "fundamentals", label: "基本面", relative: "1_analysts/fundamentals.md" }),
  Object.freeze({ id: "sentiment", label: "市场情绪", relative: "1_analysts/sentiment.md" }),
  Object.freeze({ id: "news", label: "新闻", relative: "1_analysts/news.md" }),
  Object.freeze({ id: "bull", label: "多方", relative: "2_research/bull.md" }),
  Object.freeze({ id: "bear", label: "空方", relative: "2_research/bear.md" }),
  Object.freeze({ id: "manager", label: "研究经理", relative: "2_research/manager.md" }),
  Object.freeze({ id: "trader", label: "交易方案", relative: "3_trading/trader.md" }),
  Object.freeze({ id: "aggressive", label: "激进风险", relative: "4_risk/aggressive.md" }),
  Object.freeze({ id: "neutral", label: "中性风险", relative: "4_risk/neutral.md" }),
  Object.freeze({ id: "conservative", label: "保守风险", relative: "4_risk/conservative.md" }),
  Object.freeze({ id: "decision", label: "组合决策", relative: "5_portfolio/decision.md" }),
  Object.freeze({ id: "complete_report", label: "完整报告", relative: "complete_report.md" }),
]);

function normalizedTickers(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,，;；]+/);
  const seen = new Set();
  return values
    .map((ticker) => String(ticker || "").trim().toUpperCase().replace(/\.SH$/, ".SS"))
    .filter((ticker) => ticker && !seen.has(ticker) && seen.add(ticker));
}

export function researchTickerLimit(researchDepth = "standard") {
  return RESEARCH_TICKER_LIMITS[researchDepth] || RESEARCH_TICKER_LIMITS.standard;
}

export function createTemporaryResearchRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildTemporaryResearchRequest({
  requestId,
  tickers,
  analysts = DEFAULT_ANALYSTS,
  researchDepth = "standard",
} = {}) {
  const normalized = normalizedTickers(tickers);
  const normalizedRequestId = String(requestId || "").toLowerCase();
  if (!REQUEST_UUID.test(normalizedRequestId)) throw new Error("requestId 必须是 UUID");
  if (!Object.hasOwn(RESEARCH_TICKER_LIMITS, researchDepth)) {
    throw new Error("researchDepth 仅支持 standard 或 deep");
  }
  const normalizedAnalysts = Array.isArray(analysts)
    ? [...new Set(analysts.map((analyst) => String(analyst).trim().toLowerCase()).filter(Boolean))]
    : [];
  if (!normalizedAnalysts.length || normalizedAnalysts.some((analyst) => !VERIFIED_ANALYSTS.has(analyst))) {
    throw new Error("请至少选择一位已验证分析师");
  }
  const limit = researchTickerLimit(researchDepth);
  if (!normalized.length) throw new Error("请至少输入 1 个研究标的");
  if (normalized.length > limit) {
    throw new Error(`${researchDepth} 研究最多支持 ${limit} 个标的`);
  }
  return {
    requestId: normalizedRequestId,
    tickers: normalized,
    analysts: normalizedAnalysts,
    researchDepth,
  };
}

function archiveBaseDir(report) {
  const parts = String(report || "").split("/");
  const safeSegment = (value) => (
    value !== "."
    && value !== ".."
    && /^[A-Za-z0-9._-]+$/.test(value)
  );
  if (
    parts.length !== 4
    || parts[0] !== "reports"
    || !safeSegment(parts[1])
    || !safeSegment(parts[2])
    || parts[3] !== "complete_report.md"
  ) return "";
  return parts.slice(0, 3).join("/");
}

export function buildArchiveFileTabs(entry) {
  const files = { ...(entry?.files || {}) };
  const baseDir = archiveBaseDir(entry?.report);
  if (!baseDir) return [];
  return ARCHIVE_FILE_COLUMNS
    .map(({ id, label, relative }) => {
      const expectedPath = `${baseDir}/${relative}`;
      const actualPath = id === "complete_report" ? entry.report : files[id];
      return actualPath === expectedPath ? { id, label, path: expectedPath } : null;
    })
    .filter(Boolean);
}

export function defaultArchiveFileTab(tabs) {
  if (!Array.isArray(tabs) || !tabs.length) return null;
  return tabs.find(({ id }) => id === "decision") || tabs[0];
}

function identityKey(identity) {
  if (
    identity?.scope === "profile"
    && PROFILE_ID.test(identity.profileId || "")
    && identity.requestId == null
  ) return `profile:${identity.profileId}`;
  if (
    identity?.scope === "adhoc"
    && identity.profileId == null
    && REQUEST_UUID.test(identity.requestId || "")
  ) return `adhoc:${String(identity.requestId).toLowerCase()}`;
  if (
    (!identity || identity.scope === "legacy")
    && identity?.profileId == null
    && identity?.requestId == null
  ) return "legacy";
  return "invalid";
}

function auditMap(auditIndex) {
  return new Map(
    (Array.isArray(auditIndex?.reports) ? auditIndex.reports : [])
      .filter((entry) => entry?.report)
      .map((entry) => [
        `${String(entry.report)}\u0000${identityKey(entry.identity)}`,
        entry,
      ]),
  );
}

export function buildArchiveEntries(history, auditIndex = null, { includeInvalidated = false } = {}) {
  if (!Array.isArray(history)) return [];
  const audits = auditMap(auditIndex);
  return history
    .flatMap((batch) => (Array.isArray(batch?.results) ? batch.results : [])
      .filter((result) => result && result.error !== true && result.report)
      .map((result) => {
        const report = String(result.report);
        const identity = batch.identity && typeof batch.identity === "object"
          ? { ...batch.identity }
          : null;
        const audit = audits.get(`${report}\u0000${identityKey(identity)}`) || null;
        return {
          ticker: String(result.ticker || ""),
          rating: String(result.rating || ""),
          report,
          files: { ...(result.files || {}) },
          tradeDate: batch.trade_date || null,
          generatedAt: batch.generated_at || null,
          provider: batch.provider || null,
          identity,
          request: batch.request && typeof batch.request === "object"
            ? { ...batch.request }
            : null,
          run: batch.run && typeof batch.run === "object"
            ? { ...batch.run }
            : null,
          auditStatus: audit?.auditStatus || "unverified",
          problemCodes: Array.isArray(audit?.problemCodes) ? audit.problemCodes : [],
        };
      })
      .filter((entry) => (
        includeInvalidated
        || (
          !["invalidated", "invalid_record"].includes(entry.auditStatus)
          && identityKey(entry.identity) !== "legacy"
          && identityKey(entry.identity) !== "invalid"
        )
      )))
    .sort((left, right) => String(right.generatedAt || right.tradeDate || "")
      .localeCompare(String(left.generatedAt || left.tradeDate || "")));
}

function archiveReportSelector(entry) {
  const identity = entry?.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("报告身份缺失");
  }
  if (
    identity.scope === "profile"
    && PROFILE_ID.test(identity.profileId || "")
    && identity.requestId == null
  ) {
    return { scope: "profile", profileId: identity.profileId };
  }
  if (
    identity.scope === "adhoc"
    && identity.profileId == null
    && REQUEST_UUID.test(identity.requestId || "")
  ) {
    return {
      scope: "adhoc",
      requestId: String(identity.requestId).toLowerCase(),
    };
  }
  if (
    identity.scope === "legacy"
    && identity.profileId == null
    && identity.requestId == null
  ) {
    return { scope: "legacy" };
  }
  throw new Error("报告身份无效");
}

export function buildArchiveReportUrl(entry, path = entry?.report) {
  if (!path) throw new Error("报告路径缺失");
  const selector = archiveReportSelector(entry);
  const params = new URLSearchParams({ path: String(path) });
  if (selector.scope === "profile") params.set("profile", selector.profileId);
  if (selector.scope === "adhoc") params.set("requestId", selector.requestId);
  return `/api/report?${params.toString()}`;
}

export function archiveChatContext(entry) {
  if (entry?.auditStatus !== "verified") return null;
  let selector;
  try {
    selector = archiveReportSelector(entry);
  } catch {
    return null;
  }
  if (selector.scope === "profile") return { profileId: selector.profileId };
  if (selector.scope === "adhoc") {
    return {
      reportRequestId: selector.requestId,
      reportScope: "adhoc",
    };
  }
  return null;
}

export function filterAuditedResults(
  results,
  auditIndex,
  { includeInvalidated = false, verifiedOnly = false, identity = null } = {},
) {
  const audits = auditMap(auditIndex);
  const auditRows = Array.isArray(auditIndex?.reports) ? auditIndex.reports : [];
  return (Array.isArray(results) ? results : [])
    .filter((result) => result && result.error !== true && result.report)
    .map((result) => {
      const resultIdentity = result.identity || identity;
      const audit = resultIdentity
        ? audits.get(`${String(result.report)}\u0000${identityKey(resultIdentity)}`) || null
        : auditRows.find((entry) => String(entry?.report) === String(result.report)) || null;
      return {
        ...result,
        audit,
      };
    })
    .filter(({ audit }) => (
      verifiedOnly
        ? audit?.auditStatus === "verified"
        : includeInvalidated || !["invalidated", "invalid_record"].includes(audit?.auditStatus)
    ));
}

export function buildPipelineStages(run) {
  const stages = STAGE_IDS.map((id) => ({ id, status: "pending" }));
  if (!run) return stages;
  if (run.status === "queued") {
    stages[0].status = "queued";
    return stages;
  }
  if (run.status === "in_progress") {
    stages[0].status = "running";
    return stages;
  }
  if (run.status !== "completed") return stages;
  if (run.conclusion === "success") {
    return stages.map((stage) => ({ ...stage, status: "completed" }));
  }
  stages[0].status = "failed";
  for (let index = 1; index < stages.length; index += 1) stages[index].status = "unknown";
  return stages;
}

export function archivedResearchAfterRun(run, latest) {
  if (run?.status !== "completed" || run?.conclusion !== "failure") return false;
  const runAt = new Date(run.created_at).valueOf();
  const generatedAt = new Date(latest?.generated_at).valueOf();
  const hasReport = Array.isArray(latest?.results) && latest.results.some(
    (result) => result?.error !== true && result?.report,
  );
  return Number.isFinite(runAt) &&
    Number.isFinite(generatedAt) &&
    generatedAt >= runAt &&
    hasReport;
}

export function latestResearchRun(runs) {
  if (!Array.isArray(runs)) return null;
  return runs
    .filter((run) => run?.created_at && !Number.isNaN(new Date(run.created_at).valueOf()))
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))[0] || null;
}

export function researchRunForRequest(runs, requestId) {
  const key = String(requestId || "").toLowerCase();
  if (!key || !Array.isArray(runs)) return null;
  return latestResearchRun(
    runs.filter((run) => String(run?.requestId || "").toLowerCase() === key),
  );
}

export function archivedResearchForRequest(history, requestId) {
  const key = String(requestId || "").toLowerCase();
  if (!key || !Array.isArray(history)) return null;
  return history.find(
    (batch) => String(batch?.request?.requestId || "").toLowerCase() === key,
  ) || null;
}
