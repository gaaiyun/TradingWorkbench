import { d1Binding } from "./_d1_repository.mjs";
import {
  ChatSessionProfileConflictError,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  normalizeChatId,
} from "./_chat_repository.mjs";
import { gate, json, readJsonBody } from "./_util.js";
import { normalizeWorkbenchProfileId } from "./_workbench_settings.mjs";

function noStore(data, status = 200) {
  return json(data, status, { "cache-control": "no-store" });
}

function authorized(request, env) {
  return gate(env, request.headers.get("x-access-code"));
}

function optionalProfileId(value) {
  if (value === null || value === undefined) return null;
  return normalizeWorkbenchProfileId(value);
}

function profileError() {
  return noStore({
    status: "unavailable",
    error: "监控目标 ID 无效",
    code: "invalid_profile_id",
  }, 400);
}

function profileConflict() {
  return noStore({
    status: "unavailable",
    error: "会话属于其他监控目标",
    code: "session_profile_conflict",
  }, 409);
}

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) {
    return noStore({ status: "unavailable", error: "访问码不正确", code: "invalid_access_code" }, 401);
  }
  const params = new URL(request.url).searchParams;
  const rawSessionId = params.get("sessionId");
  const sessionId = rawSessionId === null ? null : normalizeChatId(rawSessionId);
  if (rawSessionId !== null && !sessionId) {
    return noStore({ status: "unavailable", error: "会话 ID 无效", code: "invalid_session_id" }, 400);
  }
  let profileId;
  try {
    profileId = optionalProfileId(params.get("profile"));
  } catch {
    return profileError();
  }
  const db = d1Binding(env);
  if (!db) {
    return noStore({ status: "unavailable", asOf: null, data: null, sources: [] }, 503);
  }
  try {
    if (!sessionId) {
      const sessions = await listChatSessions(db, { profileId });
      const asOf = sessions[0]?.updatedAt || null;
      return noStore({
        status: "ok",
        asOf,
        data: sessions,
        sources: [{ source: "d1", asOf }],
      });
    }
    const session = await getChatSession(db, sessionId, { profileId });
    return noStore({
      status: "ok",
      asOf: session?.updatedAt || null,
      data: session || { id: sessionId, messages: [] },
      sources: [{ source: "d1", asOf: session?.updatedAt || null }],
    });
  } catch (error) {
    if (error instanceof ChatSessionProfileConflictError) return profileConflict();
    return noStore({ status: "unavailable", asOf: null, data: null, sources: [] }, 503);
  }
}

export async function onRequestDelete({ request, env }) {
  if (!authorized(request, env)) {
    return noStore({ status: "unavailable", error: "访问码不正确", code: "invalid_access_code" }, 401);
  }
  const body = await readJsonBody(request);
  const sessionId = normalizeChatId(body?.sessionId);
  if (!sessionId) {
    return noStore({ status: "unavailable", error: "会话 ID 无效", code: "invalid_session_id" }, 400);
  }
  let profileId;
  try {
    profileId = optionalProfileId(body?.profileId);
  } catch {
    return profileError();
  }
  const db = d1Binding(env);
  if (!db) return noStore({ status: "unavailable", error: "会话存储不可用" }, 503);
  try {
    const deleted = await deleteChatSession(db, sessionId, profileId);
    return noStore({
      status: "ok",
      asOf: new Date().toISOString(),
      data: { sessionId, deleted },
      sources: [{ source: "d1" }],
    });
  } catch (error) {
    if (error instanceof ChatSessionProfileConflictError) return profileConflict();
    return noStore({ status: "unavailable", error: "会话删除失败" }, 503);
  }
}
