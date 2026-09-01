import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const TMPL = path.join(ROOT, 'codex', 'SKILL.md.tmpl');
const GEN = path.join(ROOT, 'codex', 'SKILL.md');
const FILES: Array<[string, string]> = [['template', TMPL], ['generated', GEN]];

// VAS-2402. `/codex review` in a claude-fleet-config worktree routes through `--phase auto`, so the
// cheap tier stops depending on anyone typing `--loop`. VAS-2371's measurement week is the argument:
// the flag was live, documented and verbatim-runnable for a week, and compliance was ~20-24%.
//
// The hazard this file guards is NOT "does auto get passed". It is that with `auto` the phase is
// UNKNOWN until the adapter resolves it, so five things that used to be decidable from the typed
// command now have to follow the resolved value. Rounds 18-20 of gstack#1 are the measured cost of
// letting any one of them be re-decided at its own call site: r18 routed the focus branch to the
// loop backend and left three dependents on the gate's values; r19 and r20 each found one of them,
// one round at a time.
//
// So every test here asserts a FOLLOWER is wired to the producer. None of them assert that a helper
// exists — a helper called from one site and a helper called from both are indistinguishable in the
// source, which is exactly the mistake VAS-1885 records.
describe('VAS-2402: --phase auto and the five followers', () => {
  // ── THE PRODUCER ────────────────────────────────────────────────────────────────────────────
  test.each(FILES)('%s: the phase is resolved ONCE, from the adapter, not guessed', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    // resolve-phase is the adapter's own resolver — the same one `exec --phase auto` uses — so the
    // skill's pre-call followers and the adapter's actual choice cannot disagree by construction.
    expect(t).toContain('resolve-phase');
    expect(t).toContain('_OV_RESOLVED_PHASE');
    // A resolution that fails must STOP, never fall back to a guessed phase: guessing `loop` bills
    // a cheap round that can never converge, guessing `final_gate` bills the frontier for a lane
    // that had not earned it. Both are silent.
    expect(t).toMatch(/could not be resolved[\s\S]{0,400}?exit 2/);
  });

  test.each(FILES)('%s: `auto` is accepted by the phase validation', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('loop|final_gate|auto|none');
  });

  // ── FOLLOWER 1: the backend probe asks about the RESOLVED phase ──────────────────────────────
  // `backend --phase auto` is refused outright by the adapter. Asking anyway makes the probe fail,
  // and a failed probe reads as "not codex" — right by accident when auto resolves to the hosted
  // loop, and WRONG when it resolves to the frontier gate, silently skipping the binary and auth
  // checks for a phase that needs both.
  test.each(FILES)('%s: the backend probe uses the resolved phase, never the literal `auto`', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('backend --phase "$_OV_RESOLVED_PHASE"');
    // REDUCED BEFORE CHECKED. The literal `backend --phase auto` appears in this skill on purpose,
    // inside a comment explaining why it is refused — and a bare not.toContain matched that prose
    // and failed a correct file. A check that greps source is measuring the formatter until it is
    // reduced to the thing actually meant, which here is: no EXECUTABLE line invokes it.
    const executable = t
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(executable).not.toContain('backend --phase auto');
  });

  // ── FOLLOWER 2: EFFORT covers the worst case the invocation may run ──────────────────────────
  // One --effort applies to the whole invocation, and an `auto` call that promotes runs the GATE
  // with whatever was passed. `medium` is right for a loop round and wrong for a gate round, and
  // under-powering the round that DECLARES convergence is the failure the tiering rests on.
  test.each(FILES)('%s: effort follows the phase — auto takes the gate\'s high', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/_OV_PHASE" = "auto" \]; then _OV_EFFORT=high/);
    // --xhigh still overrides both, and it is tested here because it is the one branch a reader
    // cannot see from a bare assignment (five review rounds read exactly that as hard-coded).
    expect(t).toMatch(/_XHIGH" = yes \]; then _OV_EFFORT=xhigh/);
  });

  // ── FOLLOWER 3: the TIMEOUT covers the FUSED case ────────────────────────────────────────────
  // An auto call may run the loop AND then the gate without returning. A budget sized for one of
  // them truncates the other, and a round killed by its own timeout exits 124 having produced
  // nothing — byte-identical to a clean round.
  // RE-DERIVED, not deleted. This asserted _OV_TIMEOUT=1230 "for the fused case" — an assertion
  // that encoded a belief about the adapter which turned out to be false: `--timeout` is applied
  // PER ROUND (with_timeout runs inside each backend call, and _round runs again on promotion), so
  // there is no fused total to budget for. Deleting the test would have removed the only guard on
  // this follower; what it should assert is that the budget is the loop's own, and that the
  // wall-clock cost of a promotion is handled by the poller being re-runnable.
  test.each(FILES)('%s: the timeout is the loop\'s own per-round budget', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('_OV_TIMEOUT=900');
    expect(t).toMatch(/per round[\s\S]{0,200}?re-run the poll block/);
  });

  // ── FOLLOWER 4 and 5: the LABEL and the SEVERITY BAR follow the phase that ACTUALLY RAN ──────
  // This is the one that cannot be answered before the call. Under `auto` the adapter may promote
  // mid-invocation, so neither the requested phase nor the pre-call resolution describes what
  // produced the findings file. The adapter announces the promotion on stderr and that is the only
  // observer of it.
  test.each(FILES)('%s: the label derives from the announced phase, not the requested one', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('running the final_gate round now');
    expect(t).toContain('_OV_ANNOUNCED_PHASE');
    // Derived once. Two sites choosing a label independently is the r19 P1 verbatim.
    expect(t).toMatch(/_OV_ANNOUNCED_PHASE" = "final_gate" \]; then _OV_LABEL=GATE_FINDINGS_JSON/);
    expect(t).toContain('"$_OV_LABEL: ');
  });

  test.each(FILES)('%s: the severity bar is stated per phase, not left to be inferred', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    // The two bars are genuinely different questions: the gate FAILS on p1, the loop CONTINUES on
    // p1 or p2. Reading a loop round on the gate's bar ends a lane with P2s outstanding.
    expect(t).toMatch(/BAR: gate[\s\S]{0,120}?p1 > 0 is FAIL/);
    expect(t).toMatch(/BAR: loop[\s\S]{0,160}?p2 > 0 means the loop CONTINUES/);
  });

  // ── SCOPE: by repository, at the call site ───────────────────────────────────────────────────
  test.each(FILES)('%s: auto is scoped by the repo remote, never by a config key', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('git remote get-url origin');
    // A config key could be set globally by accident and would route every repo's reviews through
    // a mode only one repo agreed to.
    expect(t).not.toMatch(/outside_voice_phase|_cfg\s+phase/);
  });

  // ── THE TWO PRODUCERS MUST BE ASKED THE SAME QUESTION ────────────────────────────────────────
  // resolve-phase defaults to origin/main and non-explicit; the review runs
  // `exec --phase auto --explicit --base origin/<base>`. Omit either flag and the pre-call
  // resolution can disagree with the phase the adapter actually picks — on any branch whose base
  // is not main, or when codex_reviews=disabled and the user asked explicitly. The adapter's own
  // note says the two "call one function with one set of inputs"; this asserts the skill supplies
  // the same inputs, which is the half the adapter cannot enforce.
  test.each(FILES)('%s: resolve-phase is given the same inputs as the exec', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/resolve-phase[\s\S]{0,200}?--explicit[\s\S]{0,200}?--base "origin\/<base>"/);
    expect(t).toMatch(/resolve-phase[\s\S]{0,300}?--repo-root/);
  });

  // ── A LABEL IS NEVER PRINTED WITHOUT A BLOCK ─────────────────────────────────────────────────
  // Step 4 reads a printed `*_FINDINGS_JSON:` line as "the verdict comes from this block and
  // nothing else". Printing it with a `<none …>` payload therefore points the grader at a block
  // that does not exist AND removes its fallback to the [P1] markers — so a round with no
  // structured findings grades as a structured clean round. Survivable while the label was a
  // constant; a false CLEAN GATE once it can say GATE_FINDINGS_JSON.
  test.each(FILES)('%s: no findings label is emitted when there is no block', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('NO_FINDINGS_BLOCK');
    // The label variable must never be printed next to a "<none" payload.
    expect(t).not.toMatch(/\$_OV_LABEL: <none/);
  });

  // ── SCOPE FAILS CLOSED ───────────────────────────────────────────────────────────────────────
  // Matching the last path segment opts in any fork called claude-fleet-config. The rollout is
  // scoped to one repository, so the comparison carries owner AND name.
  test.each(FILES)('%s: the repo match is owner/name, not a bare segment', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('vaskockorovski/claude-fleet-config');
    // A bare `{print $NF}` extraction is the segment-only form this replaced.
    expect(t).not.toMatch(/get-url origin[\s\S]{0,200}?awk -F'\[\/:\]' '\{print \$NF\}'/);
  });

  // ── THE DEFAULT PATH ACTUALLY YIELDS TO auto ─────────────────────────────────────────────────
  // The routing table is worthless if the plain-review launcher still runs the inline gate: the
  // change would be unreachable in the one repo it exists for, while every test above still passed.
  // Asserted as CODE, not prose — a step written beside a code block instead of inside it does not
  // get run, which this file already records at cost.
  test.each(FILES)('%s: the inline gate is skipped when the route is auto', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('_REVIEW_ROUTE');
    expect(t).toMatch(/_REVIEW_ROUTE:-gate\}" = "auto" \]; then[\s\S]{0,200}?GATE SKIPPED/);
  });

  // ── THE GATE MARKER TRAVELS WITH THE GATE LABEL ──────────────────────────────────────────────
  // Step 4 keys degraded-gate reporting off GATE_BACKEND. A promoted gate on a hosted backend is
  // diff-scoped, so it must report as PASS (degraded gate); emitting the label without the backend
  // makes a weaker review look like a full one.
  test.each(FILES)('%s: a promoted gate round emits GATE_BACKEND too', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/_OV_ANNOUNCED_PHASE" = "final_gate" \]; then[\s\S]{0,400}?GATE_BACKEND:/);
  });

  // ── THE BAR SURVIVES THE LABEL'S REMOVAL ─────────────────────────────────────────────────────
  // Dropping the label on the no-block path was right, and it took the bar signal with it: step
  // 4's marker fallback describes GATE semantics, so a codex-backed LOOP round carrying [P2]s
  // would read as a clean pass. The bar is now stated on both the block and no-block paths.
  test.each(FILES)('%s: the severity bar is stated even when there is no findings block', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    // Bounded by CONTENT, not by a character count. This was `{0,700}` and broke the moment an
    // attribution notice was inserted between the two anchors — the guard was measuring the
    // distance between them, which nothing promises to keep constant.
    const start = t.indexOf('NO_FINDINGS_BLOCK — backend was codex');
    const end = t.indexOf('elif [ "$_OV_EXIT" = "125" ]', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const branch = t.slice(start, end);
    expect(branch).toContain('BAR: gate');
    expect(branch).toContain('BAR: loop');
  });

  // ── auto IS ONLY TAKEN WHEN A LOOP ROUND WILL ACTUALLY RUN ───────────────────────────────────
  // An auto that resolves straight to final_gate, run by the loop launcher, sends the loop's
  // prompt with --codex-mode at its `exec` default: a DIFF-scoped round reported as the
  // repo-scoped gate. Not an edge case — outside_voice_loop defaults to codex on an unconfigured
  // install, and the size-cap and runaway-cap fallbacks land there too.
  // RE-DERIVED. This asserted that the auto route ALSO required the resolved phase to be `loop`,
  // which was right while the loop launcher ran a gate round diff-scoped. Passing --codex-mode
  // review removed that reason, and the extra condition then had a cost of its own: a
  // straight-to-gate review fell through to `exec --phase final_gate`, skipping the adapter's
  // auto_resolved branch in preflight_gate() — so round 1 could bypass the structural-sweep
  // refusal. Whether a plain review demanded a sweep depended on ledger state, which is not a rule
  // anyone could follow. The guard now asserts the single condition AND the thing that made the
  // second one unnecessary, so removing either fails here.
  test.each(FILES)('%s: the auto route is taken on repo opt-in, with the gate shape preserved', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/_REVIEW_REPO:-\}" = "\$\{_REVIEW_AUTO_REPO:-\}"[\s\S]{0,120}?_REVIEW_ROUTE=auto/);
    expect(t).not.toMatch(/_REVIEW_AUTO_REPO:-\}"[\s\S]{0,200}?_OV_RESOLVED_PHASE:-\}" = "loop"/);
    expect(t).toMatch(/_OV_PHASE" = "auto" \]; then _OV_MODE=review/);
  });

  // ── A PLAIN REVIEW HAS THREE OUTCOMES UNDER auto, AND THE REPORTING SAYS SO ───────────────────
  // Before this change every plain review ended at the gate, so GATE: PASS|FAIL were the only
  // shapes. Under auto a review can stop after the loop or not run at all, and flattening either
  // into GATE: PASS reports a lane as converged when the gate has not spoken.
  // RE-DERIVED TWICE, and the second time is the interesting one. It first asserted a gate-only
  // presentation, then an enumerated outcome table, and a review round found the ENUMERATION wrong
  // on both attempts — the table was a claim about the adapter's exit-code vocabulary restated in a
  // file that cannot notice when that vocabulary changes. Adding states was the failure; the guard
  // now asserts the one invariant that survives the adapter changing underneath it, and asserts
  // that the enumeration has NOT come back.
  // The step-5 invariant is worthless if the sites that CONSUME it still assume a verdict.
  // Round 10 found exactly that: the presentation was corrected and its two dependents — the
  // recommendation line and the review-log substitution contract — were left gate-only, so a
  // loop-only or blocked round had no truthful value to persist and the reflex value is "pass".
  // These guard the dependents, not the invariant.
  // Round 11. Two sites state the _OV_PHASE rule (the guidance comment and the STOP message the
  // self-validating placeholder prints). "a PLAIN review" read as "unfocused", but the route keys
  // on the REPO alone — so a focused review in the rollout repo would be handed final_gate while
  // the route resolved auto. Both sites must carry the same rule, or the second is a rival
  // authority; the guard asserts BOTH, because fixing one is how they drifted in the first place.
  // Round 12 found a THIRD site stating the phase rule: the focused-review launcher's
  // _FOCUS_PHASE, which accepted only loop|final_gate — so a focused review in the rollout repo
  // could never enter the auto lane whatever Step 0.4 resolved. r11 fixed two authorities and
  // there were three. The guard now asserts every site that constrains a phase value.
  // RE-DERIVED, inverted. r12 admitted `auto` here; r13 showed that admitting it without wiring
  // this branch's four literal followers (codex-mode, timeout, effort, labels) to the
  // announcement would report a loop or a promoted diff-scoped gate as a clean final gate. The
  // alternative is a second copy of that machinery on this branch, which the 540s note above
  // already refuses for the poller. So the limit is STATED, and the guard now asserts that the
  // exclusion is deliberate and reachable — a limit nobody can find is a bug report waiting.
  test.each(FILES)('%s: the focused path excludes auto, and says where to get it', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('_FOCUS_PHASE="<<SET-ME: loop | final_gate>>"');
    expect(t).toMatch(/^\s*loop\|final_gate\) ;;/m);
    expect(t).toMatch(/`auto` IS DELIBERATELY NOT AVAILABLE HERE, AND THAT IS A STATED LIMIT/);
    // the way out is named, so the limit is actionable rather than a dead end
    expect(t).toMatch(/To use the auto lane, run a\s*\n?#?\s*plain `\/codex review`/);
    expect(t).toMatch(/STOP: _FOCUS_PHASE was not substituted[\s\S]{0,400}?'auto' is not available on the focused path/);
    // the withdrawn admission must not creep back
    expect(t).not.toContain('_FOCUS_PHASE="<<SET-ME: loop | final_gate | auto>>"');
  });

  // RE-DERIVED, and this one encoded a rule that was WRONG rather than merely stale. It asserted
  // "instructions are not an axis", which is true of _REVIEW_ROUTE (it keys on the repo alone)
  // and false of THIS line: a focused review never reaches that launcher, so probing `auto` for
  // it probes a backend the invocation will never use. Focus is an axis here and only here.
  // Asserted on the rule LINES, which is what a session reads, not on the prose around them.
  test.each(FILES)('%s: the phase rule names the focused case, at both sites', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/^#\s+auto\s+an UNFOCUSED review in a claude-fleet-config worktree/m);
    expect(t).toMatch(/^#\s+final_gate\s+every other review: any FOCUSED review/m);
    expect(t).toMatch(/FOCUS IS AN AXIS HERE, AND ONLY HERE/);
    // bare /codex counts as unfocused — the entry point that has no instructions to be focused by
    expect(t).toMatch(/Bare `\/codex` that resolves to Review at Step 0\.3 counts as UNFOCUSED/);
    // the STOP message is the second authority and must carry the same rule
    expect(t).toMatch(/STOP: _OV_PHASE was not substituted[\s\S]{0,500}?any FOCUSED review wherever it runs/);
    // every superseded wording is gone from both sites
    expect(t).not.toMatch(/`auto` for a PLAIN review/);
    expect(t).not.toMatch(/WHETHER INSTRUCTIONS WERE GIVEN IS NOT AN AXIS HERE/);
    expect(t).not.toMatch(/'auto' for ANY OTHER review in a claude-fleet-config worktree/);
  });

  // The prose said no-verdict rounds must record ran_phase and exit; the RUNNABLE payload did not
  // carry either field. The command is what gets copied, so the prose was decoration. Assert the
  // payload, not the paragraph.
  // An auto review that stops on the loop half emits OV_FINDINGS_JSON, not GATE_FINDINGS_JSON.
  // Naming only the latter writes a loop round to the log with the wrong count or none.
  // Swept, not found by a round: every consumer of a verdict requires exit 0, and GATE_BACKEND
  // alone admitted any non-125 exit — so a gate that announced itself and then died printed a
  // gate marker for a round with no verdict. One condition, asserted at the only site that has it.
  test.each(FILES)('%s: the gate backend marker takes the same conjunct as the verdict', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/if \[ "\$_OV_EXIT" = "0" \] && \[ "\$_OV_ANNOUNCED_PHASE" = "final_gate" \]; then\s*\n\s*echo "GATE_BACKEND:/);
    expect(t).not.toMatch(/if \[ "\$_OV_EXIT" != "125" \] && \[ "\$_OV_ANNOUNCED_PHASE" = "final_gate" \]/);
    expect(t).toMatch(/THE CONDITION IS `= 0`, NOT `!= 125`/);
  });

  test.each(FILES)('%s: the findings count reads whichever block was printed', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/WHICHEVER structured block the round\s+printed/);
    expect(t).toMatch(/`GATE_FINDINGS_JSON` on a gate round, `OV_FINDINGS_JSON` on a loop round/);
    expect(t).not.toMatch(/findings \(from GATE_FINDINGS_JSON's p1\+p2 when a block was\s+printed, else/);
  });

  test.each(FILES)('%s: the runnable log payload carries the announced phase', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    const payload = t.slice(t.indexOf('gstack-review-log'), t.indexOf('gstack-review-log') + 400);
    expect(payload).toContain('"announced_phase":"ANNOUNCED_PHASE"');
    expect(payload).toContain('"exit":EXIT');
    expect(t).toMatch(/EXIT \(the adapter's exit code, unquoted\)/);
    // RE-DERIVED. This asserted the field takes `$_OV_ANNOUNCED_PHASE`, which is true only on the
    // AUTO path — the inline gate and focused branches never define it and the adapter emits no
    // announcement for an explicit phase, so following that rule wrote an empty phase on every
    // successful non-auto review. The value is literal on those paths, not unknown. Assert the
    // per-path table, and that empty is refused outright.
    // Every path that reaches step 7 has a row, asserted one by one. Two consecutive rounds each
    // found a MISSING row and both were not-run cases, so this guard exists to make the set
    // complete rather than the common cases correct.
    expect(t).toMatch(/\| auto, round finished \| `\$_OV_ANNOUNCED_PHASE` \| `\$_OV_EXIT` \|/);
    expect(t).toMatch(/\| auto, round failed \|/);
    expect(t).toMatch(/\| auto, still running \(125\) \| `unknown`/);
    expect(t).toMatch(/\| inline gate, gate ran \| `final_gate`/);
    expect(t).toMatch(/gate NEVER INVOKED\*\* \(`_GATE_MODE != ready`\) \| \*\*`none`\*\* \| \*\*`null`\*\* \|/);
    expect(t).toMatch(/\| the focused path \| `\$_FOCUS_PHASE`/);
    // Was THE FIFTH ROW; rows were inserted above it and the pointer went stale. The guard now
    // asserts the content-addressed form, and that no positional pointer comes back.
    expect(t).toMatch(/THE `gate NEVER INVOKED` ROW IS THE ONE THAT LOOKS LIKE IT DOES NOT NEED TO EXIST/);
    expect(t).not.toMatch(/THE FIFTH ROW IS THE ONE/);
    expect(t).toMatch(/`""` IS NOT A LEGAL VALUE IN THE PHASE COLUMN/);
  });

  // NEEDS_CODEX: no was a claim about the WHOLE review; under auto it can only be a claim about
  // the half the round starts on, since a clean loop promotes to a possibly Codex-backed gate.
  // A promotion runs two rounds in ONE invocation writing to ONE stdout, and the promotion notice
  // goes to stderr — so nothing in the captured output marks where the loop half ends. Worse in
  // the DEFAULT config than an exotic one: the adapter deletes the findings file for a codex
  // backend, so the common openrouter-loop → codex-gate promotion is guaranteed to have no
  // structured block and to grade from a mixed stream.
  // The explicit --loop path and the auto path SHARE the loop launcher. Without a second
  // condition on the route, `/codex review --loop` in the rollout repo resolves auto and gets sent
  // through with _OV_PHASE=auto — so a lane the user asked to keep cheap can promote and present
  // a convergence nobody requested. The condition keys on what the USER TYPED, which is not the
  // ledger-state condition an earlier round removed for being unpredictable.
  test.each(FILES)('%s: an explicit --loop is never routed into the auto lane', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/&& \[ "\$_USER_TYPED_LOOP" = "no" \]; then\s*\n\s*_REVIEW_ROUTE=auto/);
    expect(t).toContain('_USER_TYPED_LOOP="<<SET-ME: yes | no>>"');
    // The ACCEPTING arm, not only the rejecting one. A probe deleted `yes|no) ;;` and every guard
    // stayed green while the case fell through to `*)` for every value — so a correctly
    // substituted invocation would STOP. Asserting only the STOP message tests half a case
    // statement, which is the shape that always passes and sometimes blocks everything.
    expect(t).toMatch(/^\s*yes\|no\) ;;\s*$/m);
    // self-validating, like every other substituted value in this file
    expect(t).toMatch(/STOP: _USER_TYPED_LOOP was not substituted[\s\S]{0,400}?Guessing is not available/);
    // and the route is printed with the input that decided it, so it is checkable at round time
    expect(t).toMatch(/user_typed_loop=\$_USER_TYPED_LOOP/);
    expect(t).toMatch(/THE SECOND IS NOT THE ONE A ROUND ALREADY REMOVED/);
  });

  // Step 7 claims to enumerate EVERY path; the explicit loop path reaches it with a real phase
  // and a real exit, and was missing.
  test.each(FILES)('%s: the persistence table covers the explicit loop path', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/explicit `review --loop`, finished\*\* \| \*\*`loop`\*\* — literal; this lane never promotes/);
    expect(t).toMatch(/explicit `review --loop`, still running \(125\)\*\* \| \*\*`loop`\*\* — still literal \| `125` \|/);
  });

  test.each(FILES)('%s: a promoted round declares its output mixed and grades conservatively', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/MIXED OUTPUT: what follows is the loop half AND the gate half concatenated/);
    // the superseded claim must be gone — it asserted the opposite of the truth
    expect(t).not.toMatch(/The findings below are the GATE's/);
    // the flag is initialised, so a stale yes cannot mark an unpromoted round as mixed
    expect(t).toMatch(/^_OV_PROMOTED=no/m);
    expect(t).toMatch(/_OV_PROMOTED=yes/);
    // and the marker fallback errs toward FAIL, which is the recoverable direction
    // Anchored to the CONDITION, not just the text. A probe replaced the guard condition with
    // `if false` and this assertion stayed green: the notice was present and unreachable, which
    // is indistinguishable from present and working if you only grep for the words.
    expect(t).toMatch(/if \[ "\$\{_OV_PROMOTED:-no\}" = "yes" \]; then\s*\n\s*echo "ATTRIBUTION: unavailable/);
    expect(t).toMatch(/ATTRIBUTION: unavailable[\s\S]{0,400}?any \[P1\] is a FAIL for this round/);
    expect(t).toMatch(/errs toward FAIL deliberately/);
  });

  test.each(FILES)('%s: NEEDS_CODEX is scoped to the phase the round starts on', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/ON `--phase auto` THAT IS A STATEMENT ABOUT THE FIRST HALF ONLY/);
    expect(t).toMatch(/the phase this review is starting\s*\n?does not route to Codex/);
    // the superseded absolute claim must be gone
    expect(t).not.toMatch(/no phase of this review routes\s*\n?to Codex, so neither/);
  });

  test.each(FILES)('%s: the review log can express a round with no verdict', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    // a no-verdict row must be WRITABLE — a contract that only admits pass/fail forces a lie
    expect(t).toMatch(/\|\s*\*\*no gate verdict exists\*\*[^|]*\|[^|]*\|\s*\*\*`none`\*\*\s*\|/);
    expect(t).toContain('`no_verdict`');
    // and it must not be readable as a pass
    expect(t).toMatch(/`gate: "none"` is NOT a synonym for `"pass"`/);
    // what ran is recorded, so it is recoverable rather than inferred
    expect(t).toContain('"announced_phase"');
    expect(t).toContain('"exit"');
  });

  test.each(FILES)('%s: the recommendation line survives a round with no verdict', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/WHEN NO GATE VERDICT EXISTS, THE LINE IS STILL REQUIRED/);
    // RE-DERIVED: this asserted "ITS ACTION IS NEVER SHIP OR FIX", which was over-broad and
    // self-contradicting — the block's own first example opens with "Fix the two P2s and run
    // /codex review again", which is exactly right on a loop-continue round. The constraint is
    // about what the action CLAIMS, not which verb it uses.
    expect(t).toMatch(/MUST NOT IMPLY THE LANE IS\s+CONVERGED/);
    expect(t).toMatch(/`Ship` is never available without a verdict; a `Fix` is available only when\s+it is paired with running another round, never with shipping/);
    // step 5a must not promise a verdict it may not have
    expect(t).not.toMatch(/After presenting Codex's verbatim\s+output and the GATE verdict/);
  });

  test.each(FILES)('%s: only an announced final_gate phase may end a lane', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    // The invariant takes THREE conjuncts, and this guard once asserted only the first — it kept
    // passing when the announcement-alone version was live, which is a guard going weak silently.
    // Each conjunct is asserted separately so dropping any one of them fails here.
    // Anchored to the numbered conjuncts, not to column positions. The previous version matched
    // across a two-column ASCII block, so it was partly a test of the alignment: "review output"
    // sat on the next line with unrelated text between, and the guard failed for a layout reason
    // while the rule was correct. Reference by content, never by position.
    expect(t).toMatch(/A GATE VERDICT EXISTS only when ALL THREE hold/);
    expect(t).toMatch(/1\. _OV_ANNOUNCED_PHASE = final_gate/);
    expect(t).toMatch(/2\. _OV_EXIT = 0/);
    expect(t).toMatch(/3\. the round produced review output/);
    expect(t).toMatch(/ONLY outcome that ends a lane/);
    expect(t).toMatch(/BOTH CONDITIONS, AND THE SECOND IS THE ONE THAT WAS MISSING/);
    // announcing is not finishing — the reason the second conjunct exists
    expect(t).toMatch(/Announcing a round is not finishing\s+one/);
    expect(t).toMatch(/ANY OTHER COMBINATION, INCLUDING AN ANNOUNCED final_gate THAT DID NOT FINISH/);
    expect(t).toMatch(/NO GATE VERDICT EXISTS/);
    // the announcement is the source, not the request — a promotion changes it mid-invocation
    expect(t).toMatch(/Read `_OV_ANNOUNCED_PHASE` from the adapter's stderr announcement, never from what you asked for/);
    // persistence keys off the same fact and invents no vocabulary. \s+ not ' ' — the sentence
    // wraps, and a literal space here would make this guard a test of the FORMATTER.
    expect(t).toMatch(/`gate` is\s+`"pass"`\/`"fail"` \*\*only\*\* when `_OV_ANNOUNCED_PHASE` was `final_gate`/);
    // The enumeration must stay gone — but SCOPED TO THE PROSE BLOCK. A bare not.toContain here
    // forbade the skill's own working shell code: `LANE BLOCKED` is a real echo on the exit-6 path
    // and predates this branch (3 sites on the base). That the code was already right is precisely
    // why the prose table was redundant, and forbidding the code to protect the prose would have
    // been the enumeration defect a third time, in the guard.
    const prose = t.slice(
      t.indexOf('ONLY A ROUND WHOSE ANNOUNCED PHASE WAS'),
      t.indexOf('5a. **Synthesis recommendation'),
    );
    expect(prose.length).toBeGreaterThan(400);   // the slice found both anchors
    expect(prose).not.toMatch(/^\s*LANE BLOCKED\s{2,}/m);
    expect(prose).not.toContain('ROUND STATE UNKNOWN');
    expect(prose).not.toMatch(/exit 6, and TERMINAL/);
  });
  // ── PARTIAL OUTPUT IS WITHHELD WHILE THE ROUND RUNS ──────────────────────────────────────────
  // Under auto a 125 can mean the loop half finished and the gate is still running, so the file on
  // disk holds a complete clean-looking review from an unfinished invocation.
  test.each(FILES)('%s: review output is withheld on a still-running round', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/_OV_EXIT" = "125" \]; then[\s\S]{0,300}?review output withheld/);
  });

  // ── THE ANNOUNCEMENT BEATS THE PROBE ─────────────────────────────────────────────────────────
  // The pre-call resolve-phase happens before the round launches, so another round on the lane can
  // advance the ledger in between. Labelling from the probe would misstate the bar and suppress
  // GATE_BACKEND for the round that actually ran.
  // RE-DERIVED for the rename, and the rename is the fix rather than cosmetics: the variable was
  // called _OV_RAN_PHASE while holding a phase the adapter merely ANNOUNCED, from a preflight line
  // printed before any round starts. Fourteen rounds read that name and none questioned it, until
  // one found the output claiming PHASE_THAT_RAN for invocations that returned before running.
  test.each(FILES)('%s: the announced phase is read from the adapter announcement', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('_OV_ANNOUNCE_LINE');
    expect(t).toContain('phase resolved to');
    expect(t).toMatch(/_OV_ANNOUNCE_LINE" \][\s\S]{0,400}?_OV_ANNOUNCED_PHASE="\$_OV_ANNOUNCE_LINE"/);
    // the output must not claim the announced phase RAN
    expect(t).toMatch(/echo "ANNOUNCED_PHASE: \$_OV_ANNOUNCED_PHASE \(what the adapter said it was starting/);
    expect(t).toMatch(/ANNOUNCED, NOT RAN/);
    // Scoped to EMISSIONS. A bare not.toContain also forbids the comment that explains why the
    // old label was wrong — the second time this exact over-reach has appeared in this file's
    // guards, after one that forbade the skill's own `LANE BLOCKED` echo. Naming a superseded
    // thing in order to explain it is not a regression; emitting it is.
    expect(t).not.toMatch(/echo "PHASE_THAT_RAN/);
  });

  // ── STEP 4 HONOURS THE BAR ON THE NO-BLOCK PATH ──────────────────────────────────────────────
  // The marker fallback was written when a no-block round was always a gate round. Under auto it
  // can be a codex-backed LOOP round, whose bar is P1 or P2 — so the grader must read the printed
  // BAR line rather than assuming the gate's P1-only rule and passing a lane with P2s outstanding.
  test.each(FILES)('%s: the marker fallback defers to the printed BAR line', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/fall back to the markers[\s\S]{0,900}?Read the BAR line/);
  });

  // ── THE TIMEOUT IS PER ROUND, AND SAYS SO ────────────────────────────────────────────────────
  // Verified in the adapter: with_timeout is applied inside each backend call and _round runs a
  // second time on promotion. An earlier revision called 1230 a fused total, which would have told
  // an operator a round was over budget while it was legitimately still running.
  test.each(FILES)('%s: the timeout is described per round, not as a fused total', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toContain('per round');
    expect(t).not.toContain('_OV_TIMEOUT=1230');
  });

  // ── THE CODEX MODE IS A FOLLOWER TOO, AND ONLY THE ADAPTER SHOWS IT ──────────────────────────
  // `_round` passes the caller's --codex-mode to exec_codex, and the auto promotion calls _round a
  // SECOND time — so a promoted gate inherits whatever the loop launcher sent. At the loop's `exec`
  // default that runs the gate DIFF-scoped while the reporting labels it GATE_*. The same
  // inheritance also covers the race where the adapter re-resolves to final_gate at dispatch.
  test.each(FILES)('%s: auto carries --codex-mode review for both halves', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/_OV_PHASE" = "auto" \]; then _OV_MODE=review/);
    expect(t).toContain('--codex-mode "$GSTACK_OV_MODE"');
  });

  // ── STEP 4 CARRIES A CONCRETE LOOP RULE, not just a pointer to the BAR ────────────────────────
  // Deferring to the BAR line is worthless if the only concrete grading rules that follow are the
  // gate's. A session following the checklist literally would still pass a [P2]-only loop round.
  test.each(FILES)('%s: the marker fallback states the loop rule explicitly', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/BAR: loop` was printed[\s\S]{0,300}?loop \*\*CONTINUES\*\*/);
  });

  // ── NOTHING IS INTERPRETED UNTIL THE ROUND FINISHES ──────────────────────────────────────────
  // The adapter prints its resolution and its promotion notice AS IT GOES, so on a 125 (poll
  // expired, child still running) both can be on stderr while the gate half is still executing.
  // Reading them then announces a promoted gate that has produced nothing, and step 4 grades the
  // loop half's output as the gate's — a round that did not finish, reported as one that did.
  test.each(FILES)('%s: a still-running round announces no phase, label or backend', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    // It must ASSIGN, not only print: step 7 requires a value on every path, and printing
    // `unknown` while leaving the variable unset made the still-running round the one case the
    // log rule had no answer for.
    // RE-DERIVED. This asserted the branch collapses to `unknown` unconditionally, which is only
    // honest under `auto` — where the phase genuinely is undecided until it promotes or does not.
    // An explicit loop or final_gate is LITERAL and never promotes, so `unknown` there discards a
    // fact the invocation already holds. The branch is conditional now; assert the condition.
    expect(t).toMatch(/if \[ "\$_OV_PHASE" = "auto" \]; then _OV_ANNOUNCED_PHASE=unknown; else _OV_ANNOUNCED_PHASE="\$_OV_PHASE"; fi/);
    expect(t).toMatch(/`unknown` ONLY WHERE THE PHASE COULD STILL CHANGE/);
    // By ADJACENCY to the assignment it follows, not by a character window from the branch head:
    // several sites test exit 125, so the window was anchored to whichever came first. Third
    // positional guard in this file to break this way — content, never position.
    // The message is conditional now for the same reason the phase is: an explicit lane never
    // promotes, so naming a gate half there suggests it is already spending a round in the
    // background. Assert BOTH arms — a guard that checks only one arm of a branch is how the
    // accepting arm of a case statement went missing earlier in this same file.
    expect(t).toMatch(/belongs to a gate half that is still executing/);
    expect(t).toMatch(/This lane does not promote, so no gate half is running/);
    expect(t).toMatch(/_OV_ANNOUNCED_PHASE="\$_OV_PHASE"; fi\s*\n[\s\S]{0,400}?if \[ "\$_OV_PHASE" = "auto" \]; then\s*\n\s*echo "ANNOUNCED_PHASE: \$_OV_ANNOUNCED_PHASE — the round has NOT finished/);
    // RE-DERIVED. This asserted the literal `!= 125` guard on GATE_BACKEND, which is the CONDITION
    // rather than the property it was protecting: a still-running round must not print a gate
    // marker. The condition tightened to `= 0` — strictly stronger, since 125 is not 0 — and this
    // guard failed anyway, because it was pinned to the text. Assert the property; the sibling
    // test asserts the exact condition once, at the site that owns it.
    // Anchor by ADJACENCY, not by slicing around the first match: three sites emit GATE_BACKEND
    // and indexOf found the plain gate path, which has no _OV_ANNOUNCED_PHASE condition at all. The
    // _OV_ANNOUNCED_PHASE conjunct is what uniquely identifies the auto site.
    expect(t).toMatch(/\[ "\$_OV_ANNOUNCED_PHASE" = "final_gate" \]; then\s*\n\s*echo "GATE_BACKEND:/);
    expect(t).not.toMatch(/!= "125" \] && \[ "\$_OV_ANNOUNCED_PHASE" = "final_gate" \]/);
  });

  // ── EXIT 6 stays enumerated on this path ─────────────────────────────────────────────────────
  // The adapter grew `blocked` with the VAS-2373 redesign; a lane that cannot converge must report
  // as blocked, never as an unexpected failure and never as a clean round.
  test.each(FILES)('%s: exit 6 (blocked) is handled on the auto path', (_l, file) => {
    const t = fs.readFileSync(file as string, 'utf8');
    expect(t).toMatch(/_OV_EXIT" = "6"[\s\S]{0,300}?LANE BLOCKED/);
  });
});
