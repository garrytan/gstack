/**
 * Regression: transcript frontmatter fence must terminate its own line.
 *
 * buildTranscriptPage() emitted a closing `---` with no trailing newline, and
 * session bodies always start with "## ", so the rendered page ended
 * `...---## User`. gbrain's frontmatter matcher
 * (`/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/`, src/core/markdown.ts) requires the
 * closing `---` to end its own line, so it skipped the glued fence, latched onto
 * the next standalone `---` in the transcript body, parsed the prose between as
 * YAML, and dropped the whole page with "Invalid YAML frontmatter". Transcripts
 * with no later `---` fell back to body-only (frontmatter silently lost).
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseTranscriptJsonl,
  buildTranscriptPage,
  renderPageBody,
} from "../bin/gstack-memory-ingest";

// The exact fence matcher gbrain uses (src/core/markdown.ts). Kept here so the
// test fails if the rendered fence ever regresses.
const GBRAIN_FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

describe("regression: transcript frontmatter fence terminates its own line", () => {
  it("keeps a body-embedded `---` out of the frontmatter block", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-fence-"));
    const file = join(dir, "sess.jsonl");
    // User content carries a markdown horizontal rule (`---`) followed by a
    // colon-bearing line — exactly what the old glued fence swept into YAML.
    const content =
      `{"type":"user","message":{"role":"user","content":"before rule\\n\\n---\\n\\nnot: valid: yaml: here"},` +
      // JSON.stringify, not raw interpolation: a Windows tmpdir (D:\a\...)
      // pasted into hand-built JSON is an invalid escape, the user line gets
      // dropped, and the body starts at "## Assistant" (Windows CI red).
      `"timestamp":"2026-05-01T00:00:00Z","cwd":${JSON.stringify(dir)}}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":"ok"},"timestamp":"2026-05-01T00:00:01Z"}\n`;
    writeFileSync(file, content, "utf-8");

    const session = parseTranscriptJsonl(file);
    expect(session).not.toBeNull();
    const page = buildTranscriptPage(file, session!);
    const staged = renderPageBody(page);

    // The fence is never glued onto the body.
    expect(staged).not.toContain("---##");

    // gbrain's matcher closes the frontmatter at the real fence, not at the
    // horizontal rule deep in the transcript body.
    const m = staged.match(GBRAIN_FENCE_RE);
    expect(m).not.toBeNull();
    const frontmatter = m![1];
    expect(frontmatter).toContain("session_id:");
    expect(frontmatter).toContain("title:");
    // The body (headings, the HR, the colon-trap line) must NOT bleed into YAML.
    expect(frontmatter).not.toContain("## User");
    expect(frontmatter).not.toContain("not: valid: yaml: here");

    // And the parsed body (after the fence's trailing blank line) is the
    // session content, not YAML-absorbed prose.
    const body = staged.slice(m![0].length);
    expect(body.trimStart().startsWith("## User")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});
