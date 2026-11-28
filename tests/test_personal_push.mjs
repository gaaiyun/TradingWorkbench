import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import relay, { DeliveryLedger } from "../workers/personal-push/index.mjs";

test("signatures protect a single-recipient relay; ambiguous submissions are never retried", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const receipt = "3cbc5eab19fe512e80677540fbde332a";
  const upstream = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://www.pushplus.plus/send");
    assert.equal(options.redirect, "manual");
    upstream.push(JSON.parse(options.body));
    return Response.json({ code: 200, data: upstream.length === 1 ? receipt : null });
  });
  const objects = new Map();
  const env = {
    PUSHPLUS_TOKEN: "test-only",
    RADAR_SIGNING_PUBLIC_KEY: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    LEDGER: {
      idFromName: (id) => id,
      get(id) {
        if (!objects.has(id)) {
          const store = new Map();
          const storage = {
            get: (k) => store.get(k), put: (k, v) => store.set(k, v),
            transaction: (f) => f(storage),
          };
          objects.set(id, new DeliveryLedger({ storage }, env));
        }
        return objects.get(id);
      },
    },
  };
  const msg = { id: "event:1", title: "提醒", content: "正文\n二" };
  const now = Math.floor(Date.now() / 1000);
  const send = (body, timestamp = now, raw = JSON.stringify(body)) => {
    const signature = sign(null, Buffer.from(timestamp + "\n" + JSON.stringify(body)), privateKey);
    return relay.fetch(new Request("https://worker/notify", {
      method: "POST", body: raw, headers: {
        "content-type": "application/json",
        "x-radar-timestamp": String(timestamp), "x-radar-signature": signature.toString("base64"),
      },
    }), env);
  };
  assert.equal((await relay.fetch(new Request("https://worker/health"), env)).status, 200);
  assert.equal((await send(msg, now - 122)).status, 401);
  assert.equal((await send(msg, now + 122)).status, 401);
  assert.equal((await send(msg, now, JSON.stringify(msg) + " ")).status, 401);
  assert.equal((await send({ ...msg, topic: "group" })).status, 400);
  assert.equal(upstream.length, 0);
  const sent = await send(msg);
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { ok: true, status: "accepted", id: msg.id, receipt, duplicate: false });
  assert.deepEqual(upstream, [{ token: env.PUSHPLUS_TOKEN, channel: "wechat", template: "txt", title: msg.title, content: msg.content }]);
  assert.equal((await (await send(msg)).json()).duplicate, true);
  assert.equal((await send({ ...msg, content: "different" })).status, 409);
  const second = { ...msg, id: "event:2" };
  assert.notEqual((await send(second)).status, 200);
  assert.notEqual((await send(second)).status, 200);
  assert.equal(upstream.length, 2);
});
