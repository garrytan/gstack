import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

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

  // DERIVED FROM THE TABLE, not hand-listed. The hand-listed version named four of the six and a
  // review round found the gap: reintroducing `--effort '"$_OV_EFFORT"'` or `2>'"$TMPERR"'` would
  // have been green on the only test that names them. A criterion you never wrote down cannot be
  // audited for what it excluded, so the exclusion here is impossible by construction — add a row
  // to ENV_PAIRS and it is covered.
  test.each(FILES)('%s: no outer variable is spliced into text the inner shell re-parses', (_label, file) => {
    const text = fs.readFileSync(file as string, 'utf8');
    for (const [, assignment] of ENV_PAIRS) {
      // 'GSTACK_OV_PROMPT="$_LOOP_PROMPT"' -> '$_LOOP_PROMPT', the OUTER variable whose VALUE the
      // dangerous idiom would paste into text `bash -c` then parses.
      const outer = assignment.slice(assignment.indexOf('"') + 1, assignment.lastIndexOf('"'));
      expect(text).not.toContain(`'"${outer}"'`);
    }
  });

  // ── CONNECTEDNESS ──────────────────────────────────────────────────────────────────────────
  // The table above proves each literal EXISTS. It cannot prove the two halves are connected
  // across the shell boundary, and a review round said so precisely: a launcher writing
  // `GSTACK_OV_PROMPT="$_LOOP_PROMPT"` as a plain local statement — not as a command prefix on the
  // `nohup` — would satisfy every assertion above while the inner shell expanded the variable to
  // the empty string. That is the same silent-empty-path failure this file exists to prevent, so
  // the guard has to reach past text.
  //
  // Two checks, because they fail differently. This one pins the STRUCTURE: the six assignments
  // form one unbroken command prefix immediately ahead of `nohup bash -c`, with nothing but
  // line-continuations between them. The next one RUNS it.
  test.each(FILES)('%s: the assignments are a command prefix on the nohup, not loose statements', (_label, file) => {
    const text = fs.readFileSync(file as string, 'utf8');
    // Built as a literal contiguous block rather than a regex: the thing being asserted is that
    // these lines are ADJACENT and end in a continuation, and a regex over shell metacharacters
    // needs escaping that is itself a place to get this wrong.
    const CONT = ' \\\n';
    const block = ENV_PAIRS.map(([, assignment]) => assignment).join(CONT) + CONT + 'nohup bash -c';
    expect(text).toContain(block);
  });

  // ...and the behavioural one. EXTRACT the real launcher out of the shipped file, point it at a
  // stub that records the argv it receives, and run it. This is the only check here that proves
  // DELIVERY rather than shape — every assertion above is about text, and text is what was correct
  // on disk while the thing that ran was wrong.
  //
  // The temp paths are deliberately HOSTILE: they contain `$(id -u)` and a backtick, the two
  // constructs measured EXECUTING under the splice idiom this lineage replaced. So one run proves
  // both properties at once — the values arrive, and they arrive literally.
  test('the extracted launcher delivers hostile paths to the adapter literally', () => {
    const text = fs.readFileSync(TMPL, 'utf8');
    const start = text.indexOf('GSTACK_OV_PROMPT="$_LOOP_PROMPT"');
    const end = text.indexOf(`' > "$_OV_OUT" 2>&1 &`, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const launcher = text.slice(start, end + `' > "$_OV_OUT" 2>&1 &`.length);

    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ov-launch-'));
    // A directory name carrying the two constructs that were measured executing.
    const hostile = path.join(tmp, 'p $(id -u) `id -u` d');
    fs.mkdirSync(hostile, { recursive: true });

    const stub = path.join(tmp, 'stub-adapter');
    // Records argv one-per-line so an empty value is visible as an empty line rather than
    // vanishing into whitespace — an empty path is exactly the failure being hunted.
    fs.writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "' + tmp + '/argv.txt"\n');
    fs.chmodSync(stub, 0o755);

    const promptFile = path.join(hostile, 'prompt.txt');
    fs.writeFileSync(promptFile, 'x');
    const findings = path.join(hostile, 'f.json');
    const errFile = path.join(hostile, 'e.txt');
    const doneFile = path.join(hostile, 'd');
    const outFile = path.join(hostile, 'o.txt');

    // Substitute only the adapter path; the launcher's own shape is used verbatim.
    const body = launcher.replace('~/.claude/skills/gstack/bin/gstack-outside-voice', stub);
    const script = [
      `_LOOP_PROMPT='${promptFile}'`,
      `_REPO_ROOT='${hostile}'`,
      `_OV_FINDINGS='${findings}'`,
      `TMPERR='${errFile}'`,
      `_OV_DONE='${doneFile}'`,
      `_OV_EFFORT='medium'`,
      `_OV_OUT='${outFile}'`,
      body,
      'wait',
    ].join('\n');

    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(r.status).toBe(0);

    const argv = fs.readFileSync(path.join(tmp, 'argv.txt'), 'utf8').split('\n');
    // The paths arrive, and they arrive LITERALLY — no expansion, no word splitting.
    expect(argv).toContain(promptFile);
    expect(argv).toContain(hostile);
    expect(argv).toContain(findings);
    expect(argv).toContain('medium');
    // ...and nothing arrived empty, which is the shape a referenced-but-unassigned var produces.
    const flags = ['--prompt-file', '--repo-root', '--findings-out', '--effort'];
    for (const flag of flags) {
      const i = argv.indexOf(flag);
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).not.toBe('');
    }
    // The hostile constructs were NOT evaluated: `id -u` would have produced a bare uid.
    expect(argv.join('\n')).toContain('$(id -u)');
    fs.rmSync(tmp, { recursive: true, force: true });
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
