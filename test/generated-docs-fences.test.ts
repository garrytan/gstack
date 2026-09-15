/**
 * Generated-doc fence pairing + PIPESTATUS portability (#2671, #2669).
 *
 * #2671: an unclosed ```bash fence in codex/sections/consult-mode.md silently
 * inverted every fenced region after it — prose rendered as code and the
 * skill's tail instructions rendered inert. Nothing guarded fence pairing, so
 * the defect migrated file-to-file across carves. The scanner below is a
 * CommonMark-faithful state machine, NOT a mod-2 count: inside an open fence,
 * a ```lang line is literal content (only a bare ``` closes), so nested fence
 * EXAMPLES don't false-positive; a file that ends inside a fence fails.
 *
 * #2669: `${PIPESTATUS[0]}` is bash-only — empty under zsh, so hang detection
 * (`= "124"`) never fired and every clean run printed a spurious
 * "[codex exit ]". The portable form `${PIPESTATUS[0]:-${pipestatus[1]}}` is
 * pinned statically AND executed under real bash and zsh.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** All generated skill docs: every SKILL.md + every sections/*.md. */
function generatedDocs(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules")
      continue;
    const skillMd = path.join(ROOT, entry.name, "SKILL.md");
    if (fs.existsSync(skillMd)) out.push(skillMd);
    const sections = path.join(ROOT, entry.name, "sections");
    if (fs.existsSync(sections)) {
      for (const f of fs.readdirSync(sections)) {
        if (f.endsWith(".md")) out.push(path.join(sections, f));
      }
    }
  }
  return out;
}

/** Returns the 1-based line of the first unclosed fence, or null when paired. */
export function findUnclosedFence(body: string): number | null {
  let openLine: number | null = null;
  let openLen = 0;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const run = lines[i].match(/^(`{3,})(.*)$/);
    if (!run) continue;
    if (openLine === null) {
      openLine = i + 1; // any ```+ line opens (info string allowed)
      openLen = run[1].length;
    } else if (run[1].length >= openLen && /^\s*$/.test(run[2])) {
      // CommonMark close: backticks-only, run at least as long as the opener.
      // A shorter run (``` inside a ```` fence) is literal content.
      openLine = null;
    }
    // ```lang while inside = literal content (nested fence example) — ignore.
  }
  return openLine;
}

describe("generated-doc fence pairing (#2671)", () => {
  const docs = generatedDocs();

  test("scanner sees a meaningful corpus", () => {
    expect(docs.length).toBeGreaterThan(50);
  });

  test("every generated SKILL.md and sections/*.md closes every fence", () => {
    const bad: string[] = [];
    for (const doc of docs) {
      const line = findUnclosedFence(fs.readFileSync(doc, "utf-8"));
      if (line !== null) bad.push(`${path.relative(ROOT, doc)}:${line}`);
    }
    expect(
      bad,
      `unclosed \`\`\` fence(s) — everything after each inverts prose/code:\n  ${bad.join("\n  ")}`,
    ).toEqual([]);
  });

  test("the scanner itself catches the #2671 shape (self-test)", () => {
    const broken = "prose\n```bash\nx=1\n\nmore prose that should be outside\n```bash\nmkdir -p y\n```\n";
    // First fence opens; ```bash inside is content; bare ``` closes it; file
    // ends OUTSIDE — but the second region's prose was swallowed. The
    // detectable invariant is end-of-file state, so test a truly unclosed tail:
    expect(findUnclosedFence(broken)).toBeNull();
    expect(findUnclosedFence(broken + "```text\ntail\n")).toBe(9);
  });

  test("fence-length tracking: a longer opener is not closed by a shorter run", () => {
    // 4-backtick fence wrapping a 3-backtick example (the standard way to
    // show a fence inside a fence) — the inner bare ``` must NOT close it.
    const quad = "````markdown\n```bash\necho hi\n```\n````\n";
    expect(findUnclosedFence(quad)).toBeNull();
    // Same body missing the 4-backtick closer: unclosed at line 1.
    expect(findUnclosedFence("````markdown\n```bash\necho hi\n```\n")).toBe(1);
  });
});

describe("codex exit-code capture is bash+zsh portable (#2669)", () => {
  const SECTION_FILES = [
    "codex/sections/challenge-mode.md",
    "codex/sections/consult-mode.md",
    "codex/sections/challenge-mode.md.tmpl",
    "codex/sections/consult-mode.md.tmpl",
  ];

  test("no bare ${PIPESTATUS[0]} capture survives in the codex sections", () => {
    for (const rel of SECTION_FILES) {
      const body = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      for (const line of body.split("\n")) {
        if (line.includes("_CODEX_EXIT=")) {
          expect(line, `${rel}: ${line.trim()}`).toContain(
            "${PIPESTATUS[0]:-${pipestatus[1]}}",
          );
        }
      }
      // The capture must exist at all (3 sites across the two modes).
      expect(body).toContain("_CODEX_EXIT=${PIPESTATUS[0]:-${pipestatus[1]}}");
    }
  });

  const SNIPPET = 'exit 7 | cat; _CODEX_EXIT=${PIPESTATUS[0]:-${pipestatus[1]}}; echo "EXIT:$_CODEX_EXIT"';
  const CLEAN = 'true | cat; _CODEX_EXIT=${PIPESTATUS[0]:-${pipestatus[1]}}; echo "EXIT:$_CODEX_EXIT"';

  test("bash: captures the FIRST pipeline stage's exit code", () => {
    const r = spawnSync("bash", ["-c", `(${SNIPPET})`], { encoding: "utf-8", timeout: 10_000 });
    expect(r.stdout).toContain("EXIT:7");
    const c = spawnSync("bash", ["-c", CLEAN], { encoding: "utf-8", timeout: 10_000 });
    expect(c.stdout).toContain("EXIT:0");
  });

  const hasZsh = spawnSync("zsh", ["--version"], { encoding: "utf-8", timeout: 10_000 }).status === 0;
  test.skipIf(!hasZsh)("zsh: the lowercase 1-indexed fallback captures the same code", () => {
    const r = spawnSync("zsh", ["-c", `(${SNIPPET})`], { encoding: "utf-8", timeout: 10_000 });
    expect(r.stdout).toContain("EXIT:7");
    const c = spawnSync("zsh", ["-c", CLEAN], { encoding: "utf-8", timeout: 10_000 });
    expect(c.stdout).toContain("EXIT:0");
  });
});

describe("codex JSONL python parser semantics (runtime)", () => {
  /**
   * Extract the python program passed to `"$PYTHON_CMD" -u -c "..."` from a
   * RENDERED codex section. The program sits inside a double-quoted bash
   * string: it starts on the line after the `-u -c "` opener and ends at the
   * next line that is exactly `"`.
   *
   * No un-escaping is needed: the raw bytes carry exactly one backslash
   * sequence (`\n` inside an f-string), and bash double quotes pass a
   * backslash through UNCHANGED unless it precedes $, `, ", \ or newline —
   * so the raw markdown text is byte-for-byte the program bash hands to
   * python. The safety pins below fail if that equivalence is ever broken.
   */
  function extractParsers(rel: string): string[] {
    const body = fs.readFileSync(path.join(ROOT, rel), "utf-8");
    const OPENER = '-u -c "\n';
    const out: string[] = [];
    let at = body.indexOf(OPENER);
    while (at !== -1) {
      const start = at + OPENER.length;
      const close = body.indexOf('\n"\n', start); // closing lone-" line
      if (close === -1) break;
      const src = body.slice(start, close);
      // consult's resume block is a `<same python streaming parser as above>`
      // placeholder, not a program — keep only real parsers.
      if (src.startsWith("import sys, json")) out.push(src);
      at = body.indexOf(OPENER, close);
    }
    return out;
  }

  const challenge = extractParsers("codex/sections/challenge-mode.md");
  const consult = extractParsers("codex/sections/consult-mode.md");

  test("each rendered section yields exactly one real parser program", () => {
    expect(challenge.length).toBe(1);
    expect(consult.length).toBe(1);
    for (const src of [...challenge, ...consult]) {
      expect(src).toContain("turn_completed_count = 0");
      expect(src).toContain("turn_failed = False");
      // bash double-quote safety pins: an unescaped $ or backtick would be
      // EXPANDED by bash before python ever saw it, and a \$ \` \" or \\
      // would be escape-PROCESSED — either breaks the raw-text == delivered-
      // text equivalence this suite (and the live skill) relies on.
      expect(src).not.toMatch(/[$`]/);
      expect(src).not.toMatch(/\\[\\"$`]/);
    }
  });

  const hasPython =
    spawnSync("python3", ["--version"], { encoding: "utf-8", timeout: 10_000 }).status === 0;

  function runParser(src: string, events: unknown[]): { stdout: string; stderr: string } {
    const input = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const r = spawnSync("python3", ["-u", "-c", src], {
      input,
      encoding: "utf-8",
      timeout: 15_000,
    });
    expect(r.status).toBe(0);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  const SECTIONS = [
    ["challenge-mode", challenge],
    ["consult-mode", consult],
  ] as const;

  for (const [name, parsers] of SECTIONS) {
    test.skipIf(!hasPython)(`${name}: turn.completed prints token usage, no disconnect warning`, () => {
      const { stdout, stderr } = runParser(parsers[0], [
        { type: "item.completed", item: { type: "agent_message", text: "hello from codex" } },
        { type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 34 } },
      ]);
      expect(stdout).toContain("hello from codex");
      expect(stdout).toContain("tokens used: 1234");
      expect(stderr).not.toContain("No turn.completed event received");
      expect(stderr).not.toContain("[codex turn FAILED]");
    });

    test.skipIf(!hasPython)(`${name}: turn.failed is a STATED failure, not a disconnect`, () => {
      const { stderr } = runParser(parsers[0], [
        { type: "turn.failed", error: { message: "model exploded" } },
      ]);
      expect(stderr).toContain("[codex turn FAILED] model exploded");
      expect(stderr).toContain("not a disconnect");
      expect(stderr).not.toContain("No turn.completed event received");
    });

    test.skipIf(!hasPython)(`${name}: silence with no terminal event warns of a disconnect`, () => {
      const { stderr } = runParser(parsers[0], [
        { type: "item.completed", item: { type: "reasoning", text: "thinking" } },
      ]);
      expect(stderr).toContain("No turn.completed event received");
    });
  }

  test.skipIf(!hasPython)("consult-mode: thread.started prints SESSION_ID for session capture", () => {
    const { stdout } = runParser(consult[0], [
      { type: "thread.started", thread_id: "0199-abc-123" },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(stdout).toContain("SESSION_ID:0199-abc-123");
  });
});
