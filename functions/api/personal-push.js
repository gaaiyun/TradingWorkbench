// This endpoint forwards only the signed radar request to the private service binding.
export async function onRequestPost({ request, env }) {
  if (!env.PERSONAL_PUSH) return new Response(null, { status: 503 });
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["x-radar-signature", "x-radar-timestamp"]) {
    if (!request.headers.has(name)) return new Response(null, { status: 401 });
    headers.set(name, request.headers.get(name));
  }
  return env.PERSONAL_PUSH.fetch("https://relay.internal/notify", {
    method: "POST", headers, body: request.body,
  });
}
