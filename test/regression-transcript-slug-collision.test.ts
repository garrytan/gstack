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
});
