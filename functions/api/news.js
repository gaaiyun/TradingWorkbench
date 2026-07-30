import { serveDynamic } from "./_dynamic_api.mjs";
import { queryNewsItems } from "./_d1_repository.mjs";

const MAX_NEWS_LIMIT = 2000;
const COMMUNICATIONS_TITLE =
  /(通信ETF|光模块|光通信|通信设备|5G|6G)/i;
const SEMICONDUCTOR_TITLE =
  /(半导体ETF|芯片ETF|半导体|芯片|集成电路)/i;
const POLICY_AUTHORITY =
  /(国务院|国家发展改革委|工信部|工业和信息化部|证监会|财政部(?!长))/i;
const POLICY_ACTION =
  /(发布|印发|通知|意见|办法|规划|公告|决定|征求意见|答记者问|政策)/i;

export function isRelevantAShareDiscovery(row) {
  if (row?.source_tier !== "discovery") return true;
  const title = String(row?.title || "");
  const summary = String(row?.summary || "");
  if (row?.topic === "communications") return COMMUNICATIONS_TITLE.test(title);
  if (row?.topic === "cn-semiconductor") return SEMICONDUCTOR_TITLE.test(title);
  if (row?.topic !== "policy") return true;
  if (COMMUNICATIONS_TITLE.test(title) || SEMICONDUCTOR_TITLE.test(title)) return true;
  return POLICY_AUTHORITY.test(title)
    && POLICY_ACTION.test(title)
    && (COMMUNICATIONS_TITLE.test(summary) || SEMICONDUCTOR_TITLE.test(summary));
}

async function queryRelevantNewsItems(db, filters) {
  const requestedLimit = filters.limit;
  const rows = await queryNewsItems(db, {
    ...filters,
    limit: Math.min(MAX_NEWS_LIMIT, requestedLimit * 4),
  });
  return rows.filter(isRelevantAShareDiscovery).slice(0, requestedLimit);
}

export function onRequestGet(context) {
  return serveDynamic(context, {
    capabilities: { symbol: true, profile: true, topic: true, tier: true },
    query: queryRelevantNewsItems,
    statusScope: "latest-as-of",
  });
}
