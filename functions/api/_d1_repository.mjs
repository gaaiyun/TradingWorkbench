export function d1Binding(env) {
  return env?.DB && typeof env.DB.prepare === "function" ? env.DB : null;
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
  let updatedAt = now.toISOString();
  if (updatedAt === expectedUpdatedAt) {
    updatedAt = new Date(now.valueOf() + 1).toISOString();
  }
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

async function queryRows(db, { table, columns, filters, timeColumn, from, to, limit }) {
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
  clauses.push("(expires_at IS NULL OR expires_at > ?)");
  values.push(new Date().toISOString());
  values.push(limit);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const result = await db.prepare(
    `SELECT ${columns.join(", ")} FROM ${table}${where} ORDER BY ${timeColumn} DESC LIMIT ?`,
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

export function queryMarketEvents(db, query) {
  return queryRows(db, {
    table: "market_events",
    columns: [
      "id", "symbol", "profile_id", "topic", "importance", "event_at", "title", "description",
      ...SOURCE_COLUMNS,
    ],
    filters: [
      ["symbol", query.symbol],
      ["profile_id", query.profile],
      ["topic", query.topic],
      ["importance", query.importance],
    ],
    timeColumn: "event_at",
    ...query,
  });
}

export function querySourceHealth(db, query) {
  return queryRows(db, {
    table: "source_health",
    columns: ["source", "status", "as_of", "fetched_at", "freshness", "adjustment", "quality", "detail"],
    filters: [["source", query.source]],
    timeColumn: "as_of",
    ...query,
  });
}

export async function queryEvidencePacket(db, { symbol, asOf = null }) {
  const cutoff = asOf || new Date().toISOString();
  const row = await db.prepare(`
    SELECT id, symbol, as_of, generated_at, status, packet_json, content_hash,
           expires_at
    FROM evidence_packets
    WHERE symbol = ? AND as_of <= ? AND expires_at > ?
    ORDER BY as_of DESC
    LIMIT 1
  `).bind(symbol, cutoff, new Date().toISOString()).first();
  return row || null;
}

export async function upsertEvidenceBundle(db, {
  packet,
  report = null,
  manifest = null,
  expiresAt,
}) {
  const symbol = packet.instrument.symbol;
  const packetId = `evidence:${symbol}:${packet.asOf}:${packet.contentHash}`;
  const statements = [
    db.prepare(`
      INSERT INTO evidence_packets (
        id, symbol, as_of, generated_at, status, packet_json, content_hash, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        generated_at = excluded.generated_at,
        status = excluded.status,
        packet_json = excluded.packet_json,
        content_hash = excluded.content_hash,
        expires_at = excluded.expires_at
    `).bind(
      packetId,
      symbol,
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
        evidence_hash, manifest_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(report) DO UPDATE SET
        symbol = excluded.symbol,
        trade_date = excluded.trade_date,
        analysis_status = excluded.analysis_status,
        audit_status = excluded.audit_status,
        evidence_hash = excluded.evidence_hash,
        manifest_json = excluded.manifest_json,
        created_at = excluded.created_at
    `).bind(
      report,
      symbol,
      manifest.tradeDate || null,
      manifest.analysisStatus,
      manifest.auditStatus,
      packet.contentHash,
      JSON.stringify(manifest),
      manifest.generatedAt,
    ));
  }
  return db.batch(statements);
}
