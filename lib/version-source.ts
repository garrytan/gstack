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
