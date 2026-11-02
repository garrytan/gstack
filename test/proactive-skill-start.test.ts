/**
 * The PROACTIVE STATUS line (GSTA-93 fix 12, proactive core default): every
 * skill reads `PROACTIVE:` from bin/gstack-skill-start, which asks
 * bin/gstack-config and falls back to a literal when the config binary is
 * missing. The default moved from `true` to `core`.
 *
 * Value: protects=the PROACTIVE STATUS line a skill reads is one of core | all
 * | off: the stored value, core when unset, all/off for the legacy true/false
 * (quotes, case and a trailing comment tolerated), core for a value gstack does
 * not know, and the config default when gstack-config is missing beside the
 * script; and the off-only surfaces (the first-run and first-loop tips, the
 * CLAUDE.md routing offer) fire under core and not under off, by running the
 * script, and the offered routing section is the core four under core and every
 * rule under all; fails_when=gstack-skill-start stops consulting gstack-config, the
 * default moves back to true, a legacy or junk value leaks into STATUS, the
 * missing-config fallback literal drifts from lookup_default, or a tip or the
 * routing offer fires under off; why_new=proactive-config.test.ts exercises
 * gstack-config alone, gstack-skill-start.test.ts asserts only that the key is
 * emitted, and no test ran skill-start without gstack-config beside it;
 * seam=none (the fallback test copies the script next to an empty bin, the OV4
 * sanitize test's pattern); no_claim=how the model applies the value (prose,
 * not executed here)
 * Regression proof — fails at HEAD: yes · passes at base: yes · passes after fix: yes
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runBin } from './helpers/run-bin';
import { readShippedSkillRouting } from './helpers/shipped-skill-routing';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpHome: string;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-proactive-ss-home-'));
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function freshState(config: string): string {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-proactive-ss-state-'));
  fs.writeFileSync(path.join(state, 'config.yaml'), config);
  return state;
}

function runStart(script: string, state: string, cwd = tmpHome): string {
  const r = runBin(script, ['--skill', 'testskill'], {
    cwd,
    timeoutMs: 30_000,
    env: {
      PATH: process.env.PATH,
      // An interactive session: CI sets CI/GITHUB_ACTIONS, which gstack-session-kind reads
      // as headless, and headless skips first-task detection, so the tips never fire there.
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      HOME: tmpHome,
      GSTACK_HOME: state,
      GSTACK_STATE_DIR: state,
      GSTACK_LEASE_DIR: path.join(state, 'leases'),
    },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

const proactiveLine = (out: string) => out.match(/^PROACTIVE: (.*)$/m)?.[1];

describe('gstack-skill-start PROACTIVE status line', () => {
  test('carries core when nothing is stored, the stored value otherwise, the legacy true/false and the yes/no family as all/off, a quoted or upper-case hand edit normalized, and anything unknown as core', () => {
    const cases: Array<[string, string]> = [
      ['update_check: false\n', 'core'],
      ['update_check: false\nproactive: all\n', 'all'],
      ['update_check: false\nproactive: off\n', 'off'],
      ['update_check: false\nproactive: true\n', 'all'],
      ['update_check: false\nproactive: false\n', 'off'],
      ['update_check: false\nproactive: "off"\n', 'off'],
      ['update_check: false\nproactive: OFF # typed by hand\n', 'off'],
      ['update_check: false\nproactive: no\n', 'off'],
      ['update_check: false\nproactive: 0\n', 'off'],
      ['update_check: false\nproactive: none\n', 'off'],
      ['update_check: false\nproactive: yes\n', 'all'],
      ['update_check: false\nproactive: on\n', 'all'],
      ['update_check: false\nproactive: maybe\n', 'core'],
    ];
    for (const [config, expected] of cases) {
      const state = freshState(config);
      try {
        expect(proactiveLine(runStart(path.join(BIN, 'gstack-skill-start'), state)), config).toBe(expected);
      } finally {
        fs.rmSync(state, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test('the CLAUDE.md routing offer fires under core and not under off (the routing rules are the auto-invocation off turns off)', () => {
    const cases: Array<[string, boolean]> = [
      ['update_check: false\n', true],
      ['update_check: false\nproactive: off\n', false],
      ['update_check: false\nproactive: false\n', false],
    ];
    for (const [config, offered] of cases) {
      const state = freshState(config);
      fs.writeFileSync(path.join(state, '.proactive-prompted'), '');
      try {
        const out = runStart(path.join(BIN, 'gstack-skill-start'), state);
        expect(out, config).toContain('HAS_ROUTING: no');
        expect(out.includes('GSTACK_INSTRUCTION_BEGIN: routing-injection '), config).toBe(offered);
      } finally {
        fs.rmSync(state, { recursive: true, force: true });
      }
    }
  });

  test('the offered section follows the setting: core offers the four core rules and the scoping line, all offers every rule (#3446)', () => {
    const offered = (config: string): string => {
      const state = freshState(config);
      fs.writeFileSync(path.join(state, '.proactive-prompted'), '');
      try {
        const out = runStart(path.join(BIN, 'gstack-skill-start'), state);
        const block = out.slice(out.indexOf('GSTACK_INSTRUCTION_BEGIN: routing-injection '));
        return block.slice(block.indexOf('## Skill routing\n'), block.indexOf('\nIf B:')).trim();
      } finally {
        fs.rmSync(state, { recursive: true, force: true });
      }
    };
    const rulesOf = (section: string) => section.split('\n').filter(line => /^- .+→ invoke \//.test(line));
    const shipped = readShippedSkillRouting();
    const core = offered('update_check: false\n');
    expect(rulesOf(core)).toEqual([
      '- Product ideas/brainstorming → invoke /office-hours',
      '- QA/testing site behavior → invoke /qa',
      '- Code review/diff check → invoke /review',
      '- Ship/deploy/PR → invoke /ship',
    ]);
    expect(core).toContain('Do not suggest or auto-invoke other gstack skills: they run when the user types them, or when a running skill hands off to them (`gstack-config set proactive all` routes every skill).');
    expect(core.split('\n').filter(line => line.includes('→'))).toEqual(rulesOf(core));
    expect(core.startsWith(shipped.instruction)).toBe(true);
    for (const config of ['update_check: false\nproactive: all\n', 'update_check: false\nproactive: true\n']) {
      expect(offered(config), config).toBe(shipped.section);
    }
    expect(rulesOf(shipped.section).length).toBeGreaterThan(4);
  }, 60_000);

  test('a stored off answers the one-time proactive prompt: no prompt block, marker written; core still asks once telemetry was answered', () => {
    const cases: Array<[string, boolean]> = [
      ['update_check: false\ntelemetry: off\n', true],
      ['update_check: false\ntelemetry: off\nproactive: off\n', false],
    ];
    for (const [config, asked] of cases) {
      const state = freshState(config);
      fs.writeFileSync(path.join(state, '.telemetry-prompted'), '');
      try {
        const out = runStart(path.join(BIN, 'gstack-skill-start'), state);
        expect(out.includes('GSTACK_INSTRUCTION_BEGIN: proactive-prompt'), config).toBe(asked);
        expect(fs.existsSync(path.join(state, '.proactive-prompted')), config).toBe(!asked);
        expect(out, config).toContain(`PROACTIVE_PROMPTED: ${asked ? 'no' : 'yes'}`);
      } finally {
        fs.rmSync(state, { recursive: true, force: true });
      }
    }
  });

  test('the first-run and first-loop tips are shown under core and suppressed under off/false (the marker is not written either)', () => {
    const cases: Array<[string, boolean]> = [
      ['update_check: false\n', true],
      ['update_check: false\nproactive: off\n', false],
      ['update_check: false\nproactive: false\n', false],
    ];
    for (const [config, shown] of cases) {
      const state = freshState(config);
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-proactive-ss-repo-'));
      execFileSync('git', ['init', '-q'], { cwd: repo, timeout: 30_000 });
      try {
        const first = runStart(path.join(BIN, 'gstack-skill-start'), state, repo);
        expect(first, config).toContain('FIRST_TASK: greenfield');
        expect(first.includes('GSTACK_INSTRUCTION_BEGIN: first-run-tip'), config).toBe(shown);
        const second = runStart(path.join(BIN, 'gstack-skill-start'), state, repo);
        expect(second.includes('GSTACK_INSTRUCTION_BEGIN: first-loop-tip'), config).toBe(shown);
        expect(fs.existsSync(path.join(state, '.first-loop-tip-shown')), config).toBe(shown);
      } finally {
        fs.rmSync(state, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test('regression: with no gstack-config beside it, the fallback reports the config default, not a stale literal', () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-proactive-ss-bin-'));
    const state = freshState('update_check: false\n');
    try {
      for (const f of ['gstack-skill-start', 'gstack-state-root.sh']) fs.copyFileSync(path.join(BIN, f), path.join(fakeBin, f));
      fs.chmodSync(path.join(fakeBin, 'gstack-skill-start'), 0o755);
      const configDefault = runBin(path.join(BIN, 'gstack-config'), ['get', 'proactive'], { gstackHome: state, cwd: ROOT, trim: true }).stdout;
      expect(configDefault).not.toBe('');
      expect(proactiveLine(runStart(path.join(fakeBin, 'gstack-skill-start'), state))).toBe(configDefault);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});
