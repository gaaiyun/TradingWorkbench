#!/usr/bin/env node
/**
 * Date-rot gate: re-runs the existing test suites with the clock shifted into
 * the future.
 *
 * Why this exists: several APIs recompute status against the wall clock at read
 * time (market freshness, report lag, session/evidence retention). A test that
 * hardcodes fixture dates without pinning the clock passes on the day it is
 * written and silently starts failing weeks later — on a schedule, in CI.
 *
 * That shipped three times before this gate existed. The last one, a single
 * assertion in test_dynamic_api.mjs, turned the every-30-minutes pages-snapshot
 * schedule red in two repos and mailed a failure notification on every run.
 *
 * Tests that pin their own clock (t.mock.method(Date, "now", ...)) or use a
 * far-future sentinel for expires_at are unaffected by the shift, so a failure
 * here means a genuine wall-clock dependency, not a false positive.
 *
 * The suite file lists are read back out of package.json rather than duplicated
 * here, so adding a test file cannot silently escape this gate.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIFT_DAYS = process.env.TEST_CLOCK_SHIFT_DAYS || "400";
const PRELOAD = "./tests/helpers/clock-shift.cjs";

const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

/** Pull the test file list out of an existing `node --test ...` script. */
function filesFor(scriptName) {
  const script = pkg.scripts?.[scriptName];
  if (!script) throw new Error(`package.json has no script "${scriptName}"`);
  const files = script.replace(/^node --test\s+/, "").trim().split(/\s+/);
  if (!files.length || !files[0].startsWith("tests/")) {
    throw new Error(`could not parse test files out of "${scriptName}"`);
  }
  return files;
}

let failed = false;
for (const suite of ["test:functions", "test:frontend"]) {
  const files = filesFor(suite);
  process.stdout.write(
    `\n=== ${suite}: ${files.length} files, clock +${SHIFT_DAYS}d ===\n`,
  );
  const result = spawnSync(
    process.execPath,
    ["--require", PRELOAD, "--test", ...files],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, TEST_CLOCK_SHIFT_DAYS: SHIFT_DAYS },
    },
  );
  if (result.status !== 0) {
    failed = true;
    process.stdout.write(
      `\n${suite} failed with the clock shifted +${SHIFT_DAYS} days.\n` +
        "This is date rot: the assertion depends on today's date. Pin the clock\n" +
        't.mock.method(Date, "now", () => Date.parse("<fixture instant>")) or use a\n' +
        "far-future expires_at sentinel. Do not weaken the production freshness logic.\n",
    );
  }
}

process.exit(failed ? 1 : 0);
