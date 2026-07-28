export const FUND_FLOW_TYPES = Object.freeze([
  "margin_balance",
  "margin_buy",
  "margin_net_buy",
  "constituent_margin_balance",
  "constituent_margin_net_buy",
  "fund_scale",
  "shares_outstanding_derived",
  "shares_outstanding_snapshot",
]);

export const FUND_FLOW_PERIODS = Object.freeze(["1d"]);

export const MARGIN_DAILY_SYMBOLS = Object.freeze([
  "515880.SS",
  "512480.SS",
  "159995.SZ",
]);

export const SHANGHAI_DERIVED_SHARE_SYMBOLS = Object.freeze([
  "515880.SS",
  "512480.SS",
]);

export const SNAPSHOT_SHARE_SYMBOLS = Object.freeze([
  "515880.SS",
  "512480.SS",
  "159995.SZ",
]);

const FLOW_TYPE_SET = new Set(FUND_FLOW_TYPES);
const FLOW_PERIOD_SET = new Set(FUND_FLOW_PERIODS);
const MARGIN_SYMBOL_SET = new Set(MARGIN_DAILY_SYMBOLS);
const DERIVED_SHARE_SYMBOL_SET = new Set(SHANGHAI_DERIVED_SHARE_SYMBOLS);
const SNAPSHOT_SHARE_SYMBOL_SET = new Set(SNAPSHOT_SHARE_SYMBOLS);
const ETF_SYMBOL_SET = new Set([
  ...SHANGHAI_DERIVED_SHARE_SYMBOLS,
  ...SNAPSHOT_SHARE_SYMBOLS,
]);
const MARGIN_TYPES = new Set(["margin_balance", "margin_buy", "margin_net_buy"]);
const CONSTITUENT_MARGIN_TYPES = new Set([
  "constituent_margin_balance",
  "constituent_margin_net_buy",
]);

export function fundFlowQueryCapabilities() {
  return {
    symbol: true,
    profile: true,
    type: FLOW_TYPE_SET,
    period: FLOW_PERIOD_SET,
    source: true,
    after: true,
    strict: true,
  };
}

export function fundFlowCapabilities(symbol = null, enabled = true) {
  if (!enabled) {
    return {
      marketFlowV1: false,
      marginDaily: false,
      constituentMarginDaily: false,
      etfSharesDaily: false,
      historicalPercentile: false,
    };
  }
  const supported = symbol === null || ETF_SYMBOL_SET.has(symbol);
  return {
    marketFlowV1: true,
    marginDaily: symbol === null || MARGIN_SYMBOL_SET.has(symbol),
    constituentMarginDaily: symbol === null || MARGIN_SYMBOL_SET.has(symbol),
    etfSharesDaily: supported,
    historicalPercentile: supported,
  };
}

export function isFundFlowApplicable({ symbol, type }) {
  if (!symbol) return true;
  if (!ETF_SYMBOL_SET.has(symbol)) return false;
  if (!type || type === "fund_scale") return true;
  if (MARGIN_TYPES.has(type)) return MARGIN_SYMBOL_SET.has(symbol);
  if (CONSTITUENT_MARGIN_TYPES.has(type)) return MARGIN_SYMBOL_SET.has(symbol);
  if (type === "shares_outstanding_derived") return DERIVED_SHARE_SYMBOL_SET.has(symbol);
  if (type === "shares_outstanding_snapshot") return SNAPSHOT_SHARE_SYMBOL_SET.has(symbol);
  return false;
}
