import {
  dynamicEnvelope,
  DynamicQueryError,
  parseDynamicQuery,
  unavailableEnvelope,
} from "./_dynamic_api.mjs";
import {
  d1Binding,
  queryD1Capacity,
  queryNotificationStatus,
  querySourceHealth,
} from "./_d1_repository.mjs";
import { json } from "./_util.js";

export async function onRequestGet({ request, env }) {
  const capacityValue = new URL(request.url).searchParams.get("capacity");
  if (capacityValue !== null && capacityValue !== "1") {
    return json({
      ...unavailableEnvelope("无效的 capacity 参数"),
      notifications: [],
      cursor: null,
      capacity: {
        status: "unavailable",
        reason: "invalid_parameter",
        measuredAt: null,
        storage: null,
        tables: [],
      },
    }, 400, { "cache-control": "no-store" });
  }
  const includeCapacity = capacityValue === "1";
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
      ...(includeCapacity ? {
        capacity: {
          status: "unavailable",
          reason: "no_binding",
          measuredAt: null,
          storage: null,
          tables: [],
        },
      } : {}),
    }, 200, { "cache-control": "no-store" });
  }
  try {
    const [health, notifications, capacity] = await Promise.all([
      querySourceHealth(db, query),
      queryNotificationStatus(db, query),
      includeCapacity
        ? queryD1Capacity(db, env?.D1_CAPACITY_TIMEOUT_MS)
        : null,
    ]);
    const cursorRow = query.after ? notifications.at(-1) : notifications[0];
    return json({
      ...dynamicEnvelope(health, { health: true }),
      notifications,
      cursor: cursorRow
        ? JSON.stringify([
          cursorRow.updatedAt,
          `${cursorRow.eventId}:${cursorRow.channel}`,
        ])
        : null,
      ...(includeCapacity ? { capacity } : {}),
    }, 200, { "cache-control": "no-store" });
  } catch {
    return json({
      ...unavailableEnvelope(),
      notifications: [],
      cursor: null,
      ...(includeCapacity ? {
        capacity: {
          status: "unavailable",
          reason: "query_error",
          measuredAt: null,
          storage: null,
          tables: [],
        },
      } : {}),
    }, 200, { "cache-control": "no-store" });
  }
}
