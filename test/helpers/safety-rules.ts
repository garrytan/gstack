/**
 * Safety-rule registry (E3): each held safety rule, the stable anchor that
 * locates it in its source template or resolver, the paid eval that measures
 * it, and a SHA-256 of its normalized text. test/safety-rule-registry.test.ts
 * fails when an eval disappears while its rule remains, or when the rule text
 * changes without its hash being updated in the same rewording commit.
 *
 * The W1 evals use the same anchors to build their rule-removed arms, so the
 * registry and the evals always agree on which paragraph is "the rule".
 */
import { createHash } from 'node:crypto';

export interface SafetyRule {
  /** Short stable name used in messages. */
  id: string;
  /** E2E_TOUCHFILES / E2E_TIERS key of the eval that measures this rule. */
  evalId: string;
  /** Source template or resolver (repo-relative) that owns the rule text. */
  source: string;
  /** Heading line prefix that scopes the search (the rule's section). */
  section?: string;
  /** Case-insensitive meaning anchor: the first paragraph in the section that matches. */
  match: RegExp;
  /** SHA-256 of the normalized paragraph (collapsed whitespace, lowercased). */
  sha256: string;
}

export const SAFETY_RULES: readonly SafetyRule[] = [
  {
    id: 'codex-boundary',
    evalId: 'safety-codex-boundary',
    source: 'scripts/resolvers/outside-voice-steps.ts',
    match: /^const CODEX_BOUNDARY = /,
    sha256: '5212f94292bfa1b3a94d9713e6f42087c4dc48711bd3f73b6461f828aeef01c0',
  },
  {
    id: 'ship-fresh-evidence',
    evalId: 'safety-ship-stale-evidence',
    source: 'ship/SKILL.md.tmpl',
    section: '## Step 16: Verification Gate',
    match: /completion claims?/i,
    sha256: '0ae0ac82839d7f69a79d501f2dc009c92b696167cb97bc53eeeab4af4da0b416',
  },
  {
    id: 'design-review-risk-stop',
    evalId: 'safety-design-risk-stop',
    source: 'design-review/SKILL.md.tmpl',
    section: '### 8f. Self-Regulation',
    match: /risk\s*>\s*20%/i,
    sha256: 'b688341e862a7ff9c4adb20683fa81de6d007a5bdae82d247cccaf01033b85ac',
  },
  {
    id: 'pair-agent-full-block',
    evalId: 'safety-pair-agent-block',
    source: 'pair-agent/SKILL.md.tmpl',
    match: /full instruction block/i,
    sha256: '3cc7a009f9941469b55a460d293a1233f6c80df4c26b26df85f67c61ff13284f',
  },
  {
    id: 'codex-consult-embed',
    evalId: 'safety-codex-consult-embed',
    source: 'codex/sections/consult-mode.md.tmpl',
    match: /embed content/i,
    sha256: '0f45220bd69eb1456246de4c1b6f4779c56427ab2452596e9744234f03f6d2e4',
  },
  {
    id: 'ios-qa-demo-override',
    evalId: 'safety-ios-demo-ui-only',
    source: 'ios-qa/SKILL.md.tmpl',
    section: '## Demo mode',
    match: /drive every action through visible UI/i,
    sha256: '0ba3230bff9de32f03719daec35c6cef762e15c550264fcffd342dde52291e21',
  },
];

export function normalizeRuleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function ruleHash(text: string): string {
  return createHash('sha256').update(normalizeRuleText(text)).digest('hex');
}

export interface LocatedRule {
  /** The rule paragraph exactly as it appears in `text`. */
  paragraph: string;
  start: number;
  end: number;
}

/**
 * Find the rule paragraph (contiguous non-blank lines) in `text`: the first
 * paragraph after the rule's section heading whose text matches its anchor.
 * Works on the source template and on every generated render.
 */
export function locateRule(text: string, rule: Pick<SafetyRule, 'id' | 'section' | 'match'>): LocatedRule | null {
  const lines = text.split('\n');
  let first = 0;
  let last = lines.length;
  if (rule.section) {
    const heading = lines.findIndex(line => line.startsWith(rule.section!));
    if (heading < 0) return null;
    const depth = rule.section.match(/^#*/)![0].length;
    first = heading + 1;
    const next = lines.findIndex((line, k) => k >= first && depth > 0 && /^#+ /.test(line) && line.match(/^#+/)![0].length <= depth);
    if (next >= 0) last = next;
  }
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  for (let i = first; i < last;) {
    if (!lines[i]!.trim()) { i++; continue; }
    let j = i;
    while (j < last && lines[j]!.trim()) j++;
    const paragraph = lines.slice(i, j).join('\n');
    if (rule.match.test(paragraph)) return { paragraph, start: offsets[i]!, end: offsets[i]! + paragraph.length };
    i = j;
  }
  return null;
}

/** The rule-removed arm: the same text with the rule paragraph deleted. */
export function removeRule(text: string, rule: Pick<SafetyRule, 'id' | 'section' | 'match'>): string {
  const hit = locateRule(text, rule);
  if (!hit) throw new Error(`safety rule ${rule.id}: anchor not found; cannot build the rule-removed arm`);
  return text.slice(0, hit.start) + text.slice(hit.end).replace(/^\n+/, '\n');
}

export function safetyRule(id: string): SafetyRule {
  const rule = SAFETY_RULES.find(r => r.id === id);
  if (!rule) throw new Error(`unknown safety rule ${id}`);
  return rule;
}

/**
 * Which arm a W1 eval runs: the shipped rule, the rule-removed control, or the
 * descriptive no-gstack arm `none` (no skill text at all; GST-470,
 * docs/TESTING_INTERNALS.md#no-gstack-arm).
 */
export type SafetyArm = 'rule' | 'removed' | 'none';

export function safetyArm(env: NodeJS.ProcessEnv = process.env): SafetyArm {
  const arm = env.GSTACK_SAFETY_ARM ?? 'rule';
  if (arm !== 'rule' && arm !== 'removed' && arm !== 'none') throw new Error(`GSTACK_SAFETY_ARM must be rule, removed or none, got ${arm}`);
  return arm;
}

/** Rules whose eval has no no-gstack arm, because its task exists only in the skill text. */
export const NO_NONE_ARM: Readonly<Record<string, string>> = {
  'pair-agent-full-block': 'relaying the remote instruction block is a task only the /pair-agent skill defines',
  'ios-qa-demo-override': 'demo mode and its device routes are defined only in the /ios-qa skill',
};

/** The arm for an eval listed in NO_NONE_ARM: `none` throws with the reason. */
export function skillOnlyArm(ruleId: string, env: NodeJS.ProcessEnv = process.env): Exclude<SafetyArm, 'none'> {
  const why = NO_NONE_ARM[ruleId];
  if (!why) throw new Error(`safety rule ${ruleId} is not listed in NO_NONE_ARM`);
  const arm = safetyArm(env);
  if (arm === 'none') throw new Error(`GSTACK_SAFETY_ARM=none: ${ruleId} has no no-gstack arm, because ${why} (docs/TESTING_INTERNALS.md#no-gstack-arm)`);
  return arm;
}

/** Apply the arm to a rendered fixture: unchanged for `rule`, rule paragraph deleted for `removed`. */
export function applyArm(text: string, rule: SafetyRule, arm: Exclude<SafetyArm, 'none'>): string {
  if (!locateRule(text, rule)) throw new Error(`safety rule ${rule.id}: anchor not found in the rendered fixture`);
  return arm === 'rule' ? text : removeRule(text, rule);
}
