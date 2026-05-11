import * as crypto from "node:crypto";
import * as path from "node:path";

function safeSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "plan"
  );
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function canonicalSourcePlanClaimId(
  gstackRepo: string,
  sourcePlanPath: string,
): string {
  const repoKey = path.resolve(gstackRepo);
  const planKey = path.resolve(sourcePlanPath);
  const stem = safeSegment(path.basename(planKey).replace(/\.md$/i, ""));
  return `${stem}-${shortHash(`${repoKey}\0${planKey}`)}`;
}

export function canonicalSourcePlanClaimPath(
  gstackRepo: string,
  sourcePlanPath: string,
): string {
  return path.join(
    path.resolve(gstackRepo),
    "inbox",
    ".claims",
    `${canonicalSourcePlanClaimId(gstackRepo, sourcePlanPath)}.json`,
  );
}

export function legacySourcePlanClaimPath(
  gstackRepo: string,
  sourcePlanPath: string,
): string {
  return path.join(
    path.resolve(gstackRepo),
    "inbox",
    ".claims",
    `${path.basename(sourcePlanPath)}.json`,
  );
}

export function sourcePlanClaimPaths(
  gstackRepo: string,
  sourcePlanPath: string,
): string[] {
  const canonical = canonicalSourcePlanClaimPath(gstackRepo, sourcePlanPath);
  const legacy = legacySourcePlanClaimPath(gstackRepo, sourcePlanPath);
  return canonical === legacy ? [canonical] : [canonical, legacy];
}
