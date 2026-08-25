import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const TMPL = path.join(ROOT, 'codex', 'SKILL.md.tmpl');
const GEN = path.join(ROOT, 'codex', 'SKILL.md');

// VAS-2403. A skill body may not contain a dollar sign followed by a single digit, because the
// harness REWRITES those tokens with the arguments the skill was invoked with, before the model
// ever reads the file.
//
// This is not a shell-correctness rule and it must not be read as one. The construct this replaced
// was perfectly good shell — paths passed as argv, read back as positionals, chosen deliberately
// over a splice that had been measured EXECUTING a path. It was correct on disk and corrupted in
// flight, which is the only reason it is banned here.
//
// Measured on a real `/codex review --loop`: the delivered text carried `--prompt-file "--loop"`,
// and an unrelated display line reading `Est. cost: ~<dollar-zero>.12` arrived as `~review.12`.
// The substitution is ZERO-INDEXED over the argument string, so dollar-zero is the first token —
// which is why the ban covers 0 and not just 1 through 9, and why a reader reasoning from shell
// convention (where argv[0] is the program name and nobody interpolates it) would leave the worst
// case in place.
//
// The failure is silent at the point a human looks. The adapter receives a prompt file named
// `--loop`, exits 2, and the skill reports ROUND NOT RUN — a message about prompt files, on a run
// whose prompt file is fine. Nothing anywhere says "your skill text was rewritten".
const POSITIONAL = /\$[0-9]/;

// Match the whole token so a failure names what it found rather than making the reader grep.
const POSITIONAL_G = /\$[0-9]/g;

function offendingLines(file: string): string[] {
  const out: string[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const hits = line.match(POSITIONAL_G);
    if (hits) out.push(`${path.basename(file)}:${i + 1}: ${hits.join(' ')} — ${line.trim().slice(0, 110)}`);
  });
  return out;
}

describe('codex skill carries no harness-substitutable positionals (VAS-2403)', () => {
  // The template is the file a human edits, so it is the one whose failure is actionable.
  test('SKILL.md.tmpl contains no dollar-digit token anywhere', () => {
    const bad = offendingLines(TMPL);
    expect(bad).toEqual([]);
  });

  // ...and the generated file, because that is what actually ships. Asserting only the template
  // would pass over a hand-edit of the generated copy, which is the exact thing the "do not edit
  // directly" banner asks people not to do and therefore the thing worth checking.
  test('generated SKILL.md contains no dollar-digit token anywhere', () => {
    const bad = offendingLines(GEN);
    expect(bad).toEqual([]);
  });

  // The ban is only useful if the replacement kept the property the positional form existed to
  // provide: values must reach the inner shell WITHOUT being spliced into text it re-parses.
  // Env-var expansion satisfies that; a quote-closing splice does not. Assert the shape positively
  // rather than trusting the absence check above — "no positionals" is also true of the dangerous
  // splice, so the negative assertion alone would grade the worst option a pass.
  // EVERY variable is checked on BOTH halves — assigned AND referenced — and the pairs are driven
  // from one table so a future addition cannot be half-covered.
  //
  // An earlier version of this test asserted the ASSIGNMENT for the prompt and only the REFERENCE
  // for the rest. A review round pointed out what that permits: a launcher that references an env
  // var nothing ever assigns. The inner shell then expands it to the empty string, the adapter
  // receives an empty path, and this test passes while its own name claims the paths are exported.
  // That is the same failure as the defect this file exists to prevent, and the same one recorded
  // a hundred lines up in the skill itself, where `_OV_LANE` was assigned below its first use and
  // every run quietly shared `gstack-ov-findings-.json`. An empty interpolation is not a loud
  // failure; it is a silent collision.
  const ENV_PAIRS: Array<[string, string, string]> = [
    ['GSTACK_OV_PROMPT',   'GSTACK_OV_PROMPT="$_LOOP_PROMPT"',   '--prompt-file "$GSTACK_OV_PROMPT"'],
    ['GSTACK_OV_REPO',     'GSTACK_OV_REPO="$_REPO_ROOT"',       '--repo-root "$GSTACK_OV_REPO"'],
    ['GSTACK_OV_FINDINGS', 'GSTACK_OV_FINDINGS="$_OV_FINDINGS"', '--findings-out "$GSTACK_OV_FINDINGS"'],
    ['GSTACK_OV_ERR',      'GSTACK_OV_ERR="$TMPERR"',            '2>"$GSTACK_OV_ERR"'],
    ['GSTACK_OV_DONE',     'GSTACK_OV_DONE="$_OV_DONE"',         'echo $? > "$GSTACK_OV_DONE"'],
    ['GSTACK_OV_EFFORT',   'GSTACK_OV_EFFORT="$_OV_EFFORT"',     '--effort "$GSTACK_OV_EFFORT"'],
  ];

  // Both files, because the template is what a human edits and the generated copy is what ships.
  // Asserting the pair on the GENERATED file is also what closes the "regeneration silently
  // dropped part of the block" hole: a lost --repo-root or exit-marker line fails a named case
  // here rather than slipping past a two-string spot check.
  const FILES: Array<[string, string]> = [['template', TMPL], ['generated', GEN]];

  for (const [label, file] of FILES) {
    for (const [name, assignment, reference] of ENV_PAIRS) {
      test(`${label}: ${name} is both assigned and referenced`, () => {
        const text = fs.readFileSync(file, 'utf8');
        expect(text).toContain(assignment);
        expect(text).toContain(reference);
      });
    }
  }

  test.each(FILES)('%s: no path is spliced into text the inner shell re-parses', (_label, file) => {
    const text = fs.readFileSync(file as string, 'utf8');
    // The splice this whole lineage exists to keep out: a single quote closed mid-string so the
    // VALUE lands in text `bash -c` then parses. Kept as its own case rather than folded into the
    // table above, because it is a DIFFERENT property — the table proves the values arrive, this
    // proves they arrive without being re-parsed, and a fix for one has twice been mistaken for
    // the other.
    expect(text).not.toContain(`'"$_LOOP_PROMPT"'`);
    expect(text).not.toContain(`'"$_REPO_ROOT"'`);
    expect(text).not.toContain(`'"$_OV_FINDINGS"'`);
    expect(text).not.toContain(`'"$_OV_DONE"'`);
  });

  // The regex is the whole guard, so prove it BITES rather than assuming it does. A guard asserted
  // only against clean input is indistinguishable from one that matches nothing (VAS-1814): both
  // report green. Feed it the exact text that shipped broken.
  test('the guard detects the construct that actually shipped', () => {
    const shipped = '  --phase loop --prompt-file "$1" --repo-root "$2" \\';
    expect(POSITIONAL.test(shipped)).toBe(true);
    // ...and the display-line instance, which a shell-minded reader would have skipped because
    // argv[0] is not something anyone interpolates on purpose.
    expect(POSITIONAL.test('Est. cost: ~$0.12')).toBe(true);
    // Not so broad that it flags ordinary prose or a variable whose name merely contains a digit.
    expect(POSITIONAL.test('run gstack-outside-voice exec --phase loop')).toBe(false);
    expect(POSITIONAL.test('echo "$_OV_FINDINGS"')).toBe(false);
  });
});
