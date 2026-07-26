import { json, proxyRaw } from "./_util.js";
import {
  identityMatches,
  parseRunSelectors,
} from "./_run_identity.mjs";

// GET /api/history → 运行历史索引
export async function onRequestGet({ request } = {}) {
  let selectors;
  try {
    selectors = parseRunSelectors(request);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  if (!selectors.hasSelector) {
    return proxyRaw("data/history.json", { cacheSeconds: 60 });
  }
  const response = await proxyRaw("data/history.json", { cacheSeconds: 60 });
  if (!response.ok) return response;
  let history;
  try {
    history = await response.json();
  } catch {
    return json({ error: "历史索引无效" }, 502);
  }
  if (!Array.isArray(history)) return json({ error: "历史索引无效" }, 502);
  return json(
    history.filter((entry) => identityMatches(entry?.identity, selectors)),
    200,
    { "cache-control": "public, max-age=60" },
  );
}
