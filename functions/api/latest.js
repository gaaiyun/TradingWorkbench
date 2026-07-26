import { json, proxyRaw } from "./_util.js";
import {
  identityMatches,
  parseRunSelectors,
} from "./_run_identity.mjs";

// GET /api/latest → main 分支上最新的 latest.json（随每次运行 commit 更新）
export async function onRequestGet({ request } = {}) {
  let selectors;
  try {
    selectors = parseRunSelectors(request);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  if (!selectors.hasSelector) {
    return proxyRaw("data/latest.json", { cacheSeconds: 60 });
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
  const matches = history.filter(
    (entry) => identityMatches(entry?.identity, selectors),
  );
  matches.sort((left, right) => String(
    right?.generated_at || right?.trade_date || "",
  ).localeCompare(String(left?.generated_at || left?.trade_date || "")));
  if (!matches.length) return json({ error: "没有匹配的运行结果" }, 404);
  return json(matches[0], 200, { "cache-control": "public, max-age=60" });
}
