/**
 * /plan-tune tests (gate tier)
 *
 * Covers the foundation of /plan-tune v1:
 *   - Question registry schema validation
 *   - Registry completeness (every AskUserQuestion pattern has an id)
 *   - Id uniqueness (no duplicates)
 *   - One-way door safety declarations
 *   - Signal map references valid registry ids
 *
 * Binary-level tests (question-log, question-preference, developer-profile)
 * and migration tests live in sibling files created as those binaries ship.
 */

import { describe, test, expect } from 'bun:test';
import {
  QUESTIONS,
  getQuestion,
  getOneWayDoorIds,
  getAllRegisteredIds,
  getRegistryStats,
  type QuestionDef,
} from '../scripts/question-registry';
import {
  classifyQuestion,
  isOneWayDoor,
  DESTRUCTIVE_PATTERN_LIST,
  ONE_WAY_SKILL_CATEGORY_SET,
} from '../scripts/one-way-doors';
import {
  SIGNAL_MAP,
  applySignal,
  validateRegistrySignalKeys,
  newDimensionTotals,
  normalizeToDimensionValue,
  ALL_DIMENSIONS,
} from '../scripts/psychographic-signals';
import {
  ARCHETYPES,
  FALLBACK_ARCHETYPE,
  matchArchetype,
  getAllArchetypeNames,
} from '../scripts/archetypes';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// -----------------------------------------------------------------------
// Schema validation
// -----------------------------------------------------------------------

describe('question-registry schema', () => {
  test('every entry has required fields', () => {
    for (const [key, q] of Object.entries(QUESTIONS as Record<string, QuestionDef>)) {
      expect(q.id).toBeDefined();
      expect(q.skill).toBeDefined();
      expect(q.category).toBeDefined();
      expect(q.door_type).toBeDefined();
      expect(q.description).toBeDefined();
      expect(q.description.length).toBeGreaterThan(0);
      expect(q.id).toBe(key); // key and id must match
    }
  });

  test('all ids are kebab-case and start with skill name', () => {
    for (const q of Object.values(QUESTIONS as Record<string, QuestionDef>)) {
      expect(q.id).toMatch(/^[a-z0-9-]+$/);
      expect(q.id.startsWith(q.skill + '-')).toBe(true);
      expect(q.id.length).toBeLessThanOrEqual(64);
    }
  });

  test('no duplicate ids (keys and id fields are 1:1 by construction)', () => {
    const ids = Object.values(QUESTIONS as Record<string, QuestionDef>).map((q) => q.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test('category is one of the allowed values', () => {
    const ALLOWED = new Set(['approval', 'clarification', 'routing', 'cherry-pick', 'feedback-loop']);
    for (const q of Object.values(QUESTIONS as Record<string, QuestionDef>)) {
      expect(ALLOWED.has(q.category)).toBe(true);
    }
  });

  test('door_type is one-way or two-way', () => {
    for (const q of Object.values(QUESTIONS as Record<string, QuestionDef>)) {
      expect(q.door_type === 'one-way' || q.door_type === 'two-way').toBe(true);
    }
  });

  test('options (if present) are non-empty arrays of strings', () => {
    for (const q of Object.values(QUESTIONS as Record<string, QuestionDef>)) {
      if (q.options) {
        expect(Array.isArray(q.options)).toBe(true);
        expect(q.options.length).toBeGreaterThan(0);
        for (const opt of q.options) {
          expect(typeof opt).toBe('string');
          expect(opt.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('descriptions are short and informative (<= 200 chars, no newlines)', () => {
    for (const q of Object.values(QUESTIONS as Record<string, QuestionDef>)) {
      expect(q.description.length).toBeLessThanOrEqual(200);
      expect(q.description.includes('\n')).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------
// Runtime helpers
// -----------------------------------------------------------------------

describe('question-registry helpers', () => {
  test('getQuestion returns entry for known id', () => {
    const q = getQuestion('ship-test-failure-triage');
    expect(q).toBeDefined();
    expect(q?.skill).toBe('ship');
    expect(q?.door_type).toBe('one-way');
  });

  test('getQuestion returns undefined for unknown id', () => {
    expect(getQuestion('this-is-not-registered')).toBeUndefined();
  });

  test('getOneWayDoorIds returns Set of one-way ids', () => {
    const ids = getOneWayDoorIds();
    expect(ids.has('ship-test-failure-triage')).toBe(true);
    expect(ids.has('review-sql-safety')).toBe(true);
    expect(ids.has('land-and-deploy-merge-confirm')).toBe(true);
    // And does NOT include a known two-way door:
    expect(ids.has('ship-changelog-voice-polish')).toBe(false);
  });

  test('getAllRegisteredIds count matches QUESTIONS keys', () => {
    expect(getAllRegisteredIds().size).toBe(Object.keys(QUESTIONS).length);
  });

  test('getRegistryStats totals are consistent', () => {
    const stats = getRegistryStats();
    expect(stats.total).toBe(Object.keys(QUESTIONS).length);
    expect(stats.one_way + stats.two_way).toBe(stats.total);
    const bySkillSum = Object.values(stats.by_skill).reduce((a, b) => a + b, 0);
    expect(bySkillSum).toBe(stats.total);
    const byCategorySum = Object.values(stats.by_category).reduce((a, b) => a + b, 0);
    expect(byCategorySum).toBe(stats.total);
  });
});

// -----------------------------------------------------------------------
// Safety contract — one-way doors
// -----------------------------------------------------------------------

describe('one-way door safety', () => {
  test('every destructive/security question is declared one-way', () => {
    // Safety-critical question ids must exist and be one-way.
    const mustBeOneWay = [
      'ship-test-failure-triage',         // shipping broken tests
      'review-sql-safety',                 // SQL injection path
      'review-llm-trust-boundary',         // LLM trust boundary
      'cso-global-scan-approval',          // scans outside branch
      'cso-finding-fix',                   // security finding
      'land-and-deploy-merge-confirm',     // actual merge
      'land-and-deploy-rollback',          // rollback decision
      'investigate-fix-apply',             // applying a fix
      'plan-ceo-review-premise-revise',    // changing agreed premise
      'plan-eng-review-arch-finding',      // architecture change
      'office-hours-landscape-privacy-gate',// sending data to search provider
      'autoplan-user-challenge',           // scope direction change
    ];
    const oneWayIds = getOneWayDoorIds();
    for (const id of mustBeOneWay) {
      expect(getQuestion(id)).toBeDefined();
      expect(oneWayIds.has(id)).toBe(true);
    }
  });

  test('at least 10 one-way doors are declared', () => {
    // Sanity check — if we lose one-way classification on critical questions,
    // this fails before safety bugs ship.
    expect(getOneWayDoorIds().size).toBeGreaterThanOrEqual(10);
  });
});

// -----------------------------------------------------------------------
// Coverage breadth — make sure we span the high-volume skills
// -----------------------------------------------------------------------

describe('registry breadth', () => {
  test('high-volume skills have at least one registered question', () => {
    const stats = getRegistryStats();
    const highVolume = [
      'ship',
      'review',
      'office-hours',
      'plan-ceo-review',
      'plan-eng-review',
      'plan-design-review',
      'plan-devex-review',
      'qa',
      'investigate',
      'land-and-deploy',
      'cso',
    ];
    for (const skill of highVolume) {
      expect(stats.by_skill[skill] ?? 0).toBeGreaterThan(0);
    }
  });

  test('preamble one-time prompts are registered (telemetry, proactive, routing)', () => {
    expect(getQuestion('preamble-telemetry-consent')).toBeDefined();
    expect(getQuestion('preamble-proactive-behavior')).toBeDefined();
    expect(getQuestion('preamble-routing-injection')).toBeDefined();
  });

  test('/plan-tune itself registers its enable + setup + mutation-confirm', () => {
    expect(getQuestion('plan-tune-enable-setup')).toBeDefined();
    expect(getQuestion('plan-tune-declared-dimension')).toBeDefined();
    expect(getQuestion('plan-tune-confirm-mutation')).toBeDefined();
  });
});

// -----------------------------------------------------------------------
// Signal map consistency
// -----------------------------------------------------------------------

describe('psychographic signal map', () => {
  test('signal_keys in registry are typed strings', () => {
    for (const q of Object.values(QUESTIONS as Record<string, QuestionDef>)) {
      if (q.signal_key !== undefined) {
        expect(typeof q.signal_key).toBe('string');
        expect(q.signal_key.length).toBeGreaterThan(0);
        expect(q.signal_key).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  test('every signal_key in registry has a SIGNAL_MAP entry', () => {
    const { missing } = validateRegistrySignalKeys();
    expect(missing).toEqual([]);
  });

  test('applySignal mutates dimension totals per mapping', () => {
    const dims = newDimensionTotals();
    const applied = applySignal(dims, 'scope-appetite', 'expand');
    expect(applied.length).toBeGreaterThan(0);
    expect(dims.scope_appetite).toBeCloseTo(0.06, 5);
  });

  test('applySignal returns [] for unknown signal_key', () => {
    const dims = newDimensionTotals();
    const applied = applySignal(dims, 'no-such-signal', 'anything');
    expect(applied).toEqual([]);
    expect(dims.scope_appetite).toBe(0);
  });

  test('applySignal returns [] for unknown user_choice', () => {
    const dims = newDimensionTotals();
    const applied = applySignal(dims, 'scope-appetite', 'definitely-not-a-real-choice');
    expect(applied).toEqual([]);
  });

  test('normalizeToDimensionValue maps 0 → 0.5 (neutral)', () => {
    expect(normalizeToDimensionValue(0)).toBeCloseTo(0.5, 5);
  });

  test('normalizeToDimensionValue returns values in [0, 1]', () => {
    for (const total of [-10, -1, -0.5, 0, 0.5, 1, 10]) {
      const v = normalizeToDimensionValue(total);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test('ALL_DIMENSIONS has 5 entries', () => {
    expect(ALL_DIMENSIONS.length).toBe(5);
  });

  test('no extra SIGNAL_MAP keys without registry reference (informational)', () => {
    // Extra keys are allowed (a signal might be reserved for upcoming registry
    // entries). But list them so drift is visible.
    const { extra } = validateRegistrySignalKeys();
    // Allow up to 3 "reserved" extras before flagging. Tighten later.
    expect(extra.length).toBeLessThanOrEqual(3);
  });
});

// -----------------------------------------------------------------------
// Archetypes
// -----------------------------------------------------------------------

describe('archetypes', () => {
  test('each archetype has name, description, center, tightness', () => {
    for (const arch of ARCHETYPES) {
      expect(arch.name).toBeDefined();
      expect(arch.description).toBeDefined();
      expect(arch.center).toBeDefined();
      expect(arch.tightness).toBeGreaterThan(0);
      for (const d of ALL_DIMENSIONS) {
        expect(typeof arch.center[d]).toBe('number');
        expect(arch.center[d]).toBeGreaterThanOrEqual(0);
        expect(arch.center[d]).toBeLessThanOrEqual(1);
      }
    }
  });

  test('archetype names are unique', () => {
    const names = ARCHETYPES.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('matchArchetype returns Cathedral Builder for boil-the-ocean profile', () => {
    const dims = {
      scope_appetite: 0.88,
      risk_tolerance: 0.55,
      detail_preference: 0.5,
      autonomy: 0.5,
      architecture_care: 0.85,
    };
    const match = matchArchetype(dims);
    expect(match.name).toBe('Cathedral Builder');
  });

  test('matchArchetype returns Ship-It Pragmatist for small-scope/fast profile', () => {
    const dims = {
      scope_appetite: 0.22,
      risk_tolerance: 0.78,
      detail_preference: 0.25,
      autonomy: 0.7,
      architecture_care: 0.38,
    };
    const match = matchArchetype(dims);
    expect(match.name).toBe('Ship-It Pragmatist');
  });

  test('matchArchetype returns Polymath for extreme-outlier profile', () => {
    const dims = {
      scope_appetite: 0.05,
      risk_tolerance: 0.95,
      detail_preference: 0.95,
      autonomy: 0.05,
      architecture_care: 0.05,
    };
    const match = matchArchetype(dims);
    expect(match.name).toBe(FALLBACK_ARCHETYPE.name);
  });

  test('getAllArchetypeNames includes Polymath fallback', () => {
    const names = getAllArchetypeNames();
    expect(names).toContain('Polymath');
    expect(names.length).toBe(ARCHETYPES.length + 1);
  });
});

// -----------------------------------------------------------------------
// Registry completeness — warn about SKILL.md.tmpl AskUserQuestion calls
// that don't appear to map to any registry entry.
//
// This is NOT a strict CI failure. Many AskUserQuestion invocations are
// dynamic (agent generates question text at runtime), which is fine — the
// agent picks the best-fitting registry id or generates an ad-hoc id.
//
// The test reports a count for visibility. A future enhancement will scan
// for specific question_id references in template prose and require those
// referenced ids to exist in the registry.
// -----------------------------------------------------------------------

describe('AskUserQuestion template coverage (informational)', () => {
  test('count of templates using AskUserQuestion is non-trivial', () => {
    const templates = findAllTemplates();
    const usingAsk = templates.filter((p) =>
      fs.readFileSync(p, 'utf-8').includes('AskUserQuestion'),
    );
    // At the time of writing, ~35 templates reference AskUserQuestion.
    // This sanity check catches an accidental global removal.
    expect(usingAsk.length).toBeGreaterThan(20);
  });

  test('registry covers >= 10 skills from template files', () => {
    const stats = getRegistryStats();
    expect(Object.keys(stats.by_skill).length).toBeGreaterThanOrEqual(10);
  });
});

// -----------------------------------------------------------------------
// One-way door classifier (belt-and-suspenders keyword fallback)
// -----------------------------------------------------------------------

describe('one-way-doors classifier', () => {
  test('registry lookup wins when question_id is known', () => {
    const result = classifyQuestion({ question_id: 'ship-test-failure-triage' });
    expect(result.oneWay).toBe(true);
    expect(result.reason).toBe('registry');

    const safeResult = classifyQuestion({ question_id: 'ship-changelog-voice-polish' });
    expect(safeResult.oneWay).toBe(false);
    expect(safeResult.reason).toBe('registry');
  });

  test('unknown question_id falls through to other checks', () => {
    const result = classifyQuestion({ question_id: 'some-ad-hoc-question-id' });
    expect(result.reason).not.toBe('registry');
  });

  test('keyword fallback catches destructive summaries', () => {
    const cases = [
      'Delete this directory and all its contents?',
      'Run rm -rf /tmp/scratch — proceed?',
      'Force-push main?',
      'git reset --hard origin/main — ok?',
      'DROP TABLE users — confirm?',
      'kubectl delete namespace prod',
      'terraform destroy the staging cluster',
      'rotate the API key',
      'breaking change to the public API — ship anyway?',
    ];
    for (const summary of cases) {
      const result = classifyQuestion({ summary });
      expect(result.oneWay).toBe(true);
      expect(result.reason).toBe('keyword');
      expect(result.matched).toBeDefined();
    }
  });

  test('skill-category fallback fires for cso:approval and land-and-deploy:approval', () => {
    expect(isOneWayDoor({ skill: 'cso', category: 'approval' })).toBe(true);
    expect(isOneWayDoor({ skill: 'land-and-deploy', category: 'approval' })).toBe(true);
  });

  test('benign questions default to two-way', () => {
    const benign = [
      'Want to update the changelog voice?',
      'Which mode should plan review use?',
      'Open the essay in your browser?',
    ];
    for (const summary of benign) {
      const result = classifyQuestion({ summary });
      expect(result.oneWay).toBe(false);
      expect(result.reason).toBe('default-two-way');
    }
  });

  test('keyword patterns are non-empty', () => {
    expect(DESTRUCTIVE_PATTERN_LIST.length).toBeGreaterThan(15);
  });

  test('skill-category set covers security + deploy', () => {
    expect(ONE_WAY_SKILL_CATEGORY_SET.has('cso:approval')).toBe(true);
    expect(ONE_WAY_SKILL_CATEGORY_SET.has('land-and-deploy:approval')).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Preamble injection — the QUESTION_TUNING section must appear for tier >=2
// -----------------------------------------------------------------------

describe('preamble — QUESTION_TUNING injection', () => {
  test('tier 2+ skills include the Question Tuning section', async () => {
    const { generatePreamble } = await import('../scripts/resolvers/preamble');
    const ctx = {
      skillName: 'test-skill',
      tmplPath: 'test.tmpl',
      host: 'claude' as const,
      paths: {
        skillRoot: '~/.claude/skills/gstack',
        localSkillRoot: '.claude/skills/gstack',
        binDir: '~/.claude/skills/gstack/bin',
        browseDir: '~/.claude/skills/gstack/browse/dist',
        designDir: '~/.claude/skills/gstack/design/dist',
      },
      preambleTier: 2,
    };
    const out = generatePreamble(ctx);
    expect(out).toContain('QUESTION_TUNING: $_QUESTION_TUNING');
    expect(out).toContain('## Question Tuning');
    expect(out).toContain('gstack-question-preference --check');
    expect(out).toContain('gstack-question-log');
    expect(out).toContain('profile-poisoning defense');
    expect(out).toContain('inline-user');
  });

  test('tier 1 skills do NOT include Question Tuning section', async () => {
    const { generatePreamble } = await import('../scripts/resolvers/preamble');
    const ctx = {
      skillName: 'test-skill',
      tmplPath: 'test.tmpl',
      host: 'claude' as const,
      paths: {
        skillRoot: '~/.claude/skills/gstack',
        localSkillRoot: '.claude/skills/gstack',
        binDir: '~/.claude/skills/gstack/bin',
        browseDir: '~/.claude/skills/gstack/browse/dist',
        designDir: '~/.claude/skills/gstack/design/dist',
      },
      preambleTier: 1,
    };
    const out = generatePreamble(ctx);
    // QUESTION_TUNING config echo still fires (it's in the bash block which all tiers get),
    // but the prose section should NOT be present for tier 1.
    expect(out).not.toContain('## Question Tuning');
  });

  test('codex host produces different paths', async () => {
    const { generateQuestionTuning } = await import('../scripts/resolvers/question-tuning');
    const codexCtx = {
      skillName: 'test',
      tmplPath: 'x',
      host: 'codex' as const,
      paths: {
        skillRoot: '$GSTACK_ROOT',
        localSkillRoot: '.agents/skills/gstack',
        binDir: '$GSTACK_BIN',
        browseDir: '$GSTACK_BROWSE',
        designDir: '$GSTACK_DESIGN',
      },
    };
    const out = generateQuestionTuning(codexCtx);
    expect(out).toContain('$GSTACK_BIN/gstack-question-preference');
    expect(out).toContain('$GSTACK_BIN/gstack-question-log');
  });
});

// -----------------------------------------------------------------------
// End-to-end: log → preference → derive pipeline
//
// Exercises the real binaries (not mocks) to make sure the schema contract
// between them actually holds.
// -----------------------------------------------------------------------

describe('end-to-end pipeline (binaries working together)', () => {
  test('log many expand choices → derive pushes scope_appetite up', () => {
    const tmpHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gstack-e2e-'));
    try {
      const env = { ...process.env, GSTACK_HOME: tmpHome };
      const { spawnSync } = require('child_process');
      const logBin = path.join(ROOT, 'bin', 'gstack-question-log');
      const devBin = path.join(ROOT, 'bin', 'gstack-developer-profile');

      for (let i = 0; i < 5; i++) {
        const r = spawnSync(
          logBin,
          [
            JSON.stringify({
              skill: 'plan-ceo-review',
              question_id: 'plan-ceo-review-mode',
              question_summary: 'mode?',
              user_choice: 'expand',
              session_id: `s${i}`,
              ts: `2026-04-0${i + 1}T10:00:00Z`,
            }),
          ],
          { env, cwd: ROOT, encoding: 'utf-8' },
        );
        expect(r.status).toBe(0);
      }

      const derive = spawnSync(devBin, ['--derive'], { env, cwd: ROOT, encoding: 'utf-8' });
      expect(derive.status).toBe(0);

      const profileOut = spawnSync(devBin, ['--profile'], { env, cwd: ROOT, encoding: 'utf-8' });
      const p = JSON.parse(profileOut.stdout);
      expect(p.inferred.sample_size).toBe(5);
      expect(p.inferred.values.scope_appetite).toBeGreaterThan(0.5);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('preference blocks tune: write from inline-tool-output in full pipeline', () => {
    const tmpHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gstack-e2e-'));
    try {
      const env = { ...process.env, GSTACK_HOME: tmpHome };
      const { spawnSync } = require('child_process');
      const prefBin = path.join(ROOT, 'bin', 'gstack-question-preference');

      const r = spawnSync(
        prefBin,
        [
          '--write',
          JSON.stringify({ question_id: 'fake-id', preference: 'never-ask', source: 'inline-tool-output' }),
        ],
        { env, cwd: ROOT, encoding: 'utf-8' },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('poisoning');

      // Verify no preference was written
      const read = spawnSync(prefBin, ['--read'], { env, cwd: ROOT, encoding: 'utf-8' });
      const prefs = JSON.parse(read.stdout);
      expect(prefs['fake-id']).toBeUndefined();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('migration preserves sessions, builder-profile shim still works', () => {
    const tmpHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gstack-e2e-'));
    try {
      const env = { ...process.env, GSTACK_HOME: tmpHome };
      const { spawnSync } = require('child_process');
      const devBin = path.join(ROOT, 'bin', 'gstack-developer-profile');
      const shimBin = path.join(ROOT, 'bin', 'gstack-builder-profile');

      // Seed a legacy file
      fs.writeFileSync(
        path.join(tmpHome, 'builder-profile.jsonl'),
        [
          { date: '2026-01-01', mode: 'builder', project_slug: 'x', signals: ['taste'] },
          { date: '2026-02-01', mode: 'startup', project_slug: 'x', signals: ['named_users'] },
          { date: '2026-03-01', mode: 'builder', project_slug: 'y', signals: ['agency'] },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
      );

      // Migrate
      const m = spawnSync(devBin, ['--migrate'], { env, cwd: ROOT, encoding: 'utf-8' });
      expect(m.status).toBe(0);

      // Legacy shim should still return the same KEY: VALUE shape
      const shimOut = spawnSync(shimBin, [], { env, cwd: ROOT, encoding: 'utf-8' });
      expect(shimOut.status).toBe(0);
      expect(shimOut.stdout).toContain('SESSION_COUNT: 3');
      expect(shimOut.stdout).toContain('TIER: welcome_back');
      expect(shimOut.stdout).toContain('CROSS_PROJECT: true');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

function findAllTemplates(): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and dotfiles
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && entry.name === 'SKILL.md.tmpl') {
        results.push(full);
      }
    }
  }
  walk(ROOT);
  return results;
}
