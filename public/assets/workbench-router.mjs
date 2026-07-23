export const PRIMARY_ROUTES = Object.freeze([
  Object.freeze({ id: "monitor", label: "市场监控", shortLabel: "监控" }),
  Object.freeze({ id: "agents", label: "Agent 研究", shortLabel: "研究" }),
  Object.freeze({ id: "tasks", label: "研究任务", shortLabel: "任务" }),
  Object.freeze({ id: "archive", label: "研究档案", shortLabel: "档案" }),
  Object.freeze({ id: "news", label: "新闻/事件", shortLabel: "资讯" }),
  Object.freeze({ id: "options", label: "期权风控", shortLabel: "期权" }),
  Object.freeze({ id: "settings", label: "设置", shortLabel: "设置" }),
]);

const ROUTE_IDS = new Set(PRIMARY_ROUTES.map(({ id }) => id));

export function normalizeRoute(value) {
  const id = String(value || "").trim().replace(/^#/, "").toLowerCase();
  return ROUTE_IDS.has(id) ? id : "monitor";
}

export function routeHref(id) {
  return `#${normalizeRoute(id)}`;
}
