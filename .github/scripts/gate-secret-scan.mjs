#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn("bun", [
  "bin/gstack-redact",
  "--repo-visibility", "public",
  "--json",
  "--max-bytes", "16000000",
], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
let diff = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { diff += chunk; });
process.stdin.once("end", () => {
  const additions = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  child.stdin.end(additions);
});
let stdout = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.once("error", (error) => { throw error; });
child.once("close", (code) => {
  const report = JSON.parse(stdout);
  const high = Number(report.counts?.HIGH ?? 0);
  const medium = Number(report.counts?.MEDIUM ?? 0);
  console.log(`credential scan: ${high} high, ${medium} advisory`);
  process.exitCode = high > 0 || report.oversize || ![0, 2, 3].includes(code) ? 1 : 0;
});
