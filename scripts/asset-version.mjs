import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const indexPath = resolve(root, "public/index.html");
const assetPaths = [
  resolve(root, "public/assets/workbench.css"),
  resolve(root, "public/assets/workbench.js"),
  resolve(root, "public/assets/workbench-fundflow.mjs"),
  resolve(root, "public/assets/workbench-research.mjs"),
];

const digest = createHash("sha256");
for (const path of assetPaths) {
  // Git checks out LF on CI and may leave CRLF in the Windows worktree. The
  // cache key must represent the bytes served by the static host, not the
  // platform newline convention.
  const normalized = (await readFile(path, "utf8"))
    .replace(/\r\n/g, "\n")
    .replace(
      /(\.\/workbench-(?:fundflow|research)\.mjs)(?:\?v=[a-f0-9]{12})?/g,
      "$1",
    );
  digest.update(normalized);
}
const version = digest.digest("hex").slice(0, 12);
const source = await readFile(indexPath, "utf8");
const updated = source
  .replace(/(\.\/assets\/workbench\.css\?v=)[^"']+/g, `$1${version}`)
  .replace(/(\.\/assets\/workbench\.js\?v=)[^"']+/g, `$1${version}`);
const workbenchPath = resolve(root, "public/assets/workbench.js");
const workbenchSource = await readFile(workbenchPath, "utf8");
const updatedWorkbench = workbenchSource.replace(
  /(\.\/workbench-(?:fundflow|research)\.mjs)(?:\?v=[a-f0-9]{12})?/g,
  `$1?v=${version}`,
);

if (process.argv.includes("--check")) {
  if (updated !== source || updatedWorkbench !== workbenchSource) {
    console.error(`asset cache version is stale; run node scripts/asset-version.mjs (expected ${version})`);
    process.exit(1);
  }
  console.log(`asset cache version ${version} is current`);
} else if (updated !== source || updatedWorkbench !== workbenchSource) {
  await Promise.all([
    writeFile(indexPath, updated, "utf8"),
    writeFile(workbenchPath, updatedWorkbench, "utf8"),
  ]);
  console.log(`updated public/index.html asset version to ${version}`);
} else {
  console.log(`asset cache version ${version} is already current`);
}
