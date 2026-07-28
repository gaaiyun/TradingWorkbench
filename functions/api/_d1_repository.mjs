export function d1Binding(env) {
  return env?.DB && typeof env.DB.prepare === "function" ? env.DB : null;
}

const CAPACITY_ROW_LIMIT = 100_001;
const CAPACITY_TABLES = Object.freeze([
  "market_bars",
  "news_items",
  "market_events",
  "evidence_packets",
  "report_manifests",
  "chat_messages",
  "notification_deliveries",
  "fund_flows",
]);

function unavailableCapacity(reason) {
  return {
    status: "unavailable",
    reason,
    measuredAt: null,
    storage: null,
    tables: [],
  };
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export async function queryD1Capacity(
  db,
  configuredTimeoutMs = 1500,
  measuredAt = new Date(),
) {
  if (!db?.prepare) return unavailableCapacity("no_binding");
  const timeoutMs = Math.min(
    3000,
    Math.max(25, Number(configuredTimeoutMs) || 1500),
  );
  const timedOut = Symbol("capacity-query-timeout");
  let timer;
  const aliases = CAPACITY_TABLES.map((table) => (
    `(SELECT COUNT(*) FROM (SELECT 1 FROM ${table} LIMIT ${CAPACITY_ROW_LIMIT})) AS ${table}`
  ));
  try {
    const query = (async () => {
      const counts = await db.prepare(`SELECT ${aliases.join(", ")}`).first();
      const tables = CAPACITY_TABLES.map((name) => {
        const boundedCount = safeInteger(counts?.[name]);
        if (boundedCount === null) throw new Error("capacity count unavailable");
        return {
          name,
          rowCount: boundedCount,
          atLeast: boundedCount >= CAPACITY_ROW_LIMIT,
        };
      });

      let storage = { status: "unsupported" };
      try {
        const [pageCountRow, pageSizeRow] = await Promise.all([
          db.prepare("PRAGMA page_count").first(),
          db.prepare("PRAGMA page_size").first(),
        ]);
        const pageCount = safeInteger(pageCountRow?.page_count);
        const pageSize = safeInteger(pageSizeRow?.page_size);
        if (pageCount !== null && pageSize !== null) {
          storage = {
            status: "ok",
            pageCount,
            pageSize,
            estimatedBytes: pageCount * pageSize,
          };
        }
      } catch {
        // Some D1/SQLite-compatible bindings do not expose PRAGMA metadata.
      }
      return {
        status: "ok",
        reason: null,
        measuredAt: measuredAt.toISOString(),
        storage,
        tables,
      };
    })();
    const result = await Promise.race([
      query,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    return result === timedOut
      ? unavailableCapacity("query_timeout")
      : result;
  } catch {
    return unavailableCapacity("query_error");
  } finally {
    clearTimeout(timer);
  }
}

export class SettingsConflictError extends Error {
  constructor(latest = null) {
    super("settings revision conflict");
    this.name = "SettingsConflictError";
    this.latest = latest;
  }
}

export async function readSettingsFromD1(db) {
  if (!db) return null;
  const row = await db.prepare(
    "SELECT version, settings_json, updated_at FROM workbench_settings WHERE id = ?",
  ).bind(1).first();
  if (!row) return null;
  return {
    version: row.version,
    settings: JSON.parse(row.settings_json),
    updatedAt: row.updated_at,
  };
}

export async function writeSettingsToD1(db, settings, expectedUpdatedAt, now = new Date()) {
  const expectedMilliseconds = typeof expectedUpdatedAt === "string"
    ? Date.parse(expectedUpdatedAt)
    : Number.NaN;
  const updatedMilliseconds = Number.isFinite(expectedMilliseconds)
    ? Math.max(now.valueOf(), expectedMilliseconds + 1)
    : now.valueOf();
  const updatedAt = new Date(updatedMilliseconds).toISOString();
  let result;
  if (expectedUpdatedAt === null) {
    result = await db.prepare(
      `INSERT INTO workbench_settings (id, version, settings_json, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(settings.version, JSON.stringify(settings), updatedAt).run();
  } else {
    result = await db.prepare(
      `UPDATE workbench_settings
       SET version = ?, settings_json = ?, updated_at = ?
       WHERE id = 1 AND updated_at = ?`,
    ).bind(settings.version, JSON.stringify(settings), updatedAt, expectedUpdatedAt).run();
  }
  const changes = result?.meta?.changes ?? result?.changes ?? 0;
  if (changes !== 1) throw new SettingsConflictError();
  return updatedAt;
}

export async function mutateSettingsInD1(
  db,
  mutation,
  expectedUpdatedAt = undefined,
  now = new Date(),
) {
  const stored = await readSettingsFromD1(db);
  if (!stored) return null;
  if (
    expectedUpdatedAt !== undefined &&
    expectedUpdatedAt !== stored.updatedAt
  ) {
    throw new SettingsConflictError(stored);
  }
  const settings = await mutation(stored.settings);
  const updatedAt = await writeSettingsToD1(db, settings, stored.updatedAt, now);
  return { settings, updatedAt };
}

async function queryRows(
  db,
  { table, columns, filters, timeColumn, keyColumn = null, from, to, after, limit },
) {
  const clauses = [];
  const values = [];
  for (const [column, value] of filters) {
    if (value === null || value === undefined) continue;
    clauses.push(`${column} = ?`);
    values.push(value);
  }
  if (from) {
    clauses.push(`${timeColumn} >= ?`);
    values.push(from);
  }
  if (to) {
    clauses.push(`${timeColumn} <= ?`);
    values.push(to);
  }
  if (after) {
    if (keyColumn && after.key) {
      clauses.push(
        `(${timeColumn} > ? OR (${timeColumn} = ? AND ${keyColumn} > ?))`,
      );
      values.push(after.timestamp, after.timestamp, after.key);
    } else {
      clauses.push(`${timeColumn} > ?`);
      values.push(after.timestamp);
    }
  }
  clauses.push("(expires_at IS NULL OR expires_at > ?)");
  values.push(new Date().toISOString());
  values.push(limit);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const direction = after ? "ASC" : "DESC";
  const order = keyColumn
    ? `${timeColumn} ${direction}, ${keyColumn} ${direction}`
    : `${timeColumn} ${direction}`;
  const result = await db.prepare(
    `SELECT ${columns.join(", ")} FROM ${table}${where} ORDER BY ${order} LIMIT ?`,
  ).bind(...values).all();
  return Array.isArray(result?.results) ? result.results : [];
}

const SOURCE_COLUMNS = ["source", "as_of", "fetched_at", "freshness", "adjustment", "quality"];

export function queryMarketBars(db, query) {
  return queryRows(db, {
    table: "market_bars",
    columns: [
      "symbol", "profile_id", "timeframe", "ts", "open", "high", "low", "close", "volume",
      ...SOURCE_COLUMNS,
    ],
    filters: [
      ["symbol", query.symbol],
      ["profile_id", query.profile],
      ["timeframe", query.timeframe],
    ],
    timeColumn: "ts",
    ...query,
  });
}

export function queryNewsItems(db, query) {
  return queryRows(db, {
    table: "news_items",
    columns: [
      "id", "symbol", "profile_id", "topic", "title", "summary", "url", "published_at",
      "source_tier", "publisher", "relevance", "cluster_id",
      ...SOURCE_COLUMNS,
    ],
    filters: [
      ["symbol", query.symbol],
      ["profile_id", query.profile],
      ["topic", query.topic],
    ],
    timeColumn: "published_at",
    ...query,
  });
}

function safeDelivery(row) {
  return {
    eventId: row.event_id,
    channel: row.channel,
    status: row.status,
    reasonCode: row.reason_code ?? null,
    attemptCount: Number(row.attempt_count || 0),
    nextAttemptAt: row.next_attempt_at ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    sentAt: row.sent_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

async function queryDeliveriesForEvents(db, eventIds) {
  if (eventIds.length === 0) return [];
  const allowed = new Set(eventIds);
  const deliveries = [];
  for (let index = 0; index < eventIds.length; index += 80) {
    const chunk = eventIds.slice(index, index + 80);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db.prepare(`
      SELECT event_id, channel, status, reason_code, attempt_count,
             next_attempt_at, last_attempt_at, sent_at, updated_at
      FROM notification_deliveries
      WHERE event_id IN (${placeholders})
      ORDER BY updated_at DESC
    `).bind(...chunk).all();
    deliveries.push(...(result?.results || []));
  }
  return deliveries
    .filter(({ event_id: eventId }) => allowed.has(eventId))
    .map(safeDelivery);
}

export async function queryMarketEvents(db, query) {
  const rows = await queryRows(db, {
    table: "market_events",
    columns: [
      "id", "symbol", "profile_id", "topic", "importance", "event_at", "title", "description",
      "provider", "provider_as_of", "provider_quality", "rule_version",
      ...SOURCE_COLUMNS,
    ],
    filters: [
      ["symbol", query.symbol],
      ["profile_id", query.profile],
      ["topic", query.topic],
      ["importance", query.importance],
    ],
    timeColumn: "event_at",
    keyColumn: "id",
    ...query,
  });
  const deliveries = await queryDeliveriesForEvents(
    db,
    rows.map(({ id }) => id),
  );
  const byEvent = new Map();
  for (const delivery of deliveries) {
    if (!byEvent.has(delivery.eventId)) byEvent.set(delivery.eventId, []);
    const { eventId: _eventId, ...safe } = delivery;
    byEvent.get(delivery.eventId).push(safe);
  }
  return rows.map((row) => ({
    ...row,
    deliveries: byEvent.get(row.id) || [],
  }));
}

export function querySourceHealth(db, query) {
  return queryRows(db, {
    table: "source_health",
    columns: ["source", "status", "as_of", "fetched_at", "freshness", "adjustment", "quality", "detail"],
    filters: [["source", query.source]],
    timeColumn: "as_of",
    ...query,
    after: null,
  });
}

export function queryFundFlows(db, query) {
  return queryRows(db, {
    table: "fund_flows",
    columns: [
      "id", "profile_id", "symbol", "flow_type", "period", "trade_date", "ts", "value", "unit",
      "currency", "source", "method", ...SOURCE_COLUMNS,
    ],
    filters: [
      ["symbol", query.symbol],
      ["profile_id", query.profile],
      ["flow_type", query.type],
      ["period", query.period],
      ["source", query.source],
    ],
    timeColumn: "ts",
    keyColumn: "id",
    ...query,
  });
}

export async function queryNotificationStatus(db, query) {
  const clauses = [];
  const values = [];
  if (query.profile) {
    clauses.push("profile_id = ?");
    values.push(query.profile);
  }
  if (query.after) {
    if (query.after.key) {
      clauses.push(`(
        updated_at > ?
        OR (updated_at = ? AND (event_id || ':' || channel) > ?)
      )`);
      values.push(query.after.timestamp, query.after.timestamp, query.after.key);
    } else {
      clauses.push("updated_at > ?");
      values.push(query.after.timestamp);
    }
  }
  values.push(query.limit);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const direction = query.after ? "ASC" : "DESC";
  const result = await db.prepare(`
    SELECT event_id, channel, status, reason_code, attempt_count,
           next_attempt_at, last_attempt_at, sent_at, updated_at
    FROM notification_deliveries
    ${where}
    ORDER BY updated_at ${direction}, (event_id || ':' || channel) ${direction}
    LIMIT ?
  `).bind(...values).all();
  return (result?.results || []).map(safeDelivery);
}

export async function queryEvidencePacket(db, {
  symbol,
  asOf = null,
  scope = "legacy",
  profileId = null,
  requestId = null,
}) {
  const cutoff = asOf || new Date().toISOString();
  const row = await db.prepare(`
    SELECT id, symbol, as_of, generated_at, status, packet_json, content_hash,
           expires_at, scope, profile_id, request_id, slot_id, run_id
    FROM evidence_packets
    WHERE symbol = ?
      AND scope = ?
      AND ((profile_id = ?) OR (profile_id IS NULL AND ? IS NULL))
      AND ((request_id = ?) OR (request_id IS NULL AND ? IS NULL))
      AND as_of <= ?
      AND expires_at > ?
    ORDER BY as_of DESC
    LIMIT 1
  `).bind(
    symbol,
    scope,
    profileId,
    profileId,
    requestId,
    requestId,
    cutoff,
    new Date().toISOString(),
  ).first();
  return row || null;
}

export async function upsertEvidenceBundle(db, {
  packet,
  report = null,
  manifest = null,
  identity = null,
  expiresAt,
}) {
  const symbol = packet.instrument.symbol;
  const scope = identity?.scope || "legacy";
  const profileId = identity?.profileId || null;
  const requestId = identity?.requestId || null;
  const slotId = identity?.slotId || null;
  const runId = identity?.runId || null;
  const groupId = [scope, profileId, requestId, slotId, runId]
    .map((value) => encodeURIComponent(value || "_"))
    .join(":");
  const packetId = `evidence:${groupId}:${symbol}:${packet.asOf}:${packet.contentHash}`;
  const statements = [
    db.prepare(`
      INSERT INTO evidence_packets (
        id, symbol, scope, profile_id, request_id, slot_id, run_id,
        as_of, generated_at, status, packet_json, content_hash, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        generated_at = excluded.generated_at,
        status = excluded.status,
        packet_json = excluded.packet_json,
        content_hash = excluded.content_hash,
        expires_at = excluded.expires_at
    `).bind(
      packetId,
      symbol,
      scope,
      profileId,
      requestId,
      slotId,
      runId,
      packet.asOf,
      packet.generatedAt,
      packet.status,
      JSON.stringify(packet),
      packet.contentHash,
      expiresAt,
    ),
  ];
  if (manifest && report) {
    statements.push(db.prepare(`
      INSERT INTO report_manifests (
        report, symbol, trade_date, analysis_status, audit_status,
        evidence_hash, manifest_json, created_at, scope, profile_id,
        request_id, slot_id, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(report) DO UPDATE SET
        symbol = excluded.symbol,
        trade_date = excluded.trade_date,
        analysis_status = excluded.analysis_status,
        audit_status = excluded.audit_status,
        evidence_hash = excluded.evidence_hash,
        manifest_json = excluded.manifest_json,
        created_at = excluded.created_at
      WHERE report_manifests.scope = excluded.scope
        AND COALESCE(report_manifests.profile_id, '') = COALESCE(excluded.profile_id, '')
        AND COALESCE(report_manifests.request_id, '') = COALESCE(excluded.request_id, '')
        AND COALESCE(report_manifests.slot_id, '') = COALESCE(excluded.slot_id, '')
        AND COALESCE(report_manifests.run_id, '') = COALESCE(excluded.run_id, '')
    `).bind(
      report,
      symbol,
      manifest.tradeDate || null,
      manifest.analysisStatus,
      manifest.auditStatus,
      packet.contentHash,
      JSON.stringify(manifest),
      manifest.generatedAt,
      scope,
      profileId,
      requestId,
      slotId,
      runId,
    ));
  }
  return db.batch(statements);
}
