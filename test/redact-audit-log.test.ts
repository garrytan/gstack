/**
 * Audit-log tests (D5/T14). The semantic-review trail records outcome +
 * categories + a body sha256 — never the body text. File is 0600. The CLI
 * stamps ts + hash from a body file.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { appendSemanticReview, sha256 } from "../lib/redact-audit-log";

const LIB = path.resolve(import.meta.dir, "..", "lib", "redact-audit-log.ts");
let home: string;

function logPath(): string {
  return path.join(home, "security", "semantic-reviews.jsonl");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  process.env.GSTACK_HOME = home;
});
afterEach(() => {
  delete process.env.GSTACK_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("appendSemanticReview", () => {
  test("writes a JSONL line with the expected shape", () => {
    appendSemanticReview({
      ts: "2026-05-28T00:00:00Z",
      repo_visibility: "public",
      outcome: "flagged",
      categories_flagged: ["legal", "internal"],
      body_sha256: sha256("hello"),
    });
    const line = JSON.parse(fs.readFileSync(logPath(), "utf8").trim());
    expect(line.outcome).toBe("flagged");
    expect(line.categories_flagged).toEqual(["legal", "internal"]);
    expect(line.body_sha256).toBe(sha256("hello"));
    expect(line.repo_visibility).toBe("public");
  });

  test("never contains body content — only the hash", () => {
    const secret = "Bob Smith is incompetent and customer ACME is churning";
    appendSemanticReview({
      ts: "2026-05-28T00:00:00Z",
      repo_visibility: "private",
      outcome: "flagged",
      categories_flagged: ["legal"],
      body_sha256: sha256(secret),
    });
    const raw = fs.readFileSync(logPath(), "utf8");
    expect(raw).not.toContain("Bob Smith");
    expect(raw).not.toContain("ACME");
    expect(raw).toContain(sha256(secret));
  });

  test("file is mode 0600", () => {
    appendSemanticReview({
      ts: "t",
      repo_visibility: "private",
      outcome: "clean",
      categories_flagged: [],
      body_sha256: sha256(""),
    });
    const mode = fs.statSync(logPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("appends (does not overwrite)", () => {
    for (const o of ["clean", "flagged"] as const) {
      appendSemanticReview({
        ts: "t",
        repo_visibility: "private",
        outcome: o,
        categories_flagged: [],
        body_sha256: sha256(o),
      });
    }
    const lines = fs.readFileSync(logPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});

describe("CLI", () => {
  test("stamps ts + body_sha256 from a body file", () => {
    const bodyFile = path.join(home, "body.txt");
    fs.writeFileSync(bodyFile, "some draft content");
    const r = spawnSync(
      "bun",
      [LIB, JSON.stringify({ repo_visibility: "public", outcome: "flagged", categories_flagged: ["pii"] }), bodyFile],
      { env: { ...process.env, GSTACK_HOME: home }, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const line = JSON.parse(fs.readFileSync(logPath(), "utf8").trim());
    expect(line.outcome).toBe("flagged");
    expect(line.body_sha256).toBe(sha256("some draft content"));
    expect(typeof line.ts).toBe("string");
    expect(line.ts.length).toBeGreaterThan(10);
  });
});
