/**
 * Regression: disambiguateSlugs resolves colliding staged slugs.
 *
 * Two source files can map to one path-derived transcript slug (a session
 * resumed under the same id on one day, or two session ids sharing a 12-char
 * prefix). writeStaged() names each file `${slug}.md`, so the second overwrote
 * the first; gbrain then collected N-1 of N staged files and the
 * staged-vs-collected reconciliation guard failed the whole batch every run
 * ("accounted for N-1 of N staged ... Refusing to advance state").
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { disambiguateSlugs } from "../bin/gstack-memory-ingest";

const mk = (slug: string, source_path: string) => ({
  slug,
  source_path,
  rendered_body: "---\ntitle: x\n---\n\nbody",
  page_slug: slug,
  partial: false,
  type: "transcript" as const,
  git_remote: undefined,
});

describe("regression: disambiguateSlugs resolves colliding staged slugs", () => {
  it("keeps the first occurrence and suffixes later colliders deterministically", () => {
    const slug = "transcripts/claude-code/repo/2026-08-25-abc123def456";
    const run = () => {
      const pages = [mk(slug, "/a.jsonl"), mk(slug, "/b.jsonl")];
      disambiguateSlugs(pages);
      return pages;
    };
    const pages = run();
    // First keeps the clean slug; second is disambiguated.
    expect(pages[0].slug).toBe(slug);
    expect(pages[1].slug).not.toBe(slug);
    expect(pages[1].slug.startsWith(slug + "-")).toBe(true);
    // slug and page_slug move together (downstream consumers must agree).
    expect(pages[1].page_slug).toBe(pages[1].slug);
    // Deterministic across runs (same source path → same suffix).
    expect(run()[1].slug).toBe(pages[1].slug);
  });

  it("gives every member of a 3-way collision a distinct slug", () => {
    const slug = "transcripts/codex/repo/2026-08-25-deadbeefcafe";
    const pages = [
      mk(slug, "/one.jsonl"),
      mk(slug, "/two.jsonl"),
      mk(slug, "/three.jsonl"),
    ];
    disambiguateSlugs(pages);
    const slugs = new Set(pages.map((p) => p.slug));
    expect(slugs.size).toBe(3);
    expect(pages[0].slug).toBe(slug);
  });

  it("leaves non-colliding slugs untouched", () => {
    const pages = [
      mk("transcripts/a/repo/2026-08-25-1111", "/x.jsonl"),
      mk("transcripts/b/repo/2026-08-25-2222", "/y.jsonl"),
    ];
    const before = pages.map((p) => p.slug);
    disambiguateSlugs(pages);
    expect(pages.map((p) => p.slug)).toEqual(before);
  });

  it("state consult: a source keeps its recorded suffixed slug when its old collider is absent", () => {
    // Run 1 assigned A the bare slug and B the suffix; run 2 sees only B
    // (A unchanged or gone). Without the consult B would flip to bare and
    // gbrain would hold the same transcript under two slugs.
    const slug = "transcripts/claude-code/repo/2026-08-25-abc123def456";
    const state = {
      sessions: {
        "/a.jsonl": { page_slug: slug },
        "/b.jsonl": { page_slug: `${slug}-cafe0123` },
      },
    };
    const pages = [mk(slug, "/b.jsonl")];
    disambiguateSlugs(pages, state);
    expect(pages[0].slug).toBe(`${slug}-cafe0123`);
    expect(pages[0].page_slug).toBe(pages[0].slug);
  });

  it("state consult: a new source never takes a bare slug owned by an unchanged source", () => {
    // A owns the bare slug from a prior run but is NOT restaged this run;
    // new collider C must suffix, not silently overwrite A's page in gbrain.
    const slug = "transcripts/claude-code/repo/2026-08-25-abc123def456";
    const state = { sessions: { "/a.jsonl": { page_slug: slug } } };
    const pages = [mk(slug, "/c.jsonl")];
    disambiguateSlugs(pages, state);
    expect(pages[0].slug).not.toBe(slug);
    expect(pages[0].slug.startsWith(slug + "-")).toBe(true);
  });

  it("state consult: legacy duplicate records resolve first-owner-wins and self-heal", () => {
    // Pre-#2724 states could record the SAME bare slug for two sources.
    // The first owner in state order keeps it; the other gets a stable
    // suffix — after this run the state records distinct slugs.
    const slug = "transcripts/codex/repo/2026-08-25-deadbeefcafe";
    const state = {
      sessions: {
        "/first.jsonl": { page_slug: slug },
        "/second.jsonl": { page_slug: slug },
      },
    };
    const pages = [mk(slug, "/first.jsonl"), mk(slug, "/second.jsonl")];
    disambiguateSlugs(pages, state);
    expect(pages[0].slug).toBe(slug);
    expect(pages[1].slug).not.toBe(slug);
    expect(pages[1].slug.startsWith(slug + "-")).toBe(true);
  });

  it("state consult: no state (or empty sessions) behaves exactly like the stateless algorithm", () => {
    const slug = "transcripts/claude-code/repo/2026-08-25-abc123def456";
    const a = [mk(slug, "/a.jsonl"), mk(slug, "/b.jsonl")];
    const b = [mk(slug, "/a.jsonl"), mk(slug, "/b.jsonl")];
    disambiguateSlugs(a);
    disambiguateSlugs(b, { sessions: {} });
    expect(b.map((p) => p.slug)).toEqual(a.map((p) => p.slug));
  });

  it("call-site wiring: the prepare/stage flow actually invokes disambiguateSlugs (source pin)", () => {
    // The unit tests above prove the function works; nothing else proves the
    // flow CALLS it — a refactor could drop the invocation and every test
    // would stay green while #2724 regresses. Anchor narrowly: extract the
    // preparePages function body (and, as an accepted alternate home, the
    // main-flow stretch between the preparePages call and writeStaged) and
    // require a disambiguateSlugs( invocation inside — cosmetic changes
    // (argument rename, comment edits) don't trip this; moving the call out
    // of the prepare→stage flow entirely does.
    const src = readFileSync(
      join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts"),
      "utf-8",
    );

    // preparePages body: from its declaration to the next top-level function.
    const defStart = src.indexOf("function preparePages(");
    expect(defStart).toBeGreaterThan(-1);
    const afterDef = src.slice(defStart + "function preparePages(".length);
    const endRel = afterDef.search(/\n(?:export )?(?:async )?function /);
    const prepareBody = endRel === -1 ? afterDef : afterDef.slice(0, endRel);

    // Alternate home: the stage flow between the preparePages call site and
    // the writeStaged call that consumes its output.
    const callSite = src.indexOf("= preparePages(");
    const stageSite = callSite === -1 ? -1 : src.indexOf("writeStaged(", callSite);
    const stageFlow =
      callSite !== -1 && stageSite !== -1 ? src.slice(callSite, stageSite) : "";

    const invokes = (text: string) =>
      // An invocation, not the `function disambiguateSlugs(` definition.
      /(?<!function )\bdisambiguateSlugs\(/.test(text);

    expect(invokes(prepareBody) || invokes(stageFlow)).toBe(true);
  });
});
