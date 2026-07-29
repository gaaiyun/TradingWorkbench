import { serveDynamic } from "./_dynamic_api.mjs";
import { queryNewsItems } from "./_d1_repository.mjs";

export function onRequestGet(context) {
  return serveDynamic(context, {
    capabilities: { symbol: true, profile: true, topic: true, tier: true },
    query: queryNewsItems,
    statusScope: "latest-as-of",
  });
}
