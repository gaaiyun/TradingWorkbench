import { serveDynamic, unavailableEnvelope } from "./_dynamic_api.mjs";
import { queryFundFlows } from "./_d1_repository.mjs";
import {
  fundFlowCapabilities,
  fundFlowQueryCapabilities,
  isFundFlowApplicable,
} from "./_fund_flow_contract.mjs";
import { json } from "./_util.js";

const NO_STORE = { "cache-control": "no-store" };
const FUND_FLOW_FRESHNESS_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

export function onRequestGet(context) {
  const enabled = context.env?.FUND_FLOW_ENABLED === "true"
    || context.env?.FUND_FLOW_ENABLED === true;
  if (!enabled) {
    return json({
      ...unavailableEnvelope(),
      reason: "feature_disabled",
      capabilities: fundFlowCapabilities(null, false),
      cursor: null,
    }, 200, NO_STORE);
  }

  const symbol = new URL(context.request.url).searchParams.get("symbol")?.trim().toUpperCase() || null;
  const capabilities = fundFlowCapabilities(symbol);
  return serveDynamic(context, {
    capabilities: fundFlowQueryCapabilities(),
    statusScope: "latest-per-series",
    statusGroupColumns: ["profile_id", "symbol", "flow_type", "period", "source", "adjustment"],
    freshnessMaxAgeMs: FUND_FLOW_FRESHNESS_MAX_AGE_MS,
    query(db, filters) {
      return isFundFlowApplicable(filters) ? queryFundFlows(db, filters) : [];
    },
    cursorColumn: ["ts", "id"],
    envelopeExtras: { capabilities },
  });
}
