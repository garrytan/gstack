import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

test("SKILL.md.tmpl contains TDD changes", () => {
  const tmplPath = path.resolve(import.meta.dir, "../../SKILL.md.tmpl");
  const content = fs.readFileSync(tmplPath, "utf-8");

  expect(content.includes('**Test Specification')).toBe(true);
  expect(content.includes('version: 1.21.2')).toBe(true);
  expect(content.includes('tests_red')).toBe(true);
  expect(content.includes('Test Specification (test-writer role)')).toBe(true);
  expect(content.includes('exactly this durable sub-checkbox structure')).toBe(true);
  expect(content.includes('*-gstack/inbox/living-plan')).toBe(true);
  expect(content.includes('--project-root "$repoPath"')).toBe(true);
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
  expect(content.includes('version: 1.21.2')).toBe(true);
  expect(content.includes('tests_red')).toBe(true);
  expect(content.includes('*-gstack/inbox/living-plan')).toBe(true);
  expect(content.includes('--project-root "$repoPath"')).toBe(true);
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

test("build skill docs route planLocator provider through kimi when configured", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../../../.agents/skills/gstack-build/SKILL.md"),
  ];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("_LOCATOR_PROVIDER");
    expect(content).toContain("kimi --work-dir");
    expect(content).toContain("gemini -p");
    expect(content).toContain("-m \"$_LOCATOR_MODEL\" --yolo");
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
    expect(content).toContain("This is the plan-file lookup; it must not be described as the sibling scan");
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
    expect(content).toContain('--project-root "$repoPath"');
    expect(content).toContain("Run `git log` and all verifier subagents from the child repo, never the workspace root");
    expect(content).toContain("build-final-exam-${repoSlug}-input.md");
    expect(content).toContain("Only exit when the active run is the last manifest entry");
    expect(content).toContain("waiting for next manifest run");
  }
});

test("build docs describe workspace-root and sequential multi-repo runs", () => {
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
    expect(content).toContain("sequential");
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
