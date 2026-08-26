const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const DEFAULT_SESSION_DAYS = 90;
const DEFAULT_REQUEST_DAYS = 30;

export class ChatSessionProfileConflictError extends Error {
  constructor(sessionId) {
    super(`chat session profile conflict: ${sessionId}`);
    this.name = "ChatSessionProfileConflictError";
    this.code = "session_profile_conflict";
    this.sessionId = sessionId;
  }
}

function iso(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString();
}

function addDays(date, days) {
  return new Date(date.valueOf() + days * 24 * 60 * 60 * 1000).toISOString();
}

function changes(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

function safeJson(value, fallback = null) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeChatId(value) {
  const normalized = String(value || "").trim();
  return CHAT_ID.test(normalized) ? normalized : "";
}

export async function hashChatValue(value) {
  const input = typeof value === "string" ? value : JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function claimChatRequest(db, {
  requestId,
  sessionId,
  profileId = null,
  requestHash,
  now = new Date(),
  requestDays = DEFAULT_REQUEST_DAYS,
}) {
  const at = iso(now);
  const expiresAt = addDays(now, requestDays);
  await ensureSession(db, {
    sessionId,
    profileId,
    title: "新研究会话",
    now,
    sessionDays: DEFAULT_SESSION_DAYS,
  });
  const result = await db.prepare(
    `INSERT INTO chat_requests (
       request_id, session_id, profile_id, request_hash, status,
       response_json, context_hash, created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, 'processing', NULL, NULL, ?, ?, ?)
     ON CONFLICT(request_id) DO NOTHING`,
  ).bind(
    requestId,
    sessionId,
    profileId || null,
    requestHash,
    at,
    at,
    expiresAt,
  ).run();
  if (changes(result) === 1) return { state: "claimed" };

  const existing = await db.prepare(
    `SELECT request_id, session_id, profile_id, request_hash, status,
            response_json, context_hash, updated_at, expires_at
     FROM chat_requests WHERE request_id = ?`,
  ).bind(requestId).first();
  if (!existing) return { state: "unavailable" };
  if (
    existing.request_hash !== requestHash ||
    existing.session_id !== sessionId ||
    (existing.profile_id || null) !== (profileId || null)
  ) {
    return { state: "conflict" };
  }
  if (existing.status === "completed") {
    return {
      state: "completed",
      response: safeJson(existing.response_json, {}),
      contextHash: existing.context_hash || null,
      updatedAt: existing.updated_at,
    };
  }
  if (existing.status === "failed") {
    return {
      state: "failed",
      response: safeJson(existing.response_json, {}),
      updatedAt: existing.updated_at,
    };
  }
  return { state: "processing", updatedAt: existing.updated_at };
}

async function ensureSession(db, {
  sessionId,
  profileId,
  title,
  now,
  sessionDays,
}) {
  const at = iso(now);
  await db.prepare(
    `INSERT INTO chat_sessions (id, profile_id, title, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    sessionId,
    profileId || null,
    String(title || "新研究会话").slice(0, 120),
    at,
    at,
    addDays(now, sessionDays),
  ).run();
  const owner = await db.prepare(
    "SELECT profile_id FROM chat_sessions WHERE id = ?",
  ).bind(sessionId).first();
  if (!owner || (owner.profile_id || null) !== (profileId || null)) {
    throw new ChatSessionProfileConflictError(sessionId);
  }
  await db.prepare(
    `UPDATE chat_sessions
     SET title = CASE
       WHEN title IS NULL OR title = '' OR title = '新研究会话' THEN ?
       ELSE title
     END,
     updated_at = ?,
     expires_at = ?
     WHERE id = ?
       AND ((profile_id = ?) OR (profile_id IS NULL AND ? IS NULL))`,
  ).bind(
    String(title || "新研究会话").slice(0, 120),
    at,
    addDays(now, sessionDays),
    sessionId,
    profileId || null,
    profileId || null,
  ).run();
}

export async function completeChatRequest(db, {
  requestId,
  sessionId,
  profileId = null,
  title,
  question,
  answer,
  contextHash = null,
  response,
  now = new Date(),
  sessionDays = DEFAULT_SESSION_DAYS,
  requestDays = DEFAULT_REQUEST_DAYS,
}) {
  const at = iso(now);
  const messageExpiresAt = addDays(now, sessionDays);
  await ensureSession(db, { sessionId, profileId, title, now, sessionDays });
  await db.prepare(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at, expires_at)
     VALUES (?, ?, 'user', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(`${requestId}:user`, sessionId, String(question), at, messageExpiresAt).run();
  await db.prepare(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at, expires_at)
     VALUES (?, ?, 'assistant', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    `${requestId}:assistant`,
    sessionId,
    String(answer),
    new Date(now.valueOf() + 1).toISOString(),
    messageExpiresAt,
  ).run();
  const result = await db.prepare(
    `UPDATE chat_requests
     SET status = 'completed', response_json = ?, context_hash = ?,
         updated_at = ?, expires_at = ?
     WHERE request_id = ? AND status = 'processing'`,
  ).bind(
    JSON.stringify(response || {}),
    contextHash || null,
    at,
    addDays(now, requestDays),
    requestId,
  ).run();
  return changes(result) === 1;
}

export async function failChatRequest(db, {
  requestId,
  response,
  now = new Date(),
  requestDays = DEFAULT_REQUEST_DAYS,
}) {
  const result = await db.prepare(
    `UPDATE chat_requests
     SET status = 'failed', response_json = ?, updated_at = ?, expires_at = ?
     WHERE request_id = ? AND status = 'processing'`,
  ).bind(
    JSON.stringify(response || {}),
    iso(now),
    addDays(now, requestDays),
    requestId,
  ).run();
  return changes(result) === 1;
}

function sessionReadOptions(options, fallbackLimit) {
  if (options instanceof Date) {
    return { profileId: null, now: options, limit: fallbackLimit };
  }
  return {
    profileId: options?.profileId || null,
    now: options?.now || new Date(),
    limit: options?.limit ?? fallbackLimit,
  };
}

async function hasLiveSession(db, sessionId, at) {
  const row = await db.prepare(
    "SELECT id FROM chat_sessions WHERE id = ? AND expires_at > ?",
  ).bind(sessionId, at).first();
  return Boolean(row);
}

export async function getChatSession(db, sessionId, options = {}, fallbackLimit = 80) {
  const { profileId, now, limit } = sessionReadOptions(options, fallbackLimit);
  const at = iso(now);
  const session = await db.prepare(
    `SELECT id, profile_id, title, created_at, updated_at, expires_at
     FROM chat_sessions
     WHERE id = ? AND expires_at > ?
       AND ((profile_id = ?) OR (profile_id IS NULL AND ? IS NULL))`,
  ).bind(sessionId, at, profileId, profileId).first();
  if (!session) {
    if (await hasLiveSession(db, sessionId, at)) {
      throw new ChatSessionProfileConflictError(sessionId);
    }
    return null;
  }
  const result = await db.prepare(
    `SELECT id, role, content, created_at
     FROM chat_messages
     WHERE session_id = ? AND expires_at > ?
       AND EXISTS (
         SELECT 1 FROM chat_sessions
         WHERE id = chat_messages.session_id
           AND ((profile_id = ?) OR (profile_id IS NULL AND ? IS NULL))
       )
     ORDER BY created_at ASC LIMIT ?`,
  ).bind(
    sessionId,
    at,
    profileId,
    profileId,
    Math.max(1, Math.min(200, Math.trunc(limit))),
  ).all();
  return {
    id: session.id,
    profileId: session.profile_id || null,
    title: session.title || "新研究会话",
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    messages: (result?.results || []).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      at: message.created_at,
    })),
  };
}

export async function listChatSessions(db, {
  profileId = null,
  now = new Date(),
  limit = 50,
} = {}) {
  const result = await db.prepare(
    `SELECT id, profile_id, title, created_at, updated_at, expires_at
     FROM chat_sessions
     WHERE expires_at > ?
       AND ((profile_id = ?) OR (profile_id IS NULL AND ? IS NULL))
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(
    iso(now),
    profileId,
    profileId,
    Math.max(1, Math.min(100, Math.trunc(limit))),
  ).all();
  return (result?.results || []).map((session) => ({
    id: session.id,
    profileId: session.profile_id || null,
    title: session.title || "新研究会话",
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  }));
}

// `now` is injectable like every other reader in this module (getChatSession,
// listChatSessions, claimChatRequest). It was the one exception, which made the
// retention filter below read the wall clock even when a caller had pinned time.
export async function deleteChatSession(db, sessionId, profileId = null, now = new Date()) {
  const at = iso(now);
  const owner = await db.prepare(
    `SELECT id FROM chat_sessions
     WHERE id = ? AND expires_at > ?
       AND ((profile_id = ?) OR (profile_id IS NULL AND ? IS NULL))`,
  ).bind(sessionId, at, profileId, profileId).first();
  if (!owner) {
    if (await hasLiveSession(db, sessionId, at)) {
      throw new ChatSessionProfileConflictError(sessionId);
    }
    return false;
  }
  const ownerClause = `session_id IN (
    SELECT id FROM chat_sessions
    WHERE id = ? AND ((profile_id = ?) OR (profile_id IS NULL AND ? IS NULL))
  )`;
  await db.prepare(`DELETE FROM chat_messages WHERE ${ownerClause}`)
    .bind(sessionId, profileId, profileId).run();
  await db.prepare(`DELETE FROM chat_requests WHERE ${ownerClause}`)
    .bind(sessionId, profileId, profileId).run();
  const result = await db.prepare(
    `DELETE FROM chat_sessions
     WHERE id = ? AND ((profile_id = ?) OR (profile_id IS NULL AND ? IS NULL))`,
  ).bind(sessionId, profileId, profileId).run();
  return changes(result) > 0;
}
