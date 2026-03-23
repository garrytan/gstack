import { describe, test, expect, beforeEach } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const scriptPath = join(import.meta.dir, "..", "bin", "gstack-meditate.ts");
const repoRoot = join(import.meta.dir, "..");

// Dynamic import for unit-testable functions
let deriveSlug: (repoPath: string) => string;
let scanRepoStructure: (repoPath: string, maxDepth?: number) => Record<string, string[]>;
let detectLanguages: (repoPath: string) => { languages: string[]; framework: string };
let scanTodos: (repoPath: string, limit?: number) => { file: string; line: number; text: string }[];
let mapTestCoverage: (repoPath: string) => Record<string, string>;
let extractDocs: (repoPath: string) => { claude_md: string; todos_md: string; readme_md: string };
let templateSynthesize: (snapshot: any) => string;

beforeEach(async () => {
  const mod = await import("../bin/gstack-meditate.ts");
  deriveSlug = mod.deriveSlug;
  scanRepoStructure = mod.scanRepoStructure;
  detectLanguages = mod.detectLanguages;
  scanTodos = mod.scanTodos;
  mapTestCoverage = mod.mapTestCoverage;
  extractDocs = mod.extractDocs;
  templateSynthesize = mod.templateSynthesize;
});

describe("gstack-meditate", () => {
  test("--help exits 0 and prints usage", () => {
    const result = spawnSync("bun", ["run", scriptPath, "--help"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("--repo");
    expect(result.stderr).toContain("--background");
  });

  test("deriveSlug returns valid slug for this repo", () => {
    const slug = deriveSlug(repoRoot);
    expect(slug).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(slug.length).toBeGreaterThan(0);
  });

  test("scanRepoStructure returns non-empty structure", () => {
    const structure = scanRepoStructure(repoRoot, 2);
    expect(Object.keys(structure).length).toBeGreaterThan(0);
    // Root should have entries
    expect(structure["."]).toBeDefined();
    expect(structure["."].length).toBeGreaterThan(0);
  });

  test("scanRepoStructure respects depth limit", () => {
    const shallow = scanRepoStructure(repoRoot, 1);
    const deep = scanRepoStructure(repoRoot, 3);
    expect(Object.keys(deep).length).toBeGreaterThanOrEqual(Object.keys(shallow).length);
  });

  test("detectLanguages finds typescript and bash in this repo", () => {
    const { languages, framework } = detectLanguages(repoRoot);
    expect(languages).toContain("typescript");
    expect(framework).toBe("bun");
  });

  test("scanTodos finds TODOs in this repo", () => {
    const todos = scanTodos(repoRoot, 10);
    // This repo has TODOs in TODOS.md at minimum
    expect(todos.length).toBeGreaterThan(0);
    expect(todos[0]).toHaveProperty("file");
    expect(todos[0]).toHaveProperty("line");
    expect(todos[0]).toHaveProperty("text");
  });

  test("extractDocs reads CLAUDE.md from this repo", () => {
    const docs = extractDocs(repoRoot);
    expect(docs.claude_md.length).toBeGreaterThan(0);
    expect(docs.claude_md).toContain("gstack");
  });

  test("templateSynthesize produces output under 1024 lines", () => {
    const snapshot = {
      version: 1,
      timestamp: new Date().toISOString(),
      duration_ms: 1000,
      repo: {
        slug: "test-repo",
        remote: "https://github.com/test/repo",
        languages: ["typescript"],
        framework: "bun",
        structure: { ".": ["src/", "test/", "package.json"] },
        file_count: 50,
        test_coverage_map: { "src/index.ts": "test/index.test.ts" },
      },
      activity: {
        commits_30d: 10,
        contributors: ["dev1"],
        hotspots: ["src/main.ts", "src/utils.ts"],
        cold_spots: ["src/legacy.ts"],
        todos: [{ file: "src/main.ts", line: 42, text: "TODO: refactor this" }],
      },
      conversations: {
        sessions_analyzed: 5,
        sessions_skipped: 0,
        by_tool: { claude_code: 3, codex: 1, gemini: 1 },
        most_referenced_files: ["src/main.ts"],
        recurring_errors: ["TypeError: undefined is not a function"],
        recurring_topics: ["refactoring", "testing"],
        workflow_patterns: ["/review", "/ship"],
      },
      docs: {
        claude_md: "# Project\nTest project",
        todos_md: "",
        readme_md: "# Test Repo",
      },
      partial: false,
    };

    const output = templateSynthesize(snapshot);
    const lines = output.split("\n");

    expect(lines.length).toBeLessThanOrEqual(1024);
    expect(output).toContain("# Repo Consciousness");
    expect(output).toContain("## Architecture Map");
    expect(output).toContain("## Hotspots");
    expect(output).toContain("## Conventions");
    expect(output).toContain("## User Taste");
    expect(output).toContain("## Recurring Problems");
    expect(output).toContain("## Watch These Next");
  });

  test("templateSynthesize includes all six sections", () => {
    const minimal = {
      version: 1, timestamp: new Date().toISOString(), duration_ms: 100,
      repo: { slug: "min", remote: "", languages: ["unknown"], framework: "unknown", structure: {}, file_count: 0, test_coverage_map: {} },
      activity: { commits_30d: 0, contributors: [], hotspots: [], cold_spots: [], todos: [] },
      conversations: { sessions_analyzed: 0, sessions_skipped: 0, by_tool: { claude_code: 0, codex: 0, gemini: 0 }, most_referenced_files: [], recurring_errors: [], recurring_topics: [], workflow_patterns: [] },
      docs: { claude_md: "", todos_md: "", readme_md: "" },
      partial: false,
    };

    const output = templateSynthesize(minimal);
    const sections = ["Architecture Map", "Hotspots", "Conventions", "User Taste", "Recurring Problems", "Watch These Next"];
    for (const section of sections) {
      expect(output).toContain(`## ${section}`);
    }
  });

  test("scanner runs on this repo and produces valid JSON", () => {
    const result = spawnSync("bun", ["run", scriptPath, "--repo", repoRoot, "--output", "/tmp/gstack-meditate-test.json"], {
      encoding: "utf-8",
      timeout: 30000,
    });
    expect(result.status).toBe(0);

    const stdout = result.stdout.trim();
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.slug).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(parsed.sessions).toHaveProperty("claude_code");
    expect(parsed.sessions).toHaveProperty("codex");
    expect(parsed.sessions).toHaveProperty("gemini");
  });
});
