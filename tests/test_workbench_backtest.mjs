import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/assets/workbench.js", import.meta.url), "utf8");

test("Agent research workspace exposes a bounded data coverage and backtest tool", () => {
  assert.match(html, /id="data-coverage-summary"/);
  assert.match(html, /id="backtest-form"/);
  assert.match(html, /id="backtest-result"/);
  assert.match(html, /前复权|qfq/i);
  assert.match(html, /不代表实盘|不用于实盘/);
  assert.match(script, /\/api\/data-catalog/);
  assert.match(script, /\/api\/universe\?summary=1/);
  assert.match(script, /\/api\/backtest/);
  assert.match(script, /coverage\.cnCurrentListedStocks\s*!==\s*null/);
});
