import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const indexPath = resolve(root, "public/index.html");
const assetPaths = [
  resolve(root, "public/assets/workbench.css"),
  resolve(root, "public/assets/workbench.js"),
];

const digest = createHash("sha256");
for (const path of assetPaths) digest.update(await readFile(path));
const version = digest.digest("hex").slice(0, 12);
const source = await readFile(indexPath, "utf8");
const updated = source
  .replace(/(\.\/assets\/workbench\.css\?v=)[^"']+/g, `$1${version}`)
  .replace(/(\.\/assets\/workbench\.js\?v=)[^"']+/g, `$1${version}`);

if (process.argv.includes("--check")) {
  if (updated !== source) {
    console.error(`asset cache version is stale; run node scripts/asset-version.mjs (expected ${version})`);
    process.exit(1);
  }
  console.log(`asset cache version ${version} is current`);
} else if (updated !== source) {
  await writeFile(indexPath, updated, "utf8");
  console.log(`updated public/index.html asset version to ${version}`);
} else {
  console.log(`asset cache version ${version} is already current`);
}
