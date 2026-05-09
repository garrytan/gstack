import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

test("SKILL.md.tmpl contains TDD changes", () => {
  const tmplPath = path.resolve(import.meta.dir, "../../SKILL.md.tmpl");
  const content = fs.readFileSync(tmplPath, "utf-8");

  expect(content.includes('**Test Specification')).toBe(true);
  expect(content.includes('version: 1.21.3')).toBe(true);
  expect(content.includes('tests_red')).toBe(true);
  expect(content.includes('Test Specification (test-writer role)')).toBe(true);
  expect(content.includes('exactly this durable sub-checkbox structure')).toBe(true);
  expect(content.includes('*-gstack/inbox/living-plan')).toBe(true);
  expect(content.includes('--project-root "$worktreePath"')).toBe(true);
  expect(content.includes('Archive Plans')).toBe(true);
  expect(content.includes('## Feature X: [Feature Name]')).toBe(true);
  expect(content.includes('Feature Verification')).toBe(true);
  expect(content.includes('Origin trace:')).toBe(true);
  expect(content.includes('Parallel Phase Planner (`--parallel-phases N`)')).toBe(true);
});

test("generated SKILL.md reflects TDD changes", () => {
  const skillPath = path.resolve(import.meta.dir, "../../SKILL.md");
  const content = fs.readFileSync(skillPath, "utf-8");

  expect(content.includes('**Test Specification')).toBe(true);
  expect(content.includes('version: 1.21.3')).toBe(true);
  expect(content.includes('tests_red')).toBe(true);
  expect(content.includes('*-gstack/inbox/living-plan')).toBe(true);
  expect(content.includes('--project-root "$worktreePath"')).toBe(true);
  expect(content.includes('## Feature X: [Feature Name]')).toBe(true);
  expect(content.includes('Feature Verification')).toBe(true);
  expect(content.includes('Origin trace:')).toBe(true);
  expect(content.includes('Parallel Phase Planner (`--parallel-phases N`)')).toBe(true);
});

test("build docs define TDD as Test Specification, Verify Red, Implementation, Green tests, Review/QA", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
    path.resolve(import.meta.dir, "../../README.md"),
    path.resolve(import.meta.dir, "../README.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("Test Specification");
    expect(content).toContain("Verify Red");
    expect(content).toContain("Implementation");
    expect(content).toContain("Green tests");
    expect(content).toContain("Review/QA");
  }

  for (const file of files.slice(0, 3)) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("Verify Red and Green tests are CLI-owned gates");
    expect(content).toContain("additional markdown checkboxes");
  }
});

test("build skill and CLI do not hardcode default model names", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../cli.ts"),
  ];
  const forbidden = /(claude-opus|gemini-\d|gpt-\d|Claude Opus|Gemini 3|Codex GPT|Opus|Sonnet|--model sonnet)/;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).not.toMatch(forbidden);
  }
  expect(fs.readFileSync(files[0], "utf-8")).toContain("configure.cm");
  expect(fs.readFileSync(files[1], "utf-8")).toContain("configure.cm");
});

test("build skill docs resolve gstack-build through _GSTACK_BUILD_CLI", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("_GSTACK_BUILD_CLI");
    expect(content).toContain("command -v gstack-build");
    expect(content).toContain('"$_GSTACK_BUILD_CLI" "$livingPlanPath"');
    expect(content).not.toContain('\ngstack-build "$_PLAN_FILE"');
    expect(content).not.toContain(
      'GSTACK_BUILD_GEMINI_TIMEOUT=1200000 gstack-build "$_PLAN_FILE"',
    );
  }
});

test("build skill keeps context-save owned by the host build session", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).not.toContain("--skip-context-save");
    expect(content).toContain("Host-session context save");
    expect(content).toContain("HOST_CONTEXT_SAVE_REQUIRED");
    expect(content).toContain("Codex must invoke `/context-save`");
    expect(content).toContain("Claude must invoke `/context-save`");
    expect(content).toContain("Do not route this through");
    expect(content).toContain("never a configured build role");
    expect(content).toContain("final JSON line is `HOST_CONTEXT_SAVE_REQUIRED`");
    expect(content).toContain("emitted `committed` value to the emitted `countFile`");
    expect(content).not.toContain('echo "$_COMMITTED_COUNT" > "$_HOST_CONTEXT_SAVE_COUNT_FILE"');
  }
});

test("build skill documents CLI-backed merge mode", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("/build merge");
    expect(content).toContain("gstack-build merge");
    expect(content).toContain("review/fix/ship/land");
  }
});

test("build skill launch examples do not advertise --skip-ship", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain('_FLAGS=""');
    expect(content).not.toMatch(/_FLAGS=.*--skip-ship/);
    expect(content).toContain("Never add --skip-ship unless");
  }
});

test("build skill docs route plan lookup through plan-status", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("gstack-build plan-status --gstack-repo");
    expect(content).toContain("--plan \"$_EXPLICIT_PLAN_ABS\" --json");
    expect(content).toContain("--all-inbox --json");
    expect(content).toContain("single source of truth");
    expect(content).not.toContain("_LOCATOR_PROVIDER");
    expect(content).not.toContain("pick the newest file by mtime");
  }
});

test("build skill docs distinguish storage discovery from plan discovery", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("This chooses plan storage only");
    expect(content).toContain("it does not choose a plan file or target repo");
    expect(content).toContain("single source of truth");
  }
});

test("build skill docs use explicit source plan paths through resolver", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("Explicit Markdown paths");
    expect(content).toContain("_USED_EXPLICIT_PLAN");
    expect(content).toContain("_EXPLICIT_SOURCE_PLAN_PATHS");
    expect(content).not.toContain("_EXPLICIT_PLAN_PATH=");
    expect(content).toContain("build-selected-source-plans.json");
    expect(content).toContain("resolver-provided canonical `claimPath`");
    expect(content).toContain("Multiple source plans");
    expect(content).not.toContain("build-plan-locate-output.md");
  }
});

test("build skill docs support workspace-root repo routing", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("Workspace-root mode");
    expect(content).toContain("Ignore the workspace root git repo by default");
    expect(content).toContain("workspace-level `*-gstack/inbox/`");
    expect(content).toContain("split it into one living plan per target repo");
    expect(content).toContain('"repoPath"');
    expect(content).toContain('"livingPlanPath"');
    expect(content).toContain('--project-root "$worktreePath"');
    expect(content).toContain("Run `git log` and all verifier subagents from the child repo, never the workspace root");
    expect(content).toContain("build-final-exam-${repoSlug}-input.md");
    expect(content).toContain("all manifest runs");
    expect(content).toContain("launch all manifest runs concurrently");
  }
});

test("build skill docs describe safe parallel manifest v2 runs", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("manifest v2");
    expect(content).toContain(".llm-tmp/build-runs/<runGroupId>");
    expect(content).toContain("--all-inbox");
    expect(content).toContain("_ALL_INBOX_REQUESTED");
    expect(content).toContain("$GSTACK_REPO/inbox/.claims");
    expect(content).toContain("set -C");
    expect(content).toContain("runGroupId");
    expect(content).toContain("runIds");
    expect(content).toContain("no global `build-active-run-index`");
    expect(content).toContain("--run-id \"$runId\"");
    expect(content).toContain("--base-project-root \"$repoPath\"");
    expect(content).toContain("--branch-prefix \"$branchPrefix\"");
    expect(content).toContain("active-runs");
    expect(content).toContain("refs/remotes/origin/HEAD");
    expect(content).toContain("_VERIFY_BASE_REF");
    expect(content).toContain("_FINAL_BASE_REF");
    expect(content).toContain('git log --oneline "$_FINAL_BASE_REF"');
    expect(content).toContain("Remote base ref:");
    expect(content).toContain('git -C "$worktreePath" rev-parse --is-inside-work-tree');
    expect(content).toContain("worktree path exists but is not a git worktree");
    expect(content).toContain('git worktree add -b "$_FIRST_BRANCH" "$worktreePath" "$_BASE_COMMIT"');
    expect(content).not.toContain('-d "$worktreePath/.git"');
    expect(content).not.toContain("sed 's#^origin/##'");
    expect(content).toContain('status:"claimed"');
    expect(content).toContain('--arg status "manifested"');
    expect(content).toContain('--arg status "running"');
    expect(content).toContain("runStatuses");
    expect(content).toContain("top-level claim status terminal when all `runIds` are terminal");
    expect(content).toContain('git -C "$repoPath" worktree remove "$worktreePath"');
    expect(content).toContain("Failure paths preserve worktrees for debugging");
    expect(content).toContain("launchCommand");
    expect(content).toContain("launchEnv");
    expect(content).toContain("the next tool call must be Bash running Step M3");
    expect(content).toContain("polling is owned by the CLI monitor, not by host timer tools");
    expect(content).toContain("If the command blocks for a long time, that is expected behavior");
    expect(content).toContain("monitor --manifest \"$BUILD_RUN_MANIFEST\" --watch");
    expect(content).toContain("ALL_RUNS_COMPLETE");
    expect(content).toContain("MONITOR_REENTER");
    expect(content).toContain("USER_ACTION_REQUIRED");
    expect(content).not.toContain("ScheduleWakeup");
    expect(content).toContain('--arg status "cancelled"');
    expect(content).toContain("pidFiles");
    expect(content).toContain("stdoutLogs");
    expect(content).toContain("missing canonical claimPath");
    expect(content).toContain("source plan already claimed after selection");
    expect(content).not.toContain('[ -e "$_CLAIM_PATH" ] && continue');
    expect(content).toContain(
      "Manifest paths must be concrete absolute paths.",
    );
    expect(content).toContain('do not emit literal');
    expect(content).toContain(
      '"worktreePath": "<expanded home directory>/.gstack/build-worktrees/<repoSlug>/<runId>"',
    );
    expect(content).not.toContain(
      '"worktreePath": "~/.gstack/build-worktrees/<repoSlug>/<runId>"',
    );
    expect(content).not.toContain(
      '"worktreePath": "<absolute $HOME>/.gstack/build-worktrees/<repoSlug>/<runId>"',
    );
    expect(content).toContain('case "$worktreePath" in');
    expect(content).toContain('"~/"*) worktreePath="$HOME/${worktreePath:2}"');
    expect(content).toContain(
      '"\\$HOME/"*) worktreePath="$HOME/${worktreePath:6}"',
    );
    expect(content).toContain(
      '"\\${HOME}/"*) worktreePath="$HOME/${worktreePath:8}"',
    );
    expect(content).toContain('--arg worktreePath "$worktreePath"');
    expect(content).toContain(
      "{worktreePath:$worktreePath,launchCommand:$launchCommand,launchEnv:$launchEnv}",
    );
  }
});

test("build READMEs describe manifest worktree launch instead of stale sequential launch", () => {
  const files = [
    path.resolve(import.meta.dir, "../../README.md"),
    path.resolve(import.meta.dir, "../README.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/README.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/orchestrator/README.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).not.toContain("launch `gstack-build` sequentially");
    expect(content).not.toContain("invokes this CLI sequentially");
    expect(content).not.toContain("Multi-repo plans run sequentially");
  }
  expect(fs.readFileSync(files[0], "utf-8")).toContain("launch all manifest runs");
  expect(fs.readFileSync(files[1], "utf-8")).toContain("private git worktrees");
});

test("build skill docs describe manual recovery and submodule fail-closed boundaries", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("--mark-phase-committed <phase>");
    expect(content).toContain("--allow-submodule-recovery <submodule-path>");
    expect(content).toContain("fails closed by default");
    expect(content).toContain("stages only the submodule gitlink");
    expect(content).toContain("do not use `--reset-phase` when the phase artifacts are already valid");
  }
});

test("source-plan claim aggregation jq keeps the claim root while iterating run ids", () => {
  const jqProgram = `
    .runStatuses = (.runStatuses // {}) |
    .runStatuses[$runId] = ({status:$runStatus,updatedAt:$updatedAt} + {($timeField):$updatedAt}) |
    . as $claim |
    .status =
      if ($claim.runIds | type) != "array" or ($claim.runIds | length) == 0 then $runStatus
      elif all($claim.runIds[]; ($claim.runStatuses[.]?.status // "") == "completed") then "completed"
      elif all($claim.runIds[]; (($claim.runStatuses[.]?.status // "") | IN("completed","failed"))) and any($claim.runIds[]; ($claim.runStatuses[.]?.status // "") == "failed") then "failed"
      else "running"
      end |
    .updatedAt = $updatedAt |
    if .status == "completed" then .completedAt = $updatedAt
    elif .status == "failed" then .failedAt = $updatedAt
    else del(.completedAt, .failedAt)
    end
  `;

  const result = spawnSync(
    "jq",
    [
      "--arg",
      "runId",
      "run-a",
      "--arg",
      "runStatus",
      "completed",
      "--arg",
      "updatedAt",
      "2026-05-08T00:00:00Z",
      "--arg",
      "timeField",
      "completedAt",
      jqProgram,
    ],
    {
      input: JSON.stringify({
        status: "running",
        runIds: ["run-a", "run-b"],
        runStatuses: {
          "run-b": {
            status: "running",
            updatedAt: "2026-05-08T00:00:00Z",
          },
        },
      }),
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  const claim = JSON.parse(result.stdout);
  expect(claim.status).toBe("running");
  expect(claim.runStatuses["run-a"].status).toBe("completed");
});

test("build docs describe workspace-root and manifest multi-repo runs", () => {
  const files = [
    path.resolve(import.meta.dir, "../../README.md"),
    path.resolve(import.meta.dir, "../README.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("workspace root");
    expect(content).toContain("child repos");
    expect(content).toContain("root repo");
    expect(content).toContain("one living plan per target repo");
    expect(content).toContain("manifest");
  }
});

test("build skill docs route template-only roles by provider", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("_SYNTH_PROVIDER");
    expect(content).toContain("_VERIFIER_PROVIDER");
    expect(content).toContain("unsupported planSynthesizer provider");
    expect(content).toContain("unsupported featureVerifier provider");
    expect(content).toContain("codex exec");
    expect(content).toContain("-c \"model_reasoning_effort=\\\"");
    expect(content).toContain('case "$_SYNTH_PROVIDER" in');
    expect(content).toContain('case "$_VERIFIER_PROVIDER" in');
    expect(content).not.toContain("Spawn (model read from configure.cm `planSynthesizer` role)");
    expect(content).not.toContain("Spawn (model read from configure.cm `featureVerifier` role)");
    expect(content).not.toContain("Claude subagent");
    expect(content).not.toContain('claude -p "Read .llm-tmp/build-reexamine-feature');
  }
});

test("bin/gstack-build wrapper prints CLI help", () => {
  const wrapperPath = path.resolve(import.meta.dir, "../../../bin/gstack-build");
  const result = spawnSync(wrapperPath, ["--help"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    encoding: "utf8",
    timeout: 30_000,
  });
  const out = result.stdout + result.stderr;

  expect(result.status).toBe(0);
  expect(out).toContain("gstack-build — code-driven phase orchestrator");
  expect(out).toContain("Usage:");
  expect(out).toContain("--dry-run");
});
