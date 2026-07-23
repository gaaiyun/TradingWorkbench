import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import * as router from "../public/assets/workbench-router.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const routerModule = new URL("../public/assets/workbench-router.mjs", import.meta.url);

const routes = [
  ["monitor", "市场监控"],
  ["agents", "Agent 研究"],
  ["tasks", "研究任务"],
  ["archive", "研究档案"],
  ["news", "新闻/事件"],
  ["options", "期权风控"],
  ["settings", "设置"],
];

test("workbench ships a dedicated route contract", () => {
  assert.equal(existsSync(routerModule), true);
});

test("route contract normalizes hashes and generates stable links", () => {
  assert.deepEqual(
    router.PRIMARY_ROUTES?.map(({ id, label }) => [id, label]),
    routes,
  );
  assert.equal(router.normalizeRoute?.("#options"), "options");
  assert.equal(router.normalizeRoute?.("archive"), "archive");
  assert.equal(router.normalizeRoute?.("#unknown"), "monitor");
  assert.equal(router.normalizeRoute?.(""), "monitor");
  assert.equal(router.routeHref?.("agents"), "#agents");
  assert.equal(router.routeHref?.("unknown"), "#monitor");
});

test("every primary route has a visible navigation target and workspace", () => {
  for (const [id, label] of routes) {
    assert.match(html, new RegExp(`href="#${id}"[^>]*>[\\s\\S]*?${label}`));
    assert.match(html, new RegExp(`data-workspace="${id}"`));
  }
});

test("primary capabilities are workspaces instead of external-link substitutes", () => {
  assert.doesNotMatch(html, /class="capability-nav"/);
  assert.match(html, /data-workspace="agents"/);
  assert.match(html, /data-workspace="options"/);
});
