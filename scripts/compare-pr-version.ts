#!/usr/bin/env bun
// compare-pr-version — CI gate helper. Compares the util's next-slot output
// against the PR's branch VERSION. Exits 0 (pass), 1 (confirmed collision),
// or 2 (util was offline — fail-open per user decision, exit 0 with warning).
//
// Input:
//   argv[2] — path to next.json (the util's JSON output)
//   argv[3] — optional PR number for log lines
//
// Design note: fail-open on util error. A gstack bug must never freeze the
// merge queue. Confirmed collisions (util OK, PR version < next slot) DO block.

import { readFileSync } from "node:fs";

const [, , jsonPath, prNumber] = process.argv;
if (!jsonPath) {
  console.error("Usage: compare-pr-version <next.json> [pr-number]");
  process.exit(2);
}

let parsed: any;
try {
  parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch (e) {
  console.log("::warning::could not parse util output; failing open");
  process.exit(0);
}

if (parsed.offline === true) {
  console.log("::warning::workspace-aware-ship util offline; failing open (no collision check performed)");
  console.log(`::notice::If you merge this PR and a queued PR landed ahead, CHANGELOG may need manual reconciliation.`);
  process.exit(0);
}

// PR_VERSION is supplied via env (set by the workflow from `cat VERSION`).
const prVersion = (process.env.PR_VERSION ?? "").trim();
const nextSlot = parsed.version;

if (!prVersion) {
  console.log("::warning::PR_VERSION not set; failing open");
  process.exit(0);
}

// Parse versions for comparison.
function parseV(s: string): number[] | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}
function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
const pPR = parseV(prVersion);
const pNext = parseV(nextSlot);
if (!pPR || !pNext) {
  console.log(`::warning::malformed version string (PR=${prVersion}, next=${nextSlot}); failing open`);
  process.exit(0);
}

const tag = prNumber ? `PR #${prNumber}` : "this PR";

// Emit a GitHub step summary (always helpful, even on pass).
const claimedList = (parsed.claimed ?? [])
  .map((c: any) => `  #${c.pr} ${c.branch} → v${c.version}`)
  .join("\n");

console.log(`::group::Version gate (${tag})`);
console.log(`  PR VERSION:  v${prVersion}`);
console.log(`  Next slot:   v${nextSlot}`);
console.log(`  Queue (${(parsed.claimed ?? []).length} open PRs claiming versions):`);
if (claimedList) console.log(claimedList);
console.log("::endgroup::");

if (cmp(pPR, pNext) >= 0) {
  console.log(`✓ ${tag} claims v${prVersion} — slot is free (next would be v${nextSlot}).`);
  process.exit(0);
}

// Confirmed collision: PR version is stale.
console.log(`::error::VERSION drift: ${tag} claims v${prVersion} but the queue has moved — next free slot is v${nextSlot}.`);
console.log(`::error::Rerun /ship from the feature branch to reconcile. /ship's ALREADY_BUMPED branch handles this atomically (VERSION, package.json, CHANGELOG, PR title).`);
process.exit(1);
