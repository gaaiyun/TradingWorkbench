import { serveDynamic } from "./_dynamic_api.mjs";
import { queryMarketEvents } from "./_d1_repository.mjs";

export function onRequestGet(context) {
  return serveDynamic(context, {
    capabilities: {
      symbol: true,
      profile: true,
      topic: true,
      importance: true,
      after: true,
    },
    query: queryMarketEvents,
    cursorColumn: ["event_at", "id"],
  });
}
