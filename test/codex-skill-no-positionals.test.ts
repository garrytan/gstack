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
// Same resolution chain as bin/gstack-paths (TMPDIR -> TMP -> project-local .gstack/tmp), and
// writability is PROBED rather than assumed — a directory named by TMPDIR is a claim, and an
// existing-but-read-only one makes mkdirSync a no-op success. An earlier version of this file fell
// back to a hardcoded '/tmp', which throws EROFS on a read-only-temp runner and would have failed
// this contract test while the launcher it guards was perfectly correct.
//
// Copied rather than imported from outside-voice-config.test.ts, deliberately and for that file's
// own stated reason: importing a *.test.ts for a helper makes bun execute its suite a second time
// on every full run, and a test that runs twice reports its failures twice and no longer owns its
// state assumptions.
function resolveTmpRoot(env: Record<string, string | undefined> = process.env): string {
  const candidates = [env.TMPDIR, env.TMP, path.join(ROOT, '.gstack', 'tmp')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.rmSync(fs.mkdtempSync(path.join(candidate, 'gstack-probe-')), { recursive: true, force: true });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('no writable temp root: tried TMPDIR, TMP and the project-local .gstack/tmp');
}

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
  // Run against BOTH files. An earlier version extracted from the template only, while its own
  // comment called it the one check that proves delivery — so the file that actually SHIPS was the
  // one never executed. The structural checks already cover both; running only one here left the
  // generated copy proven in shape and unproven in behaviour, which is the weaker half of exactly
  // the distinction this test exists to draw.
  test.each(FILES)('%s: the extracted launcher delivers hostile paths to the adapter literally', (_label, file) => {
    const text = fs.readFileSync(file as string, 'utf8');
    const start = text.indexOf('GSTACK_OV_PROMPT="$_LOOP_PROMPT"');
    const end = text.indexOf(`' > "$_OV_OUT" 2>&1 &`, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const launcher = text.slice(start, end + `' > "$_OV_OUT" 2>&1 &`.length);

    const tmp = fs.mkdtempSync(path.join(resolveTmpRoot(), 'ov-launch-'));
    // A directory name carrying every construct that has broken this lineage: the two that were
    // measured EXECUTING under the old splice idiom, plus the space and apostrophe that broke the
    // first version of this very test. The fixture is the failing input, not a tidy stand-in.
    const hostile = path.join(tmp, `p $(id -u) \`id -u\` it's d`);
    fs.mkdirSync(hostile, { recursive: true });

    const stub = path.join(tmp, 'stub-adapter');
    const argvFile = path.join(tmp, 'argv.txt');
    // Records argv one-per-line so an empty value is visible as an empty line rather than
    // vanishing into whitespace — an empty path is exactly the failure being hunted. Its output
    // path arrives by ENVIRONMENT, so this script is static text with no host path in it.
    // Emits a stderr marker and exits with a distinctive code so the two vars that never reach
    // argv — the stderr redirect and the exit-marker write — can be observed by their EFFECTS.
    fs.writeFileSync(stub, [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$@" > "$T_ARGV"',
      'echo stub-stderr-marker >&2',
      'exit 7',
    ].join('\n') + '\n');
    fs.chmodSync(stub, 0o755);

    const promptFile = path.join(hostile, 'prompt.txt');
    fs.writeFileSync(promptFile, 'x');
    const findings = path.join(hostile, 'f.json');
    const errFile = path.join(hostile, 'e.txt');
    const doneFile = path.join(hostile, 'd');
    const outFile = path.join(hostile, 'o.txt');

    // Substitute only the adapter path; the launcher's own shape is used verbatim.
    // THE STUB PATH NEVER ENTERS THE QUOTED BODY. The launcher is `bash -c '...'`, already inside
    // single quotes, so a quoted path injected there yields `''/path/stub'` and the stub simply
    // never runs — a quoting fix that introduced a quoting defect one context inward, which is how
    // the previous attempt at this failed. Substitute a VARIABLE REFERENCE instead and deliver the
    // path the same way the launcher delivers its own: exported into the environment. Inside single
    // quotes the reference is literal text; the inner bash expands it from the environment.
    //
    // That makes this test dogfood the property under test, deliberately. If exported-env delivery
    // ever breaks, the stub does not run and this test fails — which is the correct direction to
    // fail in, and strictly better than a wrapper that keeps working while the mechanism does not.
    const body = launcher.replace(
      '~/.claude/skills/gstack/bin/gstack-outside-voice', '"$GSTACK_OV_ADAPTER"');
    // NO HOST PATH IS CONCATENATED INTO SHELL SOURCE AT ALL. Every value arrives through
    // spawnSync's `env`, which is never shell-parsed, and the script below is static text that
    // only ever REFERENCES those names.
    //
    // This replaced a quoted-interpolation version, and it is worth saying why rather than leaving
    // the next editor to rediscover it: three consecutive gate rounds each found a distinct quoting
    // defect in this wrapper while confirming the launcher itself was correct. Escaping was fixing
    // them one at a time — a raw splice, then a quote landing INSIDE an already single-quoted
    // `bash -c` body. Anything assembled by string concatenation into a shell command is that
    // defect waiting for input nobody wrote, and the fix for a class is to remove the class, not to
    // quote more carefully. There is nothing left here to escape.
    const script = [
      '_LOOP_PROMPT="$T_PROMPT"',
      '_REPO_ROOT="$T_REPO"',
      '_OV_FINDINGS="$T_FINDINGS"',
      'TMPERR="$T_ERR"',
      '_OV_DONE="$T_DONE"',
      '_OV_EFFORT="$T_EFFORT"',
      '_OV_OUT="$T_OUT"',
      body,
      'wait',
    ].join('\n');
    const scriptFile = path.join(tmp, 'harness.sh');
    fs.writeFileSync(scriptFile, script);

    const r = spawnSync('bash', [scriptFile], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GSTACK_OV_ADAPTER: stub,
        T_ARGV: argvFile,
        T_PROMPT: promptFile,
        T_REPO: hostile,
        T_FINDINGS: findings,
        T_ERR: errFile,
        T_DONE: doneFile,
        T_EFFORT: 'medium',
        T_OUT: outFile,
      },
    });
    expect(r.status).toBe(0);

    const argv = fs.readFileSync(argvFile, 'utf8').split('\n');
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

    // GSTACK_OV_ERR and GSTACK_OV_DONE are the two names that never reach argv — one is a stderr
    // redirect, the other an exit-marker write — so argv assertions are structurally blind to
    // them. Observed by EFFECT instead. A regression that rebinds either name inside the quoted
    // body, or hard-codes its path, leaves the live loop silently unable to record adapter stderr
    // or child exit status, and every argv assertion above would still pass.
    expect(fs.readFileSync(errFile, 'utf8')).toContain('stub-stderr-marker');
    expect(fs.readFileSync(doneFile, 'utf8').trim()).toBe('7');
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
