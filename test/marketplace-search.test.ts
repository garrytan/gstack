import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { extractKeywords, parseMarketplaceOutput, rankSkills } from "../bin/gstack-marketplace-search.ts";

const scriptPath = join(import.meta.dir, "..", "bin", "gstack-marketplace-search.ts");

describe("gstack-marketplace-search", () => {
  test("extractKeywords finds common platform terms", () => {
    const keywords = extractKeywords("Build a Next.js app on Vercel with Supabase auth and GitHub CLI deploy scripts");
    expect(keywords).toContain("nextjs");
    expect(keywords).toContain("vercel");
    expect(keywords).toContain("supabase");
    expect(keywords).toContain("github cli");
  });

  test("parseMarketplaceOutput strips prelude noise before JSON", () => {
    const raw = `- Searching marketplace...\n{\"skills\":[{\"name\":\"supabase\",\"author\":\"supabase\",\"description\":\"Use Supabase\",\"stars\":100,\"forks\":10,\"githubUrl\":\"https://github.com/supabase/agent-skills/tree/main/skills/supabase\",\"scopedName\":\"@supabase/supabase\"}]}`;
    const skills = parseMarketplaceOutput(raw);
    expect(skills).toHaveLength(1);
    expect(skills[0].scopedName).toBe("@supabase/supabase");
  });

  test("rankSkills dedupes duplicate scoped names and prefers exact matches", () => {
    const ranked = rankSkills([
      {
        name: "supabase",
        description: "Supabase auth and database",
        author: "supabase",
        stars: 100,
        forks: 10,
        githubUrl: "https://github.com/supabase/agent-skills/tree/main/skills/supabase",
        scopedName: "@supabase/supabase",
        query: { text: "supabase", source: "keyword" as const },
      },
      {
        name: "postgres-patterns",
        description: "Postgres optimization",
        author: "someone",
        stars: 1000,
        forks: 10,
        githubUrl: "https://github.com/someone/postgres-patterns",
        scopedName: "@someone/postgres-patterns",
        query: { text: "supabase", source: "full" as const },
      },
      {
        name: "supabase",
        description: "Duplicate entry",
        author: "supabase",
        stars: 90,
        forks: 9,
        githubUrl: "https://github.com/supabase/agent-skills/tree/main/skills/supabase",
        scopedName: "@supabase/supabase",
        query: { text: "vercel", source: "keyword" as const },
      },
    ], ["supabase", "vercel"], 5);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].scopedName).toBe("@supabase/supabase");
    expect(ranked[0].sourceQueries).toContain("supabase");
    expect(ranked[0].matchedKeywords).toContain("supabase");
  });

  test("CLI mode returns normalized JSON from fixture input", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gstack-marketplace-"));
    const fixture = join(tempDir, "fixture.json");
    writeFileSync(fixture, `- Searching marketplace...\n${JSON.stringify({
      skills: [
        {
          name: "nextjs-supabase-auth",
          description: "Expert integration of Supabase Auth with Next.js",
          author: "sickn33",
          stars: 200,
          forks: 50,
          githubUrl: "https://github.com/sickn33/antigravity-awesome-skills/tree/main/skills/nextjs-supabase-auth",
          scopedName: "@sickn33/nextjs-supabase-auth",
        },
        {
          name: "vercel-deploy",
          description: "Deploy apps to Vercel",
          author: "vercel",
          stars: 150,
          forks: 20,
          githubUrl: "https://github.com/vercel/skills/tree/main/skills/vercel-deploy",
          scopedName: "@vercel/vercel-deploy",
        },
      ],
    })}`);

    const result = spawnSync("bun", [
      "run",
      scriptPath,
      "--query",
      "Build a Next.js app on Vercel with Supabase auth",
      "--keyword",
      "nextjs",
      "--keyword",
      "vercel",
      "--keyword",
      "supabase",
      "--json",
    ], {
      env: { ...process.env, GSTACK_MARKETPLACE_FIXTURE: fixture },
      encoding: "utf-8",
      timeout: 10000,
    });

    rmSync(tempDir, { recursive: true, force: true });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.status).toBe("ok");
    expect(json.results.length).toBeGreaterThan(0);
    expect(json.results[0]).toHaveProperty("installCommand");
  });
});
