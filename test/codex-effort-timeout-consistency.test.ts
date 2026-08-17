import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';

// The codex skill states its wrapper budget and reasoning-effort defaults in
// MANY places: five bash invocation sites, five telemetry log labels, six
// user-facing stall messages, two per-mode defaults tables, three per-site
// override sentences, and Bash-gate prose. Nothing generates these from a
// single source, so they drift — this file pins them to EACH OTHER.
// Deliberately value-agnostic: it asserts the surfaces agree, not what the
// numbers are, so retuning the budget or defaults means changing every
// surface together — this test tells you which one you missed — without
// having to touch the test. The flip side, accepted: a coherent retune of
// everything at once passes without a test edit. Known match looseness,
// also accepted: any 6+-digit `timeout:` in these two docs is treated as a
// codex Bash gate, and prose naming an obsolete "NNNs wrapper" (even
// historically) must be reworded or it trips the prose check.

const ROOT = path.resolve(import.meta.dir, '..');

// Tier order per the OpenAI API's own invalid-enum error message
// ("Supported values are: 'none', 'minimal', 'low', 'medium', 'high',
// 'xhigh', and 'max'"), verified against codex-cli 0.144.3.
const TIERS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const FILES: Array<[string, string]> = [
  ['codex/SKILL.md.tmpl', fs.readFileSync(path.join(ROOT, 'codex/SKILL.md.tmpl'), 'utf8')],
  ['codex/SKILL.md', fs.readFileSync(path.join(ROOT, 'codex/SKILL.md'), 'utf8')],
];

for (const [name, doc] of FILES) {
  describe(`codex effort/timeout consistency: ${name}`, () => {
    const budgets = [...doc.matchAll(/_gstack_codex_timeout_wrapper (\d+) /g)].map((m) => Number(m[1]));
    const budget = budgets[0];

    test('all five wrapper budgets exist and are unified', () => {
      expect(budgets).toHaveLength(5);
      expect(new Set(budgets).size).toBe(1);
    });

    test('every codex_timeout telemetry label states the wrapper budget', () => {
      const labels = [...doc.matchAll(/_gstack_codex_log_event "codex_timeout" "(\d+)"/g)].map((m) => Number(m[1]));
      expect(labels).toHaveLength(5);
      for (const label of labels) expect(label).toBe(budget);
    });

    test('every stall message states the wrapper budget in minutes', () => {
      const mins = [...doc.matchAll(/Codex stalled past ([\d.]+) minutes/g)].map((m) => Number(m[1]));
      expect(mins.length).toBeGreaterThanOrEqual(5);
      for (const m of mins) expect(m).toBe(budget / 60);
    });

    test('every documented Bash gate sits strictly above the wrapper budget', () => {
      const gatesMs = [...doc.matchAll(/timeout: (\d{6,})/g)].map((m) => Number(m[1]));
      expect(gatesMs.length).toBeGreaterThanOrEqual(2);
      for (const gate of gatesMs) expect(gate).toBeGreaterThan(budget * 1000);
    });

    test('every prose reference to "the NNNs wrapper" states the actual budget', () => {
      const refs = [...doc.matchAll(/(\d+)s (?:review |challenge\/consult )?wrapper/g)].map((m) => Number(m[1]));
      expect(refs.length).toBeGreaterThanOrEqual(4);
      for (const r of refs) expect(r).toBe(budget);
    });

    // The five invocation sites appear in a fixed order in the doc:
    // Review default path, Review custom-instructions path, Challenge,
    // Consult new-session, Consult resume.
    const efforts = [...doc.matchAll(/-c 'model_reasoning_effort="(\w+)"'/g)].map((m) => m[1]);
    const [reviewA, reviewB, challenge, consultA, consultB] = efforts;

    test('five invocation sites, valid tiers, paired paths agree', () => {
      expect(efforts).toHaveLength(5);
      for (const e of efforts) expect(TIERS).toContain(e);
      expect(reviewA).toBe(reviewB);
      expect(consultA).toBe(consultB);
    });

    test('both per-mode defaults tables agree with the invocation sites', () => {
      const mode = (label: string) => {
        const found = [...doc.matchAll(new RegExp(`${label}:\\*{0,2} \`(\\w+)\``, 'g'))].map((m) => m[1]);
        expect(found).toHaveLength(2); // override block + Model/effort section
        expect(found[0]).toBe(found[1]);
        return found[0];
      };
      expect(mode('Review \\(2A\\)')).toBe(reviewA);
      expect(mode('Challenge \\(2B\\)')).toBe(challenge);
      expect(mode('Consult \\(2C\\)')).toBe(consultA);
    });

    test('the escalation flag forces a tier >= every per-mode default', () => {
      const forced = doc.match(/use `model_reasoning_effort="(\w+)"` for all modes/);
      expect(forced).not.toBeNull();
      const forcedTier = TIERS.indexOf(forced![1]);
      for (const e of efforts) {
        expect(forcedTier).toBeGreaterThanOrEqual(TIERS.indexOf(e));
      }
    });

    // The three per-site override sentences, in doc order: Review and
    // Challenge (whose defaults equal the forced tier) carry a no-op
    // sentence; Consult carries an escalation sentence.
    test('per-site override sentences agree with the sites and the forced tier', () => {
      const forced = doc.match(/use `model_reasoning_effort="(\w+)"` for all modes/)![1];
      const noops = [...doc.matchAll(/override \(legacy `--xhigh`\) is a no-op here — this mode already runs at `"(\w+)"`/g)].map((m) => m[1]);
      expect(noops).toEqual([reviewA, challenge]);
      for (const v of noops) expect(v).toBe(forced);
      const escalations = [...doc.matchAll(/use `"(\w+)"` instead of `"(\w+)"`/g)];
      expect(escalations).toHaveLength(1);
      expect(escalations[0][1]).toBe(forced);
      expect(escalations[0][2]).toBe(consultA);
    });

    test('error-handling prose names the wrapper budget in its `timeout N` reference', () => {
      const refs = [...doc.matchAll(/`timeout (\d+)` wrapper/g)].map((m) => Number(m[1]));
      expect(refs.length).toBeGreaterThanOrEqual(1);
      for (const r of refs) expect(r).toBe(budget);
    });
  });
}
