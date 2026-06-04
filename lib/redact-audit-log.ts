/**
 * redact-audit-log — append-only forensic trail for the Phase 4.5a semantic
 * review (D5). Records WHETHER the semantic pass marked a body clean/flagged and
 * WHICH categories fired — never the body content. A body_sha256 lets a later
 * investigation confirm "the pass saw this exact draft and called it clean."
 *
 * The file (`~/.gstack/security/semantic-reviews.jsonl`) is sensitive metadata,
 * not "safe": it leaks repo names, timing, and a membership oracle via the hash.
 * Written 0600. Local-only — no third-party egress.
 *
 * Usable two ways:
 *   - CLI:  bun lib/redact-audit-log.ts '<json-line-without-ts/hash>' [body-file]
 *           (the skill passes the outcome JSON + a path to the scanned body; we
 *            stamp ts + body_sha256 and append.)
 *   - import { appendSemanticReview } from "./redact-audit-log";
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";

export interface SemanticReviewEntry {
  ts: string;
  spec_archive_path?: string;
  repo_visibility: string;
  outcome: "clean" | "flagged";
  categories_flagged: string[];
  body_sha256: string;
}

function securityDir(): string {
  const home = process.env.GSTACK_HOME || path.join(os.homedir(), ".gstack");
  return path.join(home, "security");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Append one entry. Best-effort: never throws into the caller's flow. */
export function appendSemanticReview(entry: SemanticReviewEntry): void {
  try {
    const dir = securityDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "semantic-reviews.jsonl");
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // chmod can fail on some filesystems; the append still happened.
    }
  } catch {
    // audit log is best-effort, not the security boundary
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function now(): string {
  // Date is allowed here (CLI process, not a resumable workflow).
  return new Date().toISOString();
}

if (import.meta.main) {
  const json = process.argv[2];
  const bodyFile = process.argv[3];
  if (!json) {
    process.stderr.write(
      'usage: redact-audit-log \'{"repo_visibility":"public","outcome":"flagged","categories_flagged":["legal"],"spec_archive_path":"..."}\' [body-file]\n',
    );
    process.exit(1);
  }
  let partial: Partial<SemanticReviewEntry>;
  try {
    partial = JSON.parse(json);
  } catch {
    process.stderr.write("redact-audit-log: invalid JSON\n");
    process.exit(1);
  }
  const body = bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
  appendSemanticReview({
    ts: now(),
    repo_visibility: partial.repo_visibility ?? "unknown",
    outcome: partial.outcome === "flagged" ? "flagged" : "clean",
    categories_flagged: partial.categories_flagged ?? [],
    body_sha256: sha256(body),
    ...(partial.spec_archive_path ? { spec_archive_path: partial.spec_archive_path } : {}),
  });
}
