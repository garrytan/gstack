/**
 * #2514: boolean flags (--toc, --cover, ...) must never swallow the next
 * positional argument. The parser treated ANY following non-flag token as a
 * flag value, so `$P generate --toc essay.md` ate essay.md as --toc's value
 * and the skill's own documented invocations failed with "missing input".
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parseArgs, BOOLEAN_FLAGS } from "../src/cli";
import { COMMANDS } from "../src/commands";

// parseArgs slices argv from index 2 (node/bun + script path).
const parse = (...args: string[]) => parseArgs(["bun", "cli.ts", ...args]);

describe("#2514 boolean flags do not swallow positionals", () => {
  test("--toc before the input keeps the input positional", () => {
    const r = parse("generate", "--toc", "essay.md");
    expect(r.command).toBe("generate");
    expect(r.flags.toc).toBe(true);
    expect(r.positional).toEqual(["essay.md"]);
  });

  test("the skill's documented usage parses: --cover --toc essay.md essay.pdf", () => {
    const r = parse("generate", "--cover", "--toc", "essay.md", "essay.pdf");
    expect(r.flags.cover).toBe(true);
    expect(r.flags.toc).toBe(true);
    expect(r.positional).toEqual(["essay.md", "essay.pdf"]);
  });

  test("value flags still consume their value", () => {
    const r = parse("generate", "--watermark", "DRAFT", "memo.md");
    expect(r.flags.watermark).toBe("DRAFT");
    expect(r.positional).toEqual(["memo.md"]);
  });

  test("--to consumes its format value", () => {
    const r = parse("generate", "--to", "html", "doc.md");
    expect(r.flags.to).toBe("html");
    expect(r.positional).toEqual(["doc.md"]);
  });

  test("every boolean read in cli.ts is covered by the set (derived, not hardcoded)", () => {
    // The original guard hardcoded six names, so --strict and --confidential
    // shipped outside the set and still swallowed the next positional — the
    // exact #2514 failure. Derive the list from the source's own boolean
    // reads instead: `f.name === true` / `f["some-name"] === true` direct
    // reads, plus booleanFlag("name", ...) pairs which read BOTH name and
    // no-name. A new boolean read now fails this test until it joins the set.
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "src", "cli.ts"), "utf-8");
    const derived = new Set<string>();
    for (const m of src.matchAll(/\bf\.([a-zA-Z][\w-]*) === true/g)) derived.add(m[1]);
    for (const m of src.matchAll(/\bf\["([\w-]+)"\] === true/g)) derived.add(m[1]);
    for (const m of src.matchAll(/booleanFlag\("([\w-]+)"/g)) {
      derived.add(m[1]);
      derived.add(`no-${m[1]}`);
    }
    expect(derived.size).toBeGreaterThanOrEqual(6); // regex went blind if this drops
    for (const f of derived) {
      expect(BOOLEAN_FLAGS.has(f), `boolean read '--${f}' is missing from BOOLEAN_FLAGS`).toBe(true);
    }
  });

  test("--strict does not swallow the input (the documented CI-mode flag, #2514)", () => {
    const r = parse("generate", "--strict", "essay.md");
    expect(r.flags.strict).toBe(true);
    expect(r.positional).toEqual(["essay.md"]);
  });

  test("--no-confidential and --confidential both stay valueless", () => {
    const a = parse("generate", "--no-confidential", "memo.md");
    expect(a.flags["no-confidential"]).toBe(true);
    expect(a.positional).toEqual(["memo.md"]);
    const b = parse("generate", "--confidential", "memo.md");
    expect(b.flags.confidential).toBe(true);
    expect(b.positional).toEqual(["memo.md"]);
  });

  test("structural (T4): every --no-* flag in the commands.ts registry is boolean", () => {
    // A --no-* flag is a negation — it never takes a value. A new one added
    // to the registry but missed in BOOLEAN_FLAGS silently re-opens #2514
    // (it would swallow the next positional). Derived from the registry, so
    // this cannot rot as commands grow.
    const missing: string[] = [];
    for (const [cmd, spec] of COMMANDS) {
      for (const flag of spec.flags ?? []) {
        if (!/^--no-/.test(flag)) continue;
        if (!BOOLEAN_FLAGS.has(flag.replace(/^--/, ""))) missing.push(`${cmd}: ${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
