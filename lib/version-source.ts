// version-source — where a repo's version lives, and how wide it is.
//
// gstack's native shape is a plain-text VERSION file at the repo root holding a
// 4-digit MAJOR.MINOR.PATCH.MICRO — and for gstack itself that file STAYS the
// source of truth (decision pinned in the v1.67 fix-wave plan: package.json is
// a translated mirror, never the authority). This module exists for the two
// real-world shapes that did not fit and both failed CLOSED in a way that
// silently disabled /ship's version tooling (#2501):
//
//   1. The version's home is a package.json — often not at the root (a monorepo
//      whose frontend/package.json is the single source of truth because the
//      build injects it). The --version-path / .gstack/version-path pin already
//      let you point anywhere, but the readers treated the target as raw text,
//      so a JSON file was whitespace-stripped into `{"name":"frontend",...` and
//      every version read came back as the 0.0.0.0 fallback — including rival
//      PRs' claims fetched through the GitHub Contents API, which were then
//      dropped as "malformed".
//   2. The version is 3-digit semver. parseVersion() required exactly four
//      components, so gstack-next-version exited 2 ("could not parse base
//      version") on every invocation — and that CLI *is* the queue-collision
//      check, so /ship fell through to its documented "offline" path of naive
//      local arithmetic. Two branches cut from the same base then pick the same
//      version, and git merges that without a conflict because both sides set
//      one line to identical text. The duplicate slot ships silently.
//
// Both are handled here rather than in each CLI so the two agree by construction.
//
// Detection is by shape, not configuration: a version-path ending in .json is
// read as JSON (.version), anything else as trimmed text; a version string with
// three components stays three components through bumping and formatting. A
// repo with a root VERSION file and 4-digit versions sees no behaviour change.
//
// Re-derived from PR #2501 by @YiftahR.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Version = [number, number, number, number];
export type VersionWidth = 3 | 4;
export type Bump = "major" | "minor" | "patch" | "micro";

/** Parse 3- or 4-component versions. 3-digit pads to [a,b,c,0] so comparison stays uniform. */
export function parseVersion(s: string): Version | null {
  const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
}

/** How many components the string actually had — what to format back out as. */
export function versionWidth(s: string): VersionWidth {
  return /^\d+\.\d+\.\d+\.\d+$/.test(s.trim()) ? 4 : 3;
}

export function fmtVersion(v: Version, width: VersionWidth = 4): string {
  return v.slice(0, width).join(".");
}

export function cmpVersion(a: Version, b: Version): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Bump one level. In a 3-digit repo there is no MICRO component to move, so
 * `micro` is carried out as a PATCH: /ship auto-picks MICRO by default, and
 * erroring there would make it unusable in every 3-digit repo — a silent no-op
 * would be worse still, since the caller would then write back the version it
 * started with and claim a taken slot.
 */
export function bumpVersion(v: Version, level: Bump, width: VersionWidth = 4): Version {
  const effective: Bump = width === 3 && level === "micro" ? "patch" : level;
  switch (effective) {
    case "major":
      return [v[0] + 1, 0, 0, 0];
    case "minor":
      return [v[0], v[1] + 1, 0, 0];
    case "patch":
      return [v[0], v[1], v[2] + 1, 0];
    case "micro":
      return [v[0], v[1], v[2], v[3] + 1];
  }
}

/** True when the effective bump differs from the one asked for (so callers can say so). */
export function bumpWasCoerced(level: Bump, width: VersionWidth): boolean {
  return width === 3 && level === "micro";
}

/**
 * The npm-valid form of a gstack version. npm's semver is 3-component and
 * rejects a fourth, so the 4-digit MAJOR.MINOR.PATCH.MICRO truncates to
 * MAJOR.MINOR.PATCH; 3-digit versions pass through unchanged. Per the
 * version-tooling end-state spec (v1.67 fix-wave plan, decision 11): the
 * manifest mirror always carries this form, and VERSION stays the 4-digit
 * source of truth.
 */
export function npmVersion(version: string): string {
  return version.trim().split(".").slice(0, 3).join(".");
}

/** A version-path pointing at a .json is read as JSON, not as raw text. */
export function isJsonVersionPath(versionPath: string): boolean {
  return /\.json$/i.test(versionPath.trim());
}

/**
 * Pull the version out of whatever the version-path resolves to. `text` is the
 * file's contents from anywhere — local read, `git show`, or a base64-decoded
 * API response — so every reader agrees on interpretation. Returns "" when
 * there is no usable version, which callers map to their own fallback.
 */
export function extractVersion(text: string, versionPath: string): string {
  if (!isJsonVersionPath(versionPath)) return text.replace(/[\r\n\s]/g, "");
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed?.version === "string" ? parsed.version.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Write a version back into a JSON file, preserving the rest of it. Deliberately
 * key-order-preserving (JSON.parse/stringify keeps insertion order) and 2-space
 * indented with a trailing newline, matching what package managers write.
 */
export function setVersionInJson(raw: string, version: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.version = version;
  return JSON.stringify(parsed, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Where the version lives, as one of four outcomes (#2334, #2343).
//
// Most repos /ship runs in have no VERSION file. Folding "no file" into
// 0.0.0.0 made /ship invent a version (or stop on DRIFT_UNEXPECTED when a
// package.json disagreed with the invented zero). Every reader now asks this
// resolver instead and reads the same signal:
//
//   valid      a configured source holds a parsable version — use it.
//   absent     nothing configured — ship without a version change.
//   ambiguous  nothing configured, and release automation, a workspace
//              monorepo or a placeholder version says the version is owned
//              elsewhere — ship without a version change and say why.
//   broken     a configured source is missing, empty, unreadable or
//              malformed — stop with the reason. Never substitute 0.0.0.0.
//
// "Configured" means --version-path, the .gstack/version-path pin, or a root
// VERSION file. A root package.json alone is not a configured source: pin it
// in .gstack/version-path to have /ship version it.

export type VersionSourceOutcome = "valid" | "absent" | "ambiguous" | "broken";

export interface VersionSource {
  outcome: VersionSourceOutcome;
  /** Repo-relative path of the version file, or null when none is configured. */
  path: string | null;
  pinnedBy: "--version-path" | ".gstack/version-path" | null;
  /** The parsed version string (outcome "valid" only). */
  version: string | null;
  /** Why the outcome is not "valid"; null when it is. */
  reason: string | null;
}

export const NO_VERSION_NOTICE =
  "Shipped without a version change: no version source is configured (no VERSION file, no .gstack/version-path). " +
  "To version releases, create VERSION or write the version file's path (for example package.json) to .gstack/version-path.";

/** The one line every no-version reader prints. Null when a version exists or the source is broken. */
export function noVersionNotice(src: VersionSource): string | null {
  if (src.outcome === "absent") return NO_VERSION_NOTICE;
  if (src.outcome === "ambiguous") {
    return (
      `Shipped without a version change: the version source is ambiguous (${src.reason}). ` +
      "To have /ship version releases, write the version file's path (for example package.json) to .gstack/version-path."
    );
  }
  return null;
}

/**
 * The version file's repo-relative path and who chose it:
 * --version-path, else the first line of .gstack/version-path, else VERSION.
 * A blank pin file is no pin. `guard` runs on every configured path before it
 * is read (gstack-version-bump's repo-containment check).
 */
export function resolveVersionRel(
  repoRoot: string,
  explicit?: string,
  guard?: (rel: string, source: string) => void,
): { rel: string; pinnedBy: VersionSource["pinnedBy"] } {
  if (explicit && explicit.trim()) {
    const rel = explicit.trim();
    guard?.(rel, "--version-path");
    return { rel, pinnedBy: "--version-path" };
  }
  const pin = join(repoRoot, ".gstack", "version-path");
  if (existsSync(pin)) {
    const rel = readFileSync(pin, "utf-8").split("\n")[0]?.trim() ?? "";
    if (rel) {
      guard?.(rel, ".gstack/version-path");
      return { rel, pinnedBy: ".gstack/version-path" };
    }
  }
  return { rel: "VERSION", pinnedBy: null };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why an unconfigured repo's version is owned by something other than /ship, or null. */
function ambiguityReason(repoRoot: string): string | null {
  const has = (rel: string) => existsSync(join(repoRoot, rel));
  const pkg = readJson(join(repoRoot, "package.json"));
  const found = (names: string[]) => names.find(has);
  const rp = found(["release-please-config.json", ".release-please-manifest.json"]);
  if (rp) return `release-please manages versions here (${rp})`;
  if (has(".changeset/config.json")) return "Changesets manages versions here (.changeset/config.json)";
  const sr = found([
    ".releaserc", ".releaserc.json", ".releaserc.yaml", ".releaserc.yml", ".releaserc.js", ".releaserc.cjs",
    "release.config.js", "release.config.cjs", "release.config.mjs",
  ]);
  if (sr || (pkg && "release" in pkg)) return `semantic-release manages versions here (${sr ?? "package.json release"})`;
  const ws = found(["pnpm-workspace.yaml", "lerna.json"]) ?? (pkg && "workspaces" in pkg ? "package.json workspaces" : undefined);
  if (ws) return `this is a monorepo with no single version file (${ws})`;
  const v = pkg?.version;
  if (typeof v === "string" && /^0\.0\.0(?:-|$)/.test(v.trim())) {
    return `package.json holds the placeholder version ${v.trim()}`;
  }
  return null;
}

/** Resolve the version source to one of the four outcomes. Never throws for file problems. */
export function resolveVersionSource(
  repoRoot: string,
  explicit?: string,
  guard?: (rel: string, source: string) => void,
): VersionSource {
  let resolved: ReturnType<typeof resolveVersionRel>;
  try {
    resolved = resolveVersionRel(repoRoot, explicit, guard);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? "read failed";
    return { outcome: "broken", path: null, pinnedBy: ".gstack/version-path", version: null, reason: `.gstack/version-path is unreadable (${code})` };
  }
  const { rel, pinnedBy } = resolved;
  const abs = join(repoRoot, rel);
  const by = pinnedBy ? ` (set by ${pinnedBy})` : "";
  const broken = (why: string): VersionSource => ({ outcome: "broken", path: rel, pinnedBy, version: null, reason: why + by });
  if (!existsSync(abs)) {
    if (pinnedBy) return broken(`${rel} does not exist`);
    const why = ambiguityReason(repoRoot);
    return { outcome: why ? "ambiguous" : "absent", path: null, pinnedBy: null, version: null, reason: why ?? "no VERSION file and no .gstack/version-path" };
  }
  let raw: string;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch (e) {
    return broken(`${rel} is unreadable (${(e as NodeJS.ErrnoException)?.code ?? "read failed"})`);
  }
  if (!raw.trim()) return broken(`${rel} is empty or contains no parsable version`);
  const v = extractVersion(raw, rel);
  if (!v || !parseVersion(v)) {
    const shown = isJsonVersionPath(rel) ? (v ? `"version": "${v}"` : "no \"version\" string") : `"${raw.trim().slice(0, 40)}"`;
    return broken(`${rel} contains no parsable version (found ${shown})`);
  }
  return { outcome: "valid", path: rel, pinnedBy, version: v, reason: null };
}
