export const DEFAULT_ANALYSTS = Object.freeze(["market", "news", "fundamentals"]);
export const MAX_ANALYSIS_WEIGHT = 6;

const ANALYST_ALIASES = new Map([
  ["market", "market"],
  ["news", "news"],
  ["fundamentals", "fundamentals"],
  ["social", "social"],
  ["sentiment", "social"],
]);
const RESEARCH_DEPTH_WEIGHTS = Object.freeze({ standard: 1, deep: 2 });
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export class AnalysisRequestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AnalysisRequestError";
    this.code = code;
    this.details = details;
  }
}

function values(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",");
  return null;
}

function capabilitySet(value) {
  return new Set(
    (values(value) ?? [])
      .map((entry) => String(entry).trim().toLowerCase())
      .filter(Boolean),
  );
}

export function normalizeRequestId(value, { generate = true } = {}) {
  if (value === undefined || value === null || value === "") {
    return generate ? globalThis.crypto.randomUUID() : "";
  }
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new AnalysisRequestError(
      "invalid_request_id",
      "requestId 必须是 UUID",
    );
  }
  return value.toLowerCase();
}

export function normalizeAnalysts(value, { capabilities } = {}) {
  const requested = value === undefined || value === null || value === ""
    ? DEFAULT_ANALYSTS
    : values(value);
  if (!requested || requested.length === 0) {
    throw new AnalysisRequestError(
      "invalid_analysts",
      "analysts 必须是非空白名单数组",
    );
  }

  const normalized = [];
  for (const entry of requested) {
    const key = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    const analyst = ANALYST_ALIASES.get(key);
    if (!analyst) {
      throw new AnalysisRequestError(
        "invalid_analysts",
        "analysts 包含不支持的分析师",
      );
    }
    if (!normalized.includes(analyst)) normalized.push(analyst);
  }
  if (normalized.length === 0) {
    throw new AnalysisRequestError(
      "invalid_analysts",
      "analysts 必须是非空白名单数组",
    );
  }

  const enabled = capabilitySet(capabilities);
  if (
    normalized.includes("social") &&
    !enabled.has("social") &&
    !enabled.has("sentiment")
  ) {
    throw new AnalysisRequestError(
      "analysis_capability_unavailable",
      "sentiment/social 分析能力尚未开放",
    );
  }
  return normalized;
}

export function normalizeResearchDepth(value) {
  const depth = value === undefined || value === null || value === ""
    ? "standard"
    : value;
  if (
    typeof depth !== "string" ||
    !Object.hasOwn(RESEARCH_DEPTH_WEIGHTS, depth)
  ) {
    throw new AnalysisRequestError(
      "invalid_research_depth",
      "researchDepth 仅支持 standard 或 deep",
    );
  }
  return depth;
}

export function enforceAnalysisWorkload(tickerCount, researchDepth) {
  const depthWeight = RESEARCH_DEPTH_WEIGHTS[researchDepth];
  const weight = tickerCount * depthWeight;
  if (weight > MAX_ANALYSIS_WEIGHT) {
    throw new AnalysisRequestError(
      "analysis_workload_exceeded",
      `分析工作量超过上限 ${MAX_ANALYSIS_WEIGHT}`,
      {
        limit: { weight: MAX_ANALYSIS_WEIGHT },
        actual: { tickers: tickerCount, depthWeight, weight },
      },
    );
  }
  return weight;
}

export function researchDepthRounds(researchDepth) {
  return RESEARCH_DEPTH_WEIGHTS[researchDepth];
}
