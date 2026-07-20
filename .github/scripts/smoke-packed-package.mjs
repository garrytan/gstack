#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(process.argv[2] ?? process.cwd());
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "gstack-npm-smoke-"));
try {
  const pack = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], root);
  const [metadata] = JSON.parse(pack.stdout);
  if (!metadata?.filename || metadata.size > 2_000_000 || metadata.entryCount > 80) {
    throw new Error(`Unexpected npm package shape: ${JSON.stringify(metadata)}`);
  }
  const archive = path.join(temporary, metadata.filename);
  const project = path.join(temporary, "consumer");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "package.json"), '{"private":true}\n');
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", archive], project);

  const installed = path.join(project, "node_modules", "gstack");
  const pkg = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
  if (pkg.gstack?.packageRole !== "runtime-control") throw new Error("Packed role metadata is missing");
  for (const excluded of ["skills", "browse", "design", "make-pdf", "setup"]) {
    if (await exists(path.join(installed, excluded))) throw new Error(`Packed package unexpectedly contains ${excluded}`);
  }

  const state = path.join(temporary, "state");
  const env = { ...process.env, GSTACK_HOME: state };
  const version = await run(process.execPath, [path.join(installed, "bin", "gstack"), "--version"], project, env);
  if (!version.stdout.includes(`gstack runtime ${pkg.gstack.runtimeVersion}`)) throw new Error("Packed gstack version mismatch");
  await run(process.execPath, [path.join(installed, "bin", "gstack"), "setup"], project, env);
  const doctor = await run(process.execPath, [path.join(installed, "bin", "gstack"), "doctor", "--json"], project, env, [0, 1]);
  const report = JSON.parse(doctor.stdout);
  if (!Array.isArray(report.checks) || !report.checks.some((check) => check.id === "config" && check.status === "pass")) {
    throw new Error("Packed setup/doctor did not initialize isolated runtime state");
  }
  const help = await run(process.execPath, [path.join(installed, "runtime", "runtime-bootstrap.mjs"), "--help"], project, env);
  if (!help.stdout.includes("Usage:")) {
    throw new Error(`Packed runtime bootstrap help is unavailable: ${JSON.stringify(help)}`);
  }
  console.log(JSON.stringify({ ok: true, size: metadata.size, entryCount: metadata.entryCount, version: pkg.version }));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

function run(command, args, cwd, env = process.env, allowed = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => allowed.includes(code) ? resolve({ stdout, stderr, code }) : reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stderr}`)));
  });
}
