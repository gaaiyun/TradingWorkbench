import { proxyRaw } from "./_util.js";

// GET /api/history → 运行历史索引
export async function onRequestGet() {
  return proxyRaw("data/history.json", { cacheSeconds: 60 });
}
