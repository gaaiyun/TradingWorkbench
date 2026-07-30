import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function copyIfFile(source, target) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function writeRawTombstones(sourceDir, targetDir, placeholder) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      writeRawTombstones(sourcePath, targetPath, placeholder);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "complete_report.md") {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, placeholder, "utf8");
    }
  }
}

function safeReportIdentity(manifest, reportDir) {
  const directoryTicker = path.basename(path.dirname(reportDir));
  const ticker = /^[A-Za-z0-9._-]+$/.test(String(manifest?.ticker || ""))
    ? String(manifest.ticker)
    : directoryTicker;
  const tradeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(manifest?.tradeDate || ""))
    ? String(manifest.tradeDate)
    : "unknown";
  return { ticker, tradeDate };
}

function failClosedPlaceholder(manifest, reportDir) {
  const { ticker, tradeDate } = safeReportIdentity(manifest, reportDir);
  return `# Trading Analysis Report: ${ticker}\n\n`
    + `Trade date: ${tradeDate}\n\n`
    + `Analysis status: \`${manifest?.analysisStatus || "unverified"}\` · `
    + `Audit status: \`${manifest?.auditStatus || "unverified"}\`\n\n`
    + "## Research conclusion\n\n"
    + "**Not Rated**\n\n"
    + "This report did not pass the evidence gate. Directional, allocation, and trading conclusions are not published. "
    + "The raw agent sections remain available only in the GitHub audit record.\n";
}

function reportAuditIndex(source) {
  const audit = readJson(path.join(source, "data", "report-audit.json"));
  const entries = Array.isArray(audit?.reports) ? audit.reports : [];
  return new Map(entries.map((entry) => [String(entry?.report || ""), entry]));
}

function claimGatePassed(claimValidation) {
  return claimValidation?.status === "passed"
    && Number(claimValidation?.omittedUnsafeParagraphs || 0) === 0;
}

function readableLegacyArchive(auditEntry, completePath) {
  return auditEntry?.report === completePath
    && auditEntry?.auditStatus === "legacy_unverified"
    && auditEntry?.analysisStatus !== "insufficient_evidence"
    && auditEntry?.claimValidation?.status !== "failed";
}

function legacyArchiveBanner(auditEntry, reportDir) {
  const { ticker, tradeDate } = safeReportIdentity(auditEntry, reportDir);
  return "# Historical unverified report\n\n"
    + `> **Archive notice:** ${ticker} · ${tradeDate}. This is read-only historical output `
    + "that has not passed the current evidence gate. It is not current research or a "
    + "trading recommendation.\n\n---\n\n";
}

function copyLegacyArchive(sourceDir, targetDir, auditEntry) {
  const banner = legacyArchiveBanner(auditEntry, sourceDir);
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyLegacyArchive(sourcePath, targetPath, auditEntry);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      fs.writeFileSync(
        targetPath,
        `${banner}${fs.readFileSync(sourcePath, "utf8")}`,
        "utf8",
      );
    }
  }
}

function reportIsCurrentlyVerified(manifest, auditEntry, completePath) {
  return auditEntry?.report === completePath
    && auditEntry?.auditStatus === "verified"
    && auditEntry?.analysisStatus === "rated"
    && claimGatePassed(auditEntry?.claimValidation)
    && manifest?.auditStatus === "verified"
    && manifest?.analysisStatus === "rated"
    && claimGatePassed(manifest?.claimValidation);
}

function reportDirectories(reportsRoot) {
  if (!fs.existsSync(reportsRoot)) return [];
  const directories = [];
  for (const tickerEntry of fs.readdirSync(reportsRoot, { withFileTypes: true })) {
    if (!tickerEntry.isDirectory()) continue;
    const tickerDir = path.join(reportsRoot, tickerEntry.name);
    for (const reportEntry of fs.readdirSync(tickerDir, { withFileTypes: true })) {
      if (reportEntry.isDirectory()) directories.push(path.join(tickerDir, reportEntry.name));
    }
  }
  return directories;
}

export function preparePagesPublic(sourceDir, outputDir) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  if (source === output || output.startsWith(`${source}${path.sep}`)) {
    throw new Error("Pages output must be outside the public source directory");
  }
  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(source, output, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(source, entry);
      return !relative || relative.split(path.sep)[0] !== "reports";
    },
  });

  const sourceReports = path.join(source, "reports");
  const auditIndex = reportAuditIndex(source);
  for (const reportDir of reportDirectories(sourceReports)) {
    const relative = path.relative(source, reportDir);
    const completeReportPath = `${relative.split(path.sep).join("/")}/complete_report.md`;
    const targetDir = path.join(output, relative);
    const manifestPath = path.join(reportDir, "report_manifest.json");
    const manifest = readJson(manifestPath);
    const auditEntry = auditIndex.get(completeReportPath);
    if (readableLegacyArchive(auditEntry, completeReportPath)) {
      copyLegacyArchive(reportDir, targetDir, auditEntry);
      continue;
    }

    if (manifest && reportIsCurrentlyVerified(
      manifest,
      auditEntry,
      completeReportPath,
    )) {
      fs.cpSync(reportDir, targetDir, { recursive: true });
      continue;
    }

    fs.mkdirSync(targetDir, { recursive: true });
    copyIfFile(manifestPath, path.join(targetDir, "report_manifest.json"));
    copyIfFile(
      path.join(reportDir, "evidence_packet.json"),
      path.join(targetDir, "evidence_packet.json"),
    );
    fs.writeFileSync(
      path.join(targetDir, "complete_report.md"),
      failClosedPlaceholder(manifest || auditEntry, reportDir),
      "utf8",
    );
    // 同路径安全墓碑会覆盖旧部署/CDN 中可能残留的 raw Markdown；
    // 只删除文件不足以保证旧缓存立即失效。
    writeRawTombstones(
      reportDir,
      targetDir,
      "# Report section unavailable\n\n**Not Rated**\n\nThis raw section is not published.\n",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const sourceDir = process.argv[2] || "public";
  const outputDir = process.argv[3] || "build/pages-public";
  preparePagesPublic(sourceDir, outputDir);
  process.stdout.write(`Prepared filtered Pages artifact at ${path.resolve(outputDir)}\n`);
}
