import {
  dynamicEnvelope,
  DynamicQueryError,
  parseDynamicQuery,
  unavailableEnvelope,
} from "./_dynamic_api.mjs";
import {
  d1Binding,
  queryNotificationStatus,
  querySourceHealth,
} from "./_d1_repository.mjs";
import { json } from "./_util.js";

export async function onRequestGet({ request, env }) {
  let query;
  try {
    query = parseDynamicQuery(request, {
      source: true,
      profile: true,
      after: true,
    });
  } catch (error) {
    if (error instanceof DynamicQueryError) {
      return json({
        ...unavailableEnvelope(error.message),
        notifications: [],
        cursor: null,
      }, 400, { "cache-control": "no-store" });
    }
    throw error;
  }
  const db = d1Binding(env);
  if (!db) {
    return json({
      ...unavailableEnvelope(),
      notifications: [],
      cursor: null,
    }, 200, { "cache-control": "no-store" });
  }
  try {
    const [health, notifications] = await Promise.all([
      querySourceHealth(db, query),
      queryNotificationStatus(db, query),
    ]);
    return json({
      ...dynamicEnvelope(health, { health: true }),
      notifications,
      cursor: notifications[0]?.updatedAt ?? null,
    }, 200, { "cache-control": "no-store" });
  } catch {
    return json({
      ...unavailableEnvelope(),
      notifications: [],
      cursor: null,
    }, 200, { "cache-control": "no-store" });
  }
}
