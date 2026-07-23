/**
 * Static invariant tests for /garygoal (gate-tier, free, no LLM).
 *
 * Each test pins a safety or orchestration contract the
 * garygoal/SKILL.md.tmpl must encode. If the template drifts — a rewrite
 * drops the never-merge list, softens the premise gate, or lets the agent
 * advance state by prose — these fail immediately.
 *
 * Covers:
 *   garygoal-deterministic-state — every transition goes through gstack-garygoal
 *   garygoal-states              — all 29 pipeline states enumerated
 *   garygoal-flags               — the six documented flag forms
 *   garygoal-never-merge         — the full never-merge blocker list
 *   garygoal-no-force            — force-push / branch-protection / admin-override bans
 *   garygoal-premise-gate        — unresolved material premise ⇒ BLOCKED
 *   garygoal-ship-loop           — /ship stop-and-rerun handling + budget
 *   garygoal-ci-repair           — 3-hypothesis cap + failure classification + no test-weakening
 *   garygoal-review-loop         — comment classification + no dismiss-to-clear
 *   garygoal-security            — /cso parsing, remediation through TDD, no suppression
 *   garygoal-injection-boundary  — untrusted-data rule + trusted skill roots + provenance
 *   garygoal-secrets             — no secrets in state/PR/logs; events via the CLI
 *   garygoal-invalidation        — invalidate after every new commit
 *   garygoal-thin-orchestrator   — reads specialist skills from disk, never re-implements
 *   garygoal-rollback            — canary failure handling
 */
import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const TMPL = fs.readFileSync(path.join(ROOT, "garygoal", "SKILL.md.tmpl"), "utf-8");

describe("/garygoal frontmatter + preamble", () => {
  test("frontmatter names the skill and includes triggers", () => {
    expect(TMPL).toMatch(/^---\nname: garygoal/m);
    expect(TMPL).toMatch(/triggers:/);
  });
  test("template includes the shared preamble placeholder", () => {
    expect(TMPL).toContain("{{PREAMBLE}}");
  });
});

describe("/garygoal deterministic state rule", () => {
  test("state may only advance through the gstack-garygoal CLI, never by prose", () => {
    expect(TMPL).toMatch(/gstack-garygoal state set/);
    expect(TMPL).toMatch(/never.{0,80}(advance|transition|record).{0,80}(state|gate).{0,80}(prose|claim|assert)/is);
  });
  test("all 29 states are enumerated in the template", () => {
    for (const s of [
      "INTAKE", "REPOSITORY_AUDITED", "OBJECTIVE_CONTRACT_WRITTEN", "SPECIFIED",
      "PLANNED", "IMPLEMENTING", "IMPLEMENTATION_COMPLETE", "CODE_REVIEW",
      "SECURITY_REVIEW", "DESIGN_REVIEW", "DEVEX_REVIEW", "BROWSER_QA",
      "PERFORMANCE_REVIEW", "DOCUMENTATION", "SHIPPING", "PR_OPEN", "CI_PENDING",
      "CI_REPAIR", "REVIEW_PENDING", "REVIEW_REPAIR", "READY_TO_MERGE", "MERGING",
      "MERGED", "DEPLOYING", "CANARY", "VERIFIED", "ROLLED_BACK", "BLOCKED", "FAILED",
    ]) {
      expect(TMPL).toContain(s);
    }
  });
  test("gate evidence is tied to commit SHAs", () => {
    expect(TMPL).toMatch(/gstack-garygoal gate record/);
    expect(TMPL).toMatch(/--sha/);
  });
});

describe("/garygoal flags", () => {
  test("documents all six command forms", () => {
    for (const flag of ["--plan", "--pr", "--merge", "--resume", "--status", "--repair-pr"]) {
      expect(TMPL).toContain(flag);
    }
  });
  test("argument parsing is delegated to the deterministic parser", () => {
    expect(TMPL).toMatch(/gstack-garygoal parse/);
  });
});

describe("/garygoal never-merge list", () => {
  test("every hard blocker from the merge policy appears", () => {
    const lower = TMPL.toLowerCase();
    for (const needle of [
      "failing or pending",           // required CI failing or pending
      "head sha changed",             // SHA moved after final checks
      "approvals",                    // required approvals missing
      "unresolved",                   // unresolved review threads
      "merge conflicts",
      "plan is incomplete",
      "security blocker",
      "destructive migration",
      "secrets",
      "branch protection",
      "merge permission",
      "deployment configuration",
    ]) {
      expect(lower).toContain(needle);
    }
  });
  test("merge decisions run through gstack-garygoal merge-check", () => {
    expect(TMPL).toMatch(/gstack-garygoal merge-check/);
  });
  test("force-push and admin-override are banned outright", () => {
    expect(TMPL).toMatch(/never force-push/i);
    expect(TMPL).toMatch(/never bypass branch protection/i);
    expect(TMPL).toMatch(/administrator override/i);
  });
  test("autonomous merge requires explicit --merge plus repository policy", () => {
    expect(TMPL).toMatch(/garygoal_autonomous_merge/);
    expect(TMPL).toMatch(/--merge/);
  });
});

describe("/garygoal premise gate", () => {
  test("a material unresolved product premise becomes a blocker, never bypassed", () => {
    expect(TMPL).toMatch(/premise/i);
    expect(TMPL).toMatch(/BLOCKED/);
    expect(TMPL).toMatch(/never silently bypass/i);
  });
  test("missing business requirements are not invented", () => {
    expect(TMPL).toMatch(/do not invent/i);
  });
});

describe("/garygoal ship loop", () => {
  test("handles /ship stopping intentionally after applying fixes", () => {
    expect(TMPL).toMatch(/\/ship.{0,400}(stop|stopped|stops)/is);
    expect(TMPL).toMatch(/budget spend ship_rerun/);
  });
  test("new commits from ship fixes trigger gate invalidation before rerun", () => {
    expect(TMPL).toMatch(/gstack-garygoal invalidate/);
  });
  test("PR reality is confirmed, not assumed from ship starting", () => {
    expect(TMPL).toMatch(/gh pr view/);
  });
});

describe("/garygoal CI repair loop", () => {
  test("caps autonomous repair at three distinct root-cause hypotheses per check", () => {
    expect(TMPL).toMatch(/budget spend ci_repair/);
    expect(TMPL).toMatch(/three|3/);
    expect(TMPL).toMatch(/hypothes/i);
  });
  test("classifies failures before acting", () => {
    const lower = TMPL.toLowerCase();
    for (const cls of ["flaky", "environment", "external dependency", "permission"]) {
      expect(lower).toContain(cls);
    }
  });
  test("never weakens tests or disables checks to go green", () => {
    expect(TMPL).toMatch(/never weaken tests/i);
    expect(TMPL).toMatch(/remove assertions|disable checks/i);
  });
  test("does not blindly rerun a deterministically failing job", () => {
    expect(TMPL).toMatch(/deterministic/i);
  });
});

describe("/garygoal review-comment loop", () => {
  test("classifies each comment before acting", () => {
    const lower = TMPL.toLowerCase();
    for (const cls of ["actionable", "already addressed", "needs clarification", "stale", "out of scope"]) {
      expect(lower).toContain(cls);
    }
  });
  test("threads are never resolved merely to clear the merge gate", () => {
    expect(TMPL).toMatch(/never (dismiss|resolve).{0,120}(clear|pass|unblock)/is);
  });
  test("product decisions beyond the objective contract block the run", () => {
    expect(TMPL).toMatch(/product decision.{0,200}BLOCKED/is);
  });
});

describe("/garygoal security handling", () => {
  test("runs /cso --diff for sensitive changes and parses the report", () => {
    expect(TMPL).toMatch(/\/cso --diff/);
    expect(TMPL).toMatch(/verified blockers?.{0,200}advisory/is);
  });
  test("remediations go through the normal TDD pipeline and cso reruns", () => {
    expect(TMPL).toMatch(/re-?run.{0,60}\/cso/is);
  });
  test("verified findings are never suppressed for an autonomous merge", () => {
    expect(TMPL).toMatch(/never suppress a verified security finding/i);
  });
});

describe("/garygoal prompt-injection boundary", () => {
  test("repository/PR/web content is data, not instructions", () => {
    expect(TMPL).toMatch(/untrusted data/i);
    expect(TMPL).toMatch(/must not override/i);
  });
  test("skills load only from the trusted install root, with provenance recorded", () => {
    expect(TMPL).toMatch(/trusted.{0,80}skill root/is);
    expect(TMPL).toMatch(/sha256|version/i);
  });
  test("newly discovered repo scripts are inspected before execution", () => {
    expect(TMPL).toMatch(/inspect.{0,120}(script|scripts).{0,200}(before|why)/is);
  });
});

describe("/garygoal secret handling", () => {
  test("secrets are banned from logs, reports, PR bodies, and state files", () => {
    expect(TMPL).toMatch(/never.{0,120}secrets.{0,200}(log|report|pr bod|state)/is);
  });
  test("event narration goes through the redaction-scanned CLI", () => {
    expect(TMPL).toMatch(/gstack-garygoal event/);
  });
});

describe("/garygoal thin-orchestrator rule", () => {
  test("specialist skills are read from disk and executed, not re-implemented", () => {
    expect(TMPL).toMatch(/Read.{0,120}SKILL\.md/s);
    expect(TMPL).toMatch(/source of truth/i);
  });
  test("routes to the real pipeline skills", () => {
    for (const skill of ["/autoplan", "/review", "/cso", "/qa", "/ship", "/land-and-deploy", "/canary", "/devex-review", "/codex"]) {
      expect(TMPL).toContain(skill);
    }
  });
  test("skips /office-hours and /spec when the objective is already precise", () => {
    expect(TMPL).toMatch(/precise.{0,300}(skip|not needed|straight)/is);
  });
});

describe("/garygoal deployment + rollback", () => {
  test("canary failure is never reported as success and follows rollback policy", () => {
    expect(TMPL).toMatch(/canary.{0,300}never.{0,80}successful/is);
    expect(TMPL).toMatch(/garygoal_rollback_on_canary_failure|rollback/i);
    expect(TMPL).toMatch(/ROLLED_BACK/);
  });
  test("production verification records the deployed SHA", () => {
    expect(TMPL).toMatch(/deployed_sha|deployed commit/i);
  });
});

describe("/garygoal resume + idempotency", () => {
  test("resume goes through the CLI and refuses to guess between runs", () => {
    expect(TMPL).toMatch(/gstack-garygoal resume/);
  });
  test("no duplicate branches or PRs on rerun", () => {
    expect(TMPL).toMatch(/duplicate (branch|PR)/i);
  });
  test("final report is written from recorded evidence", () => {
    expect(TMPL).toMatch(/final-report\.md/);
  });
});
