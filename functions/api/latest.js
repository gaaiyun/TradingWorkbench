import { proxyRaw } from "./_util.js";

// GET /api/latest → main 分支上最新的 latest.json（随每次运行 commit 更新）
export async function onRequestGet() {
  return proxyRaw("data/latest.json", { cacheSeconds: 60 });
}
