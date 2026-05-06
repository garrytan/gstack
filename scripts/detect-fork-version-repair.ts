#!/usr/bin/env bun
// detect-fork-version-repair — CI helper for the version gate.
// Prints exactly "true" or "false" on stdout. Diagnostics go to stderr.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [, , baseRef, baseVersion, prVersion] = process.argv;

function finish(value: boolean, reason?: string): never {
  if (reason) console.error(reason);
  console.log(value ? "true" : "false");
  process.exit(0);
}

function parseV(s: string): number[] | null {
  const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function git(args: string[]): string | null {
  const result = spawnSync("git", args, { encoding: "utf-8" });
  if ((result.status ?? -1) !== 0) {
    if (result.stderr) console.error(result.stderr.trim());
    return null;
  }
  return result.stdout ?? "";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function changelogHeaderVersion(line: string): string | null {
  const match = line.match(/^##\s+\[?v?(\d+\.\d+\.\d+\.\d+)\]?/);
  return match ? match[1] : null;
}

function changelogHeaderVersions(text: string): string[] {
  return text.split(/\r?\n/).map(changelogHeaderVersion).filter((v): v is string => Boolean(v));
}

if (!baseRef || !baseVersion || !prVersion) {
  finish(false, "Usage: detect-fork-version-repair <base-ref> <base-version> <pr-version>");
}

const parsedBase = parseV(baseVersion);
const parsedPr = parseV(prVersion);
if (!parsedBase || !parsedPr) finish(false, "malformed version input");
if (cmp(parsedPr, parsedBase) >= 0) finish(false, "PR version is not lower than base version");

const claudeMd = readText("CLAUDE.md");
if (!claudeMd?.includes("## Fork versioning rule")) finish(false, "fork versioning rule not found");

const packageJson = readText("package.json");
if (!packageJson) finish(false, "package.json not readable");
try {
  const parsedPackage = JSON.parse(packageJson) as { version?: unknown };
  if (parsedPackage.version !== prVersion) finish(false, "package.json version does not match PR version");
} catch {
  finish(false, "package.json is not valid JSON");
}

const baseSpec = `origin/${baseRef}`;
const changedFiles = git(["diff", "--name-only", baseSpec, "HEAD"]);
if (changedFiles === null) finish(false, "could not read changed files");
const changed = new Set(changedFiles.split(/\r?\n/).filter(Boolean));
if (!changed.has("VERSION") || !changed.has("package.json") || !changed.has("CHANGELOG.md")) {
  finish(false, "required release metadata files are not all changed");
}

const baseChangelog = git(["show", `${baseSpec}:CHANGELOG.md`]);
const currentChangelog = readText("CHANGELOG.md");
if (baseChangelog === null || currentChangelog === null) finish(false, "CHANGELOG.md not readable");

const changelogDiff = git(["diff", "--unified=0", baseSpec, "HEAD", "--", "CHANGELOG.md"]);
if (changelogDiff === null) finish(false, "could not diff CHANGELOG.md");

const addedHeaders: string[] = [];
const removedHeaders: string[] = [];
for (const line of changelogDiff.split(/\r?\n/)) {
  if (line.startsWith("+++") || line.startsWith("---")) continue;
  if (line.startsWith("+")) {
    const version = changelogHeaderVersion(line.slice(1));
    if (version) addedHeaders.push(version);
  } else if (line.startsWith("-")) {
    const version = changelogHeaderVersion(line.slice(1));
    if (version) removedHeaders.push(version);
  }
}

if (addedHeaders.length > 0) finish(false, "CHANGELOG.md adds release headers");

const currentHeaders = new Set(changelogHeaderVersions(currentChangelog));
const baseHeadersAboveTarget = changelogHeaderVersions(baseChangelog).filter((version) => {
  const parsed = parseV(version);
  return parsed !== null && cmp(parsed, parsedPr) > 0;
});
if (baseHeadersAboveTarget.length === 0) finish(false, "base CHANGELOG has no headers above rollback target");

const removedHeadersAboveTarget = removedHeaders.filter((version) => {
  const parsed = parseV(version);
  return parsed !== null && cmp(parsed, parsedPr) > 0;
});
if (removedHeadersAboveTarget.length === 0) finish(false, "CHANGELOG.md does not remove release headers above rollback target");

if (baseHeadersAboveTarget.some((version) => currentHeaders.has(version))) {
  finish(false, "CHANGELOG.md still contains release headers above rollback target");
}

finish(true);
