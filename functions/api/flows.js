import { serveDynamic, unavailableEnvelope } from "./_dynamic_api.mjs";
import { queryFundFlows } from "./_d1_repository.mjs";
import {
  fundFlowCapabilities,
  fundFlowQueryCapabilities,
  isFundFlowApplicable,
} from "./_fund_flow_contract.mjs";
import { json } from "./_util.js";

const NO_STORE = { "cache-control": "no-store" };

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
    query(db, filters) {
      return isFundFlowApplicable(filters) ? queryFundFlows(db, filters) : [];
    },
    cursorColumn: ["ts", "id"],
    envelopeExtras: { capabilities },
  });
}
