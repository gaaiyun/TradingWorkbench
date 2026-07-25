// Versioned EvidencePacketV1 route. Keep the legacy /api/evidence entrypoint
// available while new publishers and readers migrate to /api/v1/evidence.
import {
  onRequestGet as legacyGet,
  onRequestPost as legacyPost,
} from "../evidence.js";
import { json } from "../_util.js";

function hasBearerToken(request, expected) {
  if (!expected) return false;
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(
    (request.headers.get("authorization") || "").trim(),
  );
  return Boolean(match && match[1] === String(expected));
}

export async function onRequestGet(context) {
  const expected = context.env?.EVIDENCE_READ_TOKEN;
  if (expected && !hasBearerToken(context.request, expected)) {
    return json({ status: "unavailable", error: "UNAUTHORIZED" }, 401);
  }
  return legacyGet(context);
}

export async function onRequestPost(context) {
  const expected = context.env?.EVIDENCE_WRITE_TOKEN;
  if (expected && !hasBearerToken(context.request, expected)) {
    return json({ status: "unavailable", error: "UNAUTHORIZED" }, 401);
  }
  return legacyPost(context);
}
