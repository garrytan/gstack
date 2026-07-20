#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RUNTIME_COMPONENT_DEPENDENCIES,
  runtimeReleaseComponentForPath,
} from "../../runtime/install.js";

const [activeInput, outputInput] = process.argv.slice(2);
if (!activeInput || !outputInput) {
  console.error("Usage: stage-runtime-components.mjs <active-runtime> <output-dir>");
  process.exit(2);
}

const active = await fs.realpath(path.resolve(activeInput));
const output = path.resolve(outputInput);
const manifest = JSON.parse(await fs.readFile(path.join(active, ".gstack-bundle.json"), "utf8"));
if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.files)) {
  throw new Error("Active runtime has no supported bundle manifest");
}

const componentIds = Object.keys(RUNTIME_COMPONENT_DEPENDENCIES).sort();
const summary = Object.fromEntries(componentIds.map((id) => [id, { files: 0, bytes: 0 }]));
for (const id of componentIds) await fs.mkdir(path.join(output, id, "gstack"), { recursive: true, mode: 0o700 });

for (const file of manifest.files) {
  if (!file || typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error("Bundle manifest contains an invalid file record");
  }
  const relative = normalizeRelative(file.path);
  const component = runtimeReleaseComponentForPath(relative);
  if (component == null) continue; // Playwright's local GC bookkeeping is not runtime input.
  if (!summary[component]) throw new Error(`No release component declared for ${relative}`);
  const source = safeJoin(active, relative);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe runtime source file: ${relative}`);
  if (stat.size !== file.size || await sha256File(source) !== file.sha256) {
    throw new Error(`Runtime file changed before component staging: ${relative}`);
  }
  const destination = safeJoin(path.join(output, component, "gstack"), relative);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  if (process.platform !== "win32") await fs.chmod(destination, stat.mode & 0o777);
  summary[component].files += 1;
  summary[component].bytes += stat.size;
}

for (const [component, details] of Object.entries(summary)) {
  if (details.files === 0) throw new Error(`Release component is empty: ${component}`);
}
await fs.writeFile(path.join(output, "components.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o644 });
process.stdout.write(`${JSON.stringify(summary)}\n`);

function normalizeRelative(value) {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Unsafe manifest path: ${value}`);
  }
  return normalized;
}

function safeJoin(root, relative) {
  const target = path.resolve(root, ...relative.split("/"));
  const relation = path.relative(root, target);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Path escaped component root: ${relative}`);
  }
  return target;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}
