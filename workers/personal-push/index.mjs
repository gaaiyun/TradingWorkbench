const encoder = new TextEncoder();
const MAX_BYTES = 32 * 1024;
const reply = (status, body) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (code, status) => reply(code, { ok: false, status });
const fromBase64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

async function readLimited(request) {
  const reader = request.body?.getReader();
  const bytes = new Uint8Array(MAX_BYTES);
  let used = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (used + value.length > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, used);
      used += value.length;
    }
  }
  return bytes.subarray(0, used);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      const ok = Boolean(env.LEDGER && env.PUSHPLUS_TOKEN && env.RADAR_SIGNING_PUBLIC_KEY);
      return reply(ok ? 200 : 503, { ok, service: "tradingworkbench-personal-push" });
    }
    if (path !== "/notify" || request.method !== "POST") return fail(404, "not_found");
    const ts = request.headers.get("x-radar-timestamp") || "";
    const sig = request.headers.get("x-radar-signature") || "";
    if (!/^\d{10}$/.test(ts) || Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 120 ||
        !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return fail(401, "unauthorized");
    if (!env.PUSHPLUS_TOKEN || !env.RADAR_SIGNING_PUBLIC_KEY || !env.LEDGER) return fail(503, "not_configured");

    const raw = await readLimited(request);
    if (raw === null) return fail(413, "too_large");
    const prefix = encoder.encode(ts + "\n");
    const signed = new Uint8Array(prefix.length + raw.length);
    signed.set(prefix);
    signed.set(raw, prefix.length);
    let key;
    try {
      key = await crypto.subtle.importKey("spki", fromBase64(env.RADAR_SIGNING_PUBLIC_KEY), "Ed25519", false, ["verify"]);
    } catch { return fail(503, "not_configured"); }
    if (!await crypto.subtle.verify("Ed25519", key, fromBase64(sig), signed)) return fail(401, "unauthorized");
    let body;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch { return fail(400, "invalid_json"); }
    if (!body || Object.keys(body).sort().join(",") !== "content,id,title" ||
        typeof body.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/.test(body.id) ||
        typeof body.title !== "string" || !body.title.trim() || body.title.length > 256 ||
        typeof body.content !== "string" || !body.content.trim()) return fail(400, "invalid_message");
    const stub = env.LEDGER.get(env.LEDGER.idFromName(body.id));
    return stub.fetch(new Request("https://ledger.internal/", {
      method: "POST", body: JSON.stringify({ id: body.id, title: body.title, content: body.content }),
    }));
  },
};

export class DeliveryLedger {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.env = env;
  }

  async fetch(request) {
    const { id, title, content } = await request.json();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest(
      "SHA-256", encoder.encode(JSON.stringify([title, content])),
    )), (b) => b.toString(16).padStart(2, "0")).join("");
    // Persist the reservation before the external call. A crash after acceptance
    // must never turn a missing receipt into a second notification.
    const prior = await this.storage.transaction(async (tx) => {
      const existing = await tx.get("delivery");
      if (!existing) await tx.put("delivery", { digest, status: "unconfirmed" });
      return existing;
    });
    if (prior?.digest && prior.digest !== digest) return fail(409, "id_conflict");
    if (prior && !prior.receipt) return fail(409, "unconfirmed");
    if (prior?.receipt) return reply(200, { ok: true, status: "accepted", id, receipt: prior.receipt, duplicate: true });
    let receipt;
    try {
      const upstream = await fetch("https://www.pushplus.plus/send", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: this.env.PUSHPLUS_TOKEN, channel: "wechat", template: "txt", title, content }),
      });
      if (upstream.ok) {
        const result = await upstream.json();
        if (result?.code === 200 && typeof result.data === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(result.data)) {
          receipt = result.data;
        }
      }
    } catch { /* The upstream may have accepted the request before disconnecting. */ }
    if (!receipt) return fail(502, "unconfirmed");
    await this.storage.put("delivery", { digest, status: "accepted", receipt });
    return reply(200, { ok: true, status: "accepted", id, receipt, duplicate: false });
  }
}
