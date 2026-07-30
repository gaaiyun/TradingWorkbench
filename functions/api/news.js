import { serveDynamic } from "./_dynamic_api.mjs";
import { queryNewsItems } from "./_d1_repository.mjs";

const MAX_NEWS_LIMIT = 2000;
const POLICY_SECTOR =
  /(半导体|芯片|集成电路|通信ETF|光模块|光通信|通信设备|5G|6G)/i;
const POLICY_AUTHORITY =
  /(国务院|国家发展改革委|工信部|工业和信息化部|证监会|财政部)/i;

export function isRelevantPolicyDiscovery(row) {
  if (row?.topic !== "policy" || row?.source_tier !== "discovery") return true;
  if (POLICY_SECTOR.test(String(row?.title || ""))) return true;
  return POLICY_AUTHORITY.test(String(row?.title || ""))
    && POLICY_SECTOR.test(String(row?.summary || ""));
}

async function queryRelevantNewsItems(db, filters) {
  const requestedLimit = filters.limit;
  const rows = await queryNewsItems(db, {
    ...filters,
    limit: Math.min(MAX_NEWS_LIMIT, requestedLimit * 4),
  });
  return rows.filter(isRelevantPolicyDiscovery).slice(0, requestedLimit);
}

export function onRequestGet(context) {
  return serveDynamic(context, {
    capabilities: { symbol: true, profile: true, topic: true, tier: true },
    query: queryRelevantNewsItems,
    statusScope: "latest-as-of",
  });
}
