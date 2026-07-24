import { proxyRaw } from "./_util.js";

// GET /api/report-audit → 报告审计索引
// 审计索引是公开的结构化元数据，不包含报告正文或任何密钥。
export async function onRequestGet() {
  return proxyRaw("data/report-audit.json", { cacheSeconds: 60 });
}
