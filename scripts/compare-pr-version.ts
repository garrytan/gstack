#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// compare-pr-version — CI gate helper. Validates the PR's branch VERSION
// against the queue of other open PRs' claimed versions. Exits 0 (pass)
// or 1 (confirmed collision).
//
// Input:
//   argv[2] — path to next.json (the util's JSON output)
//   argv[3] — optional PR number for log lines
//
// Design note: fail-open on util error. A gstack bug must never freeze the
// merge queue. The gate enforces ONE rule: this PR must not claim the same
// version as another open PR. Lower-than-the-util's-suggestion is fine if
// the slot is unclaimed — that preserves monotonic version ordering on main
// when this PR lands ahead of higher-numbered queued PRs. The util's output
// is informational (the *recommended* slot for fresh /ship runs); the gate
// only blocks actual collisions.

import { readFileSync } from "node:fs";
import { classifyTrainHead } from "../lib/version-gate-train";

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

const tag = prNumber ? `PR #${prNumber}` : "this PR";
const prVersionEnv = (process.env.PR_VERSION ?? "").trim();

// Merge trains: when the base's ship policy declares a `train` block, a READY
// head is unstamped and the lane stamps at its slot (docs/ship-policy.md#run-a-merge-train).
// The workflow passes BASE_REF and HEAD_SHA with the PR head checked out as cwd.
if (process.env.BASE_REF && process.env.HEAD_SHA) {
  const train = classifyTrainHead({ repoRoot: process.cwd(), baseRef: process.env.BASE_REF, head: process.env.HEAD_SHA, author: process.env.PR_AUTHOR });
  if (train.kind === "unstamped") {
    const entry = train.entry === "fragment" ? `its entry is ${train.fragments} CHANGELOG fragment(s)` : train.entry === "none-bot" ? "it is a bot PR with no entry (the merge step writes one from its title)" : "the CHANGELOG change is confined to [Unreleased]";
    console.log(`✓ ${tag} is unstamped under the base's ship policy: VERSION and package.json match its merge base, any changed release output is what the release tool generates at the merge base's VERSION, and ${entry}. The merge step stamps it.`);
    process.exit(0);
  }
  if (train.kind === "invalid") {
    console.log(`::error::${tag}: ${train.reason}.`);
    process.exit(1);
  }
  if (train.kind === "stamped" && prVersionEnv !== train.expected) {
    console.log(`::error::${tag} claims v${prVersionEnv}, but under the base's ship policy a stamped head must carry v${train.expected} (base + the effective bump, what gstack-restamp --next allocates at the merge step). Leave VERSION, package.json and the release outputs at the base's values until the merge step stamps them.`);
    process.exit(1);
  }
  if (train.kind === "stamped" && train.fragments) {
    console.log(`✓ ${tag} carries v${train.expected}, what the merge step allocates under changelog_fragments; the land lock serializes allocation, so open claims do not apply.`);
    process.exit(0);
  }
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

const claimed = (parsed.claimed ?? []) as Array<{ pr: number; branch: string; version: string; url?: string }>;

// Emit a GitHub step summary (always helpful, even on pass).
const claimedList = claimed
  .map((c) => `  #${c.pr} ${c.branch} → v${c.version}`)
  .join("\n");

console.log(`::group::Version gate (${tag})`);
console.log(`  PR VERSION:    v${prVersion}`);
console.log(`  Suggested:     v${nextSlot} (util's next-slot recommendation)`);
console.log(`  Queue (${claimed.length} open PRs claiming versions):`);
if (claimedList) console.log(claimedList);
console.log("::endgroup::");

// Dependabot never edits VERSION, so hard rule 1 would fail every dependency
// PR it opens. Exempt it only when the author is dependabot and every changed
// file is a dependency manifest, a lockfile or the dependabot config. The
// workflow passes the author and the file list; an empty list (the lookup
// failed) keeps the rule.
const DEPENDENCY_FILE = /(?:^|\/)(?:package\.json|bun\.lockb?)$|^\.github\/dependabot\.yml$/;
const changedFiles = (process.env.PR_CHANGED_FILES ?? "").split("\n").map((f) => f.trim()).filter(Boolean);
const dependabotManifestOnly =
  process.env.PR_AUTHOR === "dependabot[bot]" && changedFiles.length > 0 && changedFiles.every((f) => DEPENDENCY_FILE.test(f));

// Hard rule 1: this PR's VERSION must be strictly greater than the base
// version, otherwise we're not actually bumping.
const pBase = parseV((parsed.base_version ?? "").trim());
if (pBase && cmp(pPR, pBase) <= 0) {
  if (dependabotManifestOnly) {
    console.log(`::notice::${tag} is a dependabot dependency update (${changedFiles.join(", ")}); VERSION bump not required.`);
    process.exit(0);
  }
  console.log(`::error::VERSION not bumped: ${tag} claims v${prVersion} but base is v${parsed.base_version}.`);
  process.exit(1);
}

// Hard rule 2: no collision with another open PR's claimed VERSION.
const collision = claimed.find((c) => c.version.trim() === prVersion);
if (collision) {
  console.log(`::error::VERSION collision: ${tag} claims v${prVersion} but #${collision.pr} (${collision.branch}) already claims the same slot.`);
  console.log(`::error::Rerun /ship to pick a different slot, or coordinate with #${collision.pr} on landing order.`);
  process.exit(1);
}

// Optional informational note: PR version is below the util's suggested next
// slot. This is allowed — the suggested slot is a recommendation for /ship's
// next run, but landing at a lower-but-unclaimed slot first preserves
// monotonic ordering on main when this PR merges ahead of higher-numbered
// queued PRs.
if (cmp(pPR, pNext) < 0) {
  console.log(`::notice::${tag} claims v${prVersion}, below util's suggestion v${nextSlot}. Slot is unclaimed; gate passes. If this PR lands ahead of queued PRs at higher slots, version ordering on main remains monotonic.`);
}

console.log(`✓ ${tag} claims v${prVersion} — slot is free.`);
process.exit(0);
