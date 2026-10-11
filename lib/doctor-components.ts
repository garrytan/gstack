/**
 * doctor-components — the one component table behind `gstack-doctor --check`.
 *
 * Row ids, `--for <skill>` resolution, `--require <csv>`, the trailer and the
 * `--json` keys all come from here, so a parent agent never maps between
 * vocabularies. The doctor is Bash 3.2 and must report with Bun absent, so it
 * cannot import this file: scripts/gen-doctor-components.ts renders it into
 * bin/gstack-doctor-components.sh (sourced by bin/gstack-doctor-check.sh) and
 * test/doctor-components.test.ts keeps the committed render fresh, the way
 * agents-digest/gstack-AGENTS.md is kept fresh.
 *
 * Row semantics (printed as `PASS | FAIL | SKIP <id>`):
 *   core      always evaluated and always required (runtime, pins, state root,
 *             privacy, cores, revision). `pins` and `state-root` SKIP with a
 *             reason when they cannot be evaluated; a SKIP never fails a run.
 *   host      a host profile. Required when `--for`/`--require` names it, or by
 *             default when it is installed from this checkout. With no flag and
 *             no host installed, `claude` (setup's default host) is required so
 *             an empty machine is never `ok`.
 *   component a built or rendered artifact (patch, browse bundle, browser).
 *             SKIP (not_applicable) when the selected workflow does not need it.
 *   optional  present-or-absent helpers (Codex CLI, CSO native helper). SKIP
 *             (optional) when absent and not required; FAIL only when required.
 */

import { RESULT_CODES } from './result-codes';

export type ComponentKind = 'core' | 'host' | 'component' | 'optional';

export interface DoctorComponent {
  id: string;
  title: string;
  kind: ComponentKind;
}

export const DOCTOR_COMPONENTS: readonly DoctorComponent[] = [
  { id: 'claude', title: 'Claude skills', kind: 'host' },
  { id: 'codex', title: 'Codex skills', kind: 'host' },
  { id: 'patch', title: 'Astra behavioral patch in the Codex render', kind: 'component' },
  { id: 'codex-cli', title: 'Codex CLI (outside voice)', kind: 'optional' },
  { id: 'browse-bundle', title: 'browse bundle', kind: 'component' },
  { id: 'browser', title: 'Chromium launch and render', kind: 'component' },
  { id: 'cso', title: 'CSO native helper', kind: 'optional' },
  { id: 'runtime', title: 'gstack runtime (Bun)', kind: 'core' },
  { id: 'pins', title: 'project pins', kind: 'core' },
  { id: 'state-root', title: 'state root', kind: 'core' },
  { id: 'privacy', title: 'privacy', kind: 'core' },
  { id: 'cores', title: 'cores', kind: 'core' },
  { id: 'revision', title: 'revision', kind: 'core' },
] as const;

export type ComponentId = (typeof DOCTOR_COMPONENTS)[number]['id'];

export const COMPONENT_IDS: readonly ComponentId[] = DOCTOR_COMPONENTS.map(c => c.id);

/** What a workflow needs beyond the core rows. `optional` rows SKIP when absent. */
export interface SkillRequirement {
  requires: readonly ComponentId[];
  optional: readonly ComponentId[];
}

const PLANNING: SkillRequirement = { requires: ['claude', 'codex', 'patch'], optional: ['codex-cli'] };
const BROWSER: SkillRequirement = { requires: ['claude', 'codex', 'patch', 'browse-bundle', 'browser'], optional: ['codex-cli'] };
const CLAUDE_ONLY: SkillRequirement = { requires: ['claude'], optional: [] };

/**
 * Every skill directory in the repo is classified here; test/doctor-components.test.ts
 * fails when a skill is added without a row. Planning skills need both host
 * profiles and the Astra patch (the outside voice reads the Codex render);
 * browser skills add the browse bundle and Chromium; /cso adds the native
 * helper; /codex needs the CLI itself; everything else runs on the Claude
 * profile alone.
 */
export const SKILL_REQUIREMENTS: Readonly<Record<string, SkillRequirement>> = {
  autoplan: PLANNING,
  'plan-ceo-review': PLANNING,
  'plan-eng-review': PLANNING,
  'plan-design-review': PLANNING,
  'plan-devex-review': PLANNING,
  'plan-tune': PLANNING,
  'office-hours': PLANNING,
  spec: PLANNING,
  review: PLANNING,
  ship: PLANNING,
  investigate: PLANNING,
  codex: { requires: ['claude', 'codex', 'patch', 'codex-cli'], optional: [] },
  cso: { requires: ['claude', 'cso'], optional: [] },
  browse: BROWSER,
  qa: BROWSER,
  'qa-only': BROWSER,
  'design-review': BROWSER,
  'design-consultation': BROWSER,
  'design-html': BROWSER,
  'devex-review': BROWSER,
  scrape: BROWSER,
  skillify: BROWSER,
  canary: BROWSER,
  benchmark: BROWSER,
  'make-pdf': BROWSER,
  diagram: BROWSER,
  'pair-agent': BROWSER,
  'open-gstack-browser': BROWSER,
  'setup-browser-cookies': BROWSER,
  'connect-chrome': BROWSER,
  'land-and-deploy': BROWSER,
  'benchmark-models': CLAUDE_ONLY,
  careful: CLAUDE_ONLY,
  'claude-code': CLAUDE_ONLY,
  'context-restore': CLAUDE_ONLY,
  'context-save': CLAUDE_ONLY,
  'design-shotgun': CLAUDE_ONLY,
  'deslop-shared-libs': CLAUDE_ONLY,
  'document-generate': CLAUDE_ONLY,
  'document-release': CLAUDE_ONLY,
  'eval-plan': CLAUDE_ONLY,
  freeze: CLAUDE_ONLY,
  'gstack-upgrade': CLAUDE_ONLY,
  guard: CLAUDE_ONLY,
  health: CLAUDE_ONLY,
  'ios-clean': CLAUDE_ONLY,
  'ios-design-review': CLAUDE_ONLY,
  'ios-fix': CLAUDE_ONLY,
  'ios-qa': CLAUDE_ONLY,
  'ios-sync': CLAUDE_ONLY,
  'landing-report': CLAUDE_ONLY,
  learn: CLAUDE_ONLY,
  retro: CLAUDE_ONLY,
  'setup-deploy': CLAUDE_ONLY,
  'setup-gbrain': CLAUDE_ONLY,
  'sync-gbrain': CLAUDE_ONLY,
  'test-audit': CLAUDE_ONLY,
  unfreeze: CLAUDE_ONLY,
};

/** Rows always evaluated and required, in print order. */
export const CORE_IDS: readonly ComponentId[] = DOCTOR_COMPONENTS.filter(c => c.kind === 'core').map(c => c.id);
export const OPTIONAL_IDS: readonly ComponentId[] = DOCTOR_COMPONENTS.filter(c => c.kind === 'optional').map(c => c.id);
export const HOST_IDS: readonly ComponentId[] = DOCTOR_COMPONENTS.filter(c => c.kind === 'host').map(c => c.id);

/** The SKIP reason the installer and the doctor print for a lazily installed browser. */
export const BROWSER_LAZY_REASON = 'lazy; gstack-browser-ensure installs on first use';

/** Render the table as Bash 3.2 (sourced by bin/gstack-doctor-check.sh). */
export function renderDoctorComponentsSh(): string {
  const caseArm = (ids: readonly string[], body: string) => `    ${ids.join('|')}) ${body} ;;`;
  const groups = new Map<string, string[]>();
  for (const [skill, req] of Object.entries(SKILL_REQUIREMENTS)) {
    const key = `${req.requires.join(' ')}\t${req.optional.join(' ')}`;
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  const requireArms: string[] = [];
  const optionalArms: string[] = [];
  for (const [key, skills] of groups) {
    const [requires, optional] = key.split('\t');
    requireArms.push(caseArm(skills, `printf '%s' '${requires}'`));
    optionalArms.push(caseArm(skills, `printf '%s' '${optional}'`));
  }
  return [
    '# shellcheck shell=bash',
    '# gstack-doctor-components.sh — GENERATED from lib/doctor-components.ts and',
    '# lib/result-codes.ts by scripts/gen-doctor-components.ts (bun run gen:skill-docs). Do not edit; the',
    '# freshness test is test/doctor-components.test.ts. Sourced by',
    '# bin/gstack-doctor-check.sh; Bash 3.2 builtins only.',
    '',
    `GSTACK_DOCTOR_COMPONENTS="${COMPONENT_IDS.join(' ')}"`,
    `GSTACK_DOCTOR_CORE="${CORE_IDS.join(' ')}"`,
    `GSTACK_DOCTOR_HOSTS="${HOST_IDS.join(' ')}"`,
    `GSTACK_DOCTOR_OPTIONAL="${OPTIONAL_IDS.join(' ')}"`,
    `GSTACK_DOCTOR_SKILLS="${Object.keys(SKILL_REQUIREMENTS).join(' ')}"`,
    `GSTACK_BROWSER_LAZY_REASON="${BROWSER_LAZY_REASON}"`,
    '',
    '# gstack_doctor_component_title ID — the human title; returns 1 for an unknown id.',
    'gstack_doctor_component_title() {',
    '  case "$1" in',
    ...DOCTOR_COMPONENTS.map(c => caseArm([c.id], `printf '%s' '${c.title.replace(/'/g, "'\\''")}'`)),
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '# gstack_doctor_component_kind ID — core | host | component | optional; returns 1 for an unknown id.',
    'gstack_doctor_component_kind() {',
    '  case "$1" in',
    ...DOCTOR_COMPONENTS.map(c => caseArm([c.id], `printf '%s' '${c.kind}'`)),
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '# gstack_doctor_skill_requires SKILL — the non-core ids the skill needs; returns 1 for an unknown skill.',
    'gstack_doctor_skill_requires() {',
    '  case "$1" in',
    ...requireArms,
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '# gstack_doctor_skill_optional SKILL — ids that SKIP when absent; returns 1 for an unknown skill.',
    'gstack_doctor_skill_optional() {',
    '  case "$1" in',
    ...optionalArms,
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '# gstack_result_anchor CODE — the docs/troubleshooting.md anchor for a lib/result-codes.ts code; returns 1 for an unknown code.',
    'gstack_result_anchor() {',
    '  case "$1" in',
    ...Object.entries(RESULT_CODES).map(([code, row]) => caseArm([code], `printf '%s' '${row.anchor}'`)),
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
  ].join('\n');
}
