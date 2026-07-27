import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commitSha = String(process.env.DEPLOY_SHA || "").trim().toLowerCase();
const branch = String(process.env.DEPLOY_BRANCH || "main").trim();

if (!/^[0-9a-f]{7,64}$/.test(commitSha)) {
  throw new Error("DEPLOY_SHA must be a Git commit SHA");
}
if (!/^[A-Za-z0-9._/-]{1,128}$/.test(branch)) {
  throw new Error("DEPLOY_BRANCH is invalid");
}

const output = resolve(root, "public", "data", "deployment.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  commitSha,
  deployedAt: new Date().toISOString(),
  branch,
}, null, 2)}\n`, "utf8");
