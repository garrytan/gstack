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
 *             privacy, cores, revision, floor, wrapper). `pins`, `state-root`,
 *             `floor` and `wrapper` SKIP with a reason when they cannot be
 *             evaluated; a SKIP never fails a run. WARN never fails a run
 *             either: `wrapper` WARNs (an owner action) for a stale Capy skill
 *             copy the run did not use; `floor` WARNs when the installed gstack
 *             is below the floor the project declares (`min_gstack_version` in
 *             its .gstack/ship-policy.json), with the upgrade as the fix; `pins`
 *             WARNs when only the project's Node pin is unmet (the Node on PATH
 *             differs from the pin; Bun pins stay FAIL, because gstack runs on
 *             Bun). Only the security floor (`--min-revision`, capy/support.env
 *             GSTACK_MIN_REVISION) fails a session for being old.
 *   host      a host profile. Required when `--for`/`--require` names it, or by
 *             default when it is installed from this checkout. With no flag and
 *             no host installed, `claude` (setup's default host) is required so
 *             an empty machine is never `ok`.
 *   component a built or rendered artifact (patch, browse bundle, browser).
 *             SKIP (not_applicable) when the selected workflow does not need it.
 *   optional  present-or-absent helpers (Codex CLI, CSO native helper). SKIP
 *             (optional) when absent and not required; FAIL only when required.
 *
 * Install profiles (INSTALL_PROFILES) are SKILL_REQUIREMENTS rows that name an
 * install shape instead of a skill directory. `--for review-voice` is the one
 * today: a dispatched reviewer's machine gets a clone when absent (an existing
 * checkout is used as is unless it is below the supported minimum) and Bun
 * at gstack's own minimum (the project's pins are never applied, so `pins`
 * SKIPs), no ./setup and no host profiles, and the trailer certifies only the
 * read-only helpers (`helpers`). Its verdict covers no host, so admission
 * refuses every workflow with a `--for <skill>` fix.
 */

import { RESULT_CODES } from './result-codes';
import { SHIP_POLICY_PATH } from './ship-policy';

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
  { id: 'helpers', title: 'read-only helpers (gstack-pregate sealed, gstack-plan-reality, gstack-artifact, gstack-autoplan reads)', kind: 'component' },
  { id: 'runtime', title: 'gstack runtime (Bun)', kind: 'core' },
  { id: 'pins', title: 'project pins', kind: 'core' },
  { id: 'state-root', title: 'state root', kind: 'core' },
  { id: 'privacy', title: 'privacy', kind: 'core' },
  { id: 'cores', title: 'cores', kind: 'core' },
  { id: 'revision', title: 'revision', kind: 'core' },
  { id: 'floor', title: "the project's gstack floor (min_gstack_version in .gstack/ship-policy.json)", kind: 'core' },
  { id: 'wrapper', title: 'Capy skill copy (bootstrapper revision)', kind: 'core' },
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
const REVIEW_VOICE: SkillRequirement = { requires: ['helpers'], optional: [] };

/** SKILL_REQUIREMENTS rows that are install profiles, not skill directories (see the header). */
export const INSTALL_PROFILES: readonly string[] = ['review-voice'];

/**
 * `--for none`: the session runs no gstack workflow on this machine (a
 * coordinator or liaison thread). The check certifies nothing and installs
 * nothing; its trailer is `gstack: ok not-needed for=none (<notes>)`, exit 0,
 * which admits no workflow (no install verdict is written, so admission still
 * refuses with a `--for <skill>` fix). The bootstrapper, the session wrapper
 * and the installer all honour it, so a machine without a checkout gets the
 * same outcome as one with a checkout.
 */
export const NOT_NEEDED_PROFILE = 'none';
export const NOT_NEEDED_REVISION = 'not-needed';

/** The project file and key the `floor` row reads (the same key gstack-ship-queue validates). */
export const PROJECT_FLOOR_FILE = SHIP_POLICY_PATH;
export const PROJECT_FLOOR_FIELD = 'min_gstack_version';

/** The read-only helpers the `helpers` row launches (`<bin> --help` loads each module graph with the launch Bun). */
export const REVIEW_VOICE_HELPERS: readonly string[] = ['gstack-pregate', 'gstack-plan-reality', 'gstack-artifact', 'gstack-autoplan'];

/** The checkout root the Capy skill bootstrapper resolves by default (GSTACK_CAPY_ROOT unset). */
export const CAPY_INSTALL_ROOT = '$HOME/.local/share/gstack';
export const GSTACK_REPO_URL = 'https://github.com/garrytan/gstack.git';

/**
 * The install command for a machine without the Drive skill: clone into ROOT
 * when no checkout is there, then run the checkout's own bootstrapper (the
 * file the Drive skill holds) by absolute path with that root, so the floor
 * check and the fast-forward still run and the caller's working directory,
 * and so its project, is kept. No `; ` inside, so it can ride a fix clause.
 */
export function capyBootstrapCommand(skill: string, root: string = CAPY_INSTALL_ROOT): string {
  return `test -f "${root}/setup" || git clone --quiet --single-branch --depth 1 ${GSTACK_REPO_URL} "${root}" && GSTACK_CAPY_ROOT="${root}" bash "${root}/capy/skill/gstack/scripts/install.sh"${skill ? ` --for ${skill}` : ''}`;
}

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
  'design-motion': BROWSER,
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
  captain: CLAUDE_ONLY,
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
  'write-skill': CLAUDE_ONLY,
  modernize: CLAUDE_ONLY,
  retro: CLAUDE_ONLY,
  'setup-deploy': CLAUDE_ONLY,
  'setup-gbrain': CLAUDE_ONLY,
  'sync-gbrain': CLAUDE_ONLY,
  'test-audit': CLAUDE_ONLY,
  ubicloud: CLAUDE_ONLY,
  unfreeze: CLAUDE_ONLY,
  verify: CLAUDE_ONLY,
  'review-voice': REVIEW_VOICE,
};

/**
 * Planning-only workflows: they read and review a plan but never run the
 * target repository's tests, so a repo test-pin mismatch is reported as
 * `SKIP pins (planning-only; ...)` for `--for <skill>` instead of failing.
 * Workflows that run the repo's tests (ship, review, qa, pregate) keep `pins`
 * required.
 */
export const PINS_ADVISORY_SKILLS: readonly string[] = [
  'autoplan', 'plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review', 'office-hours',
];

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
    `GSTACK_DOCTOR_HELPERS="${REVIEW_VOICE_HELPERS.join(' ')}"`,
    `GSTACK_DOCTOR_NOT_NEEDED="${NOT_NEEDED_PROFILE}"`,
    `GSTACK_DOCTOR_NOT_NEEDED_REVISION="${NOT_NEEDED_REVISION}"`,
    `GSTACK_PROJECT_FLOOR_FILE="${PROJECT_FLOOR_FILE}"`,
    `GSTACK_PROJECT_FLOOR_FIELD="${PROJECT_FLOOR_FIELD}"`,
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
    '# gstack_doctor_skill_pins_advisory SKILL — true for a planning-only workflow (a repo test-pin mismatch SKIPs pins).',
    'gstack_doctor_skill_pins_advisory() {',
    '  case "$1" in',
    caseArm(PINS_ADVISORY_SKILLS, 'return 0'),
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '# gstack_doctor_install_profile NAME — true for an install profile (helper runtime: no ./setup, no host profiles, project pins not applied).',
    'gstack_doctor_install_profile() {',
    '  case "$1" in',
    caseArm(INSTALL_PROFILES, 'return 0'),
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
    '# gstack_capy_bootstrap_cmd ROOT [SKILL] — the install command for a machine without the Drive skill (capyBootstrapCommand).',
    'gstack_capy_bootstrap_cmd() {',
    `  printf 'test -f "%s/setup" || git clone --quiet --single-branch --depth 1 %s "%s" && GSTACK_CAPY_ROOT="%s" bash "%s/capy/skill/gstack/scripts/install.sh"' "$1" '${GSTACK_REPO_URL}' "$1" "$1" "$1"`,
    `  [ -z "\${2:-}" ] || printf ' --for %s' "$2"`,
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
