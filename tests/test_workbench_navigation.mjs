import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import * as router from "../public/assets/workbench-router.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/assets/workbench.css", import.meta.url), "utf8");
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

test("switching primary workspaces returns the viewport to the new workspace heading", () => {
  const script = readFileSync(
    new URL("../public/assets/workbench.js", import.meta.url),
    "utf8",
  );
  assert.match(
    script,
    /const previousRoute = document\.body\.dataset\.route[\s\S]*?previousRoute !== route\) window\.scrollTo\(0,\s*0\)/,
  );
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

test("mobile primary navigation keeps all seven workspaces reachable", () => {
  const mobileNav = /<nav class="mobile-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] || "";
  for (const [id] of routes) {
    assert.match(mobileNav, new RegExp(`href="#${id}"[^>]*data-route-link="${id}"`));
  }
});

test("the current profile selector stays in the persistent top bar", () => {
  const header = /<header class="terminal-header"[\s\S]*?<\/header>/.exec(html)?.[0] || "";
  assert.match(header, /id="profile-selector"/);
  assert.match(header, /aria-label="当前监控组"/);
  const mobileMedia = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(mobileMedia, /\.profile-selector/);
  assert.doesNotMatch(mobileMedia, /\.profile-selector\s*\{[^}]*display:\s*none/);
});

test("responsive primary navigation has no tablet dead zone", () => {
  const tabletMedia = css.slice(
    css.indexOf("@media (max-width: 940px)"),
    css.indexOf("@media (max-width: 760px)"),
  );
  assert.match(tabletMedia, /\.mobile-nav\s*\{[\s\S]*?display:\s*grid/);
  assert.match(tabletMedia, /body\s*\{[\s\S]*?padding-bottom:\s*55px/);
});

test("mobile monitor switcher stays above the global navigation without forcing a page scroll", () => {
  const mobileMedia = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(
    mobileMedia,
    /body\[data-route="monitor"\]\s*\{[^}]*padding-bottom:\s*calc\(89px \+ env\(safe-area-inset-bottom\)\)/,
  );
  assert.match(
    mobileMedia,
    /body\[data-route="monitor"\]\s+\.monitor-mobile-nav\s*\{[\s\S]*?position:\s*fixed[\s\S]*?bottom:\s*calc\(55px \+ env\(safe-area-inset-bottom\)\)/,
  );
});
