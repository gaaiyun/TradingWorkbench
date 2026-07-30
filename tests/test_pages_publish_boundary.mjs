import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..");
const PREPARE_SCRIPT = path.join(REPO_ROOT, "scripts", "prepare-pages-public.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeReport(publicDir, name, manifest, completeReport) {
  const reportDir = path.join(publicDir, "reports", name);
  fs.mkdirSync(path.join(reportDir, "1_analysts"), { recursive: true });
  fs.mkdirSync(path.join(reportDir, "5_portfolio"), { recursive: true });
  writeJson(path.join(reportDir, "report_manifest.json"), manifest);
  writeJson(path.join(reportDir, "evidence_packet.json"), { status: "ok" });
  fs.writeFileSync(path.join(reportDir, "complete_report.md"), completeReport, "utf8");
  fs.writeFileSync(path.join(reportDir, "1_analysts", "market.md"), "raw analyst direction", "utf8");
  fs.writeFileSync(path.join(reportDir, "5_portfolio", "decision.md"), "评级：Underweight", "utf8");
}

test("Pages deployment artifact replaces raw sections of unverified reports with safe tombstones", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pages-boundary-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const publicDir = path.join(fixtureRoot, "public");
  const outputDir = path.join(fixtureRoot, "output");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "safe app", "utf8");

  writeReport(
    publicDir,
    path.join("UNVERIFIED", "2026-07-30"),
    { auditStatus: "legacy_unverified", analysisStatus: "insufficient_evidence" },
    "**Not Rated**\n\nThe generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions.\n",
  );
  writeReport(
    publicDir,
    path.join("UNSAFE", "2026-07-30"),
    { auditStatus: "legacy_unverified", analysisStatus: "insufficient_evidence" },
    "**Sell**\n\nThis unsafe legacy report contains a directional conclusion.\n",
  );
  writeReport(
    publicDir,
    path.join("VERIFIED", "2026-07-30"),
    {
      auditStatus: "verified",
      analysisStatus: "rated",
      claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
    },
    "**Hold**\n",
  );
  writeReport(
    publicDir,
    path.join("STALE", "2026-07-30"),
    {
      auditStatus: "verified",
      analysisStatus: "rated",
      claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
    },
    "**Sell**\n",
  );
  writeReport(
    publicDir,
    path.join("SMUGGLED", "2026-07-30"),
    { auditStatus: "legacy_unverified", analysisStatus: "insufficient_evidence" },
    "**Not Rated**\n\nThe generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions.\n\n**Sell**\n",
  );
  writeJson(path.join(publicDir, "data", "report-audit.json"), {
    reports: [
      {
        report: "reports/VERIFIED/2026-07-30/complete_report.md",
        auditStatus: "verified",
        analysisStatus: "rated",
        claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
      },
      {
        report: "reports/STALE/2026-07-30/complete_report.md",
        auditStatus: "invalidated",
        analysisStatus: "rated",
        claimValidation: { status: "passed", omittedUnsafeParagraphs: 0 },
      },
    ],
  });

  const result = spawnSync(process.execPath, [PREPARE_SCRIPT, publicDir, outputDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(outputDir, "index.html"), "utf8"), "safe app");

  const unverifiedDir = path.join(outputDir, "reports", "UNVERIFIED", "2026-07-30");
  const unverifiedMarket = fs.readFileSync(
    path.join(unverifiedDir, "1_analysts", "market.md"),
    "utf8",
  );
  const unverifiedDecision = fs.readFileSync(
    path.join(unverifiedDir, "5_portfolio", "decision.md"),
    "utf8",
  );
  assert.match(unverifiedMarket, /Not Rated/);
  assert.match(unverifiedDecision, /Not Rated/);
  assert.doesNotMatch(unverifiedMarket, /raw analyst direction/);
  assert.doesNotMatch(unverifiedDecision, /Underweight/);
  assert.match(fs.readFileSync(path.join(unverifiedDir, "complete_report.md"), "utf8"), /Not Rated/);

  const unsafeComplete = fs.readFileSync(
    path.join(outputDir, "reports", "UNSAFE", "2026-07-30", "complete_report.md"),
    "utf8",
  );
  assert.match(unsafeComplete, /Not Rated/);
  assert.doesNotMatch(unsafeComplete, /Sell|Underweight/);

  const verifiedDir = path.join(outputDir, "reports", "VERIFIED", "2026-07-30");
  assert.equal(fs.readFileSync(path.join(verifiedDir, "1_analysts", "market.md"), "utf8"), "raw analyst direction");
  assert.equal(fs.readFileSync(path.join(verifiedDir, "5_portfolio", "decision.md"), "utf8"), "评级：Underweight");

  const staleDir = path.join(outputDir, "reports", "STALE", "2026-07-30");
  assert.match(
    fs.readFileSync(path.join(staleDir, "1_analysts", "market.md"), "utf8"),
    /Not Rated/,
  );
  assert.doesNotMatch(fs.readFileSync(path.join(staleDir, "complete_report.md"), "utf8"), /Sell/);

  const smuggled = fs.readFileSync(
    path.join(outputDir, "reports", "SMUGGLED", "2026-07-30", "complete_report.md"),
    "utf8",
  );
  assert.match(smuggled, /Not Rated/);
  assert.doesNotMatch(smuggled, /Sell/);
});

test("deploy workflow publishes the filtered artifact instead of public", () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, ".github", "workflows", "deploy-workbench.yml"),
    "utf8",
  );
  assert.match(workflow, /node scripts\/prepare-pages-public\.mjs public build\/pages-public/);
  assert.match(workflow, /pages deploy build\/pages-public/);
  assert.doesNotMatch(workflow, /pages deploy public(?:\s|$)/);
});

test("deploy workflow verifies the static manifest instead of relying on D1 fallback", () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, ".github", "workflows", "deploy-workbench.yml"),
    "utf8",
  );
  assert.match(workflow, /name:\s*Verify deployed static manifest/i);
  assert.match(workflow, /\/data\/deployment\.json/);
  assert.match(workflow, /manifest\?\.commitSha\s*===\s*process\.env\.DEPLOY_SHA/);
});

test("every GitHub Pages workflow uploads the same policy-filtered artifact", () => {
  for (const name of ["analysis-request.yml", "daily-analysis.yml"]) {
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, ".github", "workflows", name),
      "utf8",
    );
    assert.match(
      workflow,
      /node scripts\/prepare-pages-public\.mjs public build\/pages-public/,
      name,
    );
    assert.match(workflow, /path:\s*build\/pages-public/, name);
    assert.doesNotMatch(workflow, /path:\s*public(?:\s|$)/, name);
  }
});
