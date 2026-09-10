/**
 * Routing probe + team-init install resolution — gate-tier tests (#2500).
 *
 * 1. The preamble's HAS_ROUTING probe must check AGENTS.md as well as
 *    CLAUDE.md. Non-Claude hosts (Codex, Cursor, generic harnesses) route
 *    skills via AGENTS.md — the cross-harness convention file. Before this
 *    fix, a repo with AGENTS.md routing but no CLAUDE.md reported
 *    HAS_ROUTING: no and got nagged to create CLAUDE.md.
 *
 * 2. gstack-team-init's required-mode enforcement (the CLAUDE.md
 *    verification snippet and the generated check-gstack.sh hook) must
 *    resolve the install root across GSTACK_ROOT + every host's global
 *    install location, never hardcode ~/.claude/skills/gstack. The drift
 *    test pins the probe list against the hosts registry so a new host
 *    can't silently fall out of team-mode enforcement.
 *
 * Re-derived from community PR #2500 by @gamerey43.
 */
import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_PATHS } from '../scripts/resolvers/types';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generatePreambleBash } from '../scripts/resolvers/preamble/generate-preamble-bash';
import { ALL_HOST_CONFIGS } from '../hosts/index';

const ROOT = path.join(import.meta.dir, '..');

function makeCtx(host: 'claude' | 'codex'): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host,
    paths: HOST_PATHS[host],
    preambleTier: 2,
  };
}

// Token-reduction Phase 1: the probe bash moved from the rendered preamble
// into bin/gstack-skill-start (invoked by every host's preamble fence). The
// probe block under test is extracted from the LIVE script bytes.
const SKILL_START_SCRIPT = fs.readFileSync(
  path.join(ROOT, 'bin', 'gstack-skill-start'),
  'utf-8',
);

/** Extract the routing-probe block from the skill-start script. */
function extractRoutingProbe(scriptText: string): string {
  const start = scriptText.indexOf('_HAS_ROUTING="no"');
  expect(start).toBeGreaterThan(-1);
  const end = scriptText.indexOf('done', start);
  expect(end).toBeGreaterThan(start);
  return scriptText.slice(start, end + 'done'.length);
}

describe('routing probe checks AGENTS.md too (#2500)', () => {
  for (const host of ['claude', 'codex'] as const) {
    test(`preamble reaches the CLAUDE.md AND AGENTS.md probe (${host})`, () => {
      // The render must invoke the script that owns the probe...
      const rendered = generatePreambleBash(makeCtx(host));
      expect(rendered).toContain('gstack-skill-start');
      // ...and the probe must cover both convention files.
      const probe = extractRoutingProbe(SKILL_START_SCRIPT);
      expect(probe).toContain('CLAUDE.md');
      expect(probe).toContain('AGENTS.md');
    });
  }

  test('live probe block: AGENTS.md-only repo reports HAS_ROUTING=yes', () => {
    const probe = extractRoutingProbe(SKILL_START_SCRIPT);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-probe-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'AGENTS.md'),
        '## Skill routing\n\n- Bugs → /investigate\n',
      );
      const out = execSync(
        `bash -c '${probe.replace(/'/g, `'\\''`)}\necho "HAS_ROUTING: $_HAS_ROUTING"'`,
        { cwd: dir, encoding: 'utf-8', timeout: 30_000 },
      );
      expect(out).toContain('HAS_ROUTING: yes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('live probe block: repo with neither file reports HAS_ROUTING=no', () => {
    const probe = extractRoutingProbe(SKILL_START_SCRIPT);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-probe-'));
    try {
      const out = execSync(
        `bash -c '${probe.replace(/'/g, `'\\''`)}\necho "HAS_ROUTING: $_HAS_ROUTING"'`,
        { cwd: dir, encoding: 'utf-8', timeout: 30_000 },
      );
      expect(out).toContain('HAS_ROUTING: no');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('team-init resolves GSTACK_ROOT across every host (#2500)', () => {
  const teamInit = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-team-init'), 'utf-8');

  test('probe list covers GSTACK_ROOT env + every registered host globalRoot + migrated repo', () => {
    expect(teamInit).toContain('"${GSTACK_ROOT:-}"');
    for (const config of ALL_HOST_CONFIGS) {
      expect(teamInit).toContain(`$HOME/${config.globalRoot}`);
    }
    expect(teamInit).toContain('$HOME/.gstack/repos/gstack');
  });

  test('enforcement no longer hardcodes the Claude path as the only gate', () => {
    expect(teamInit).not.toContain('test -d ~/.claude/skills/gstack/bin');
    expect(teamInit).not.toContain('if [ ! -d "$HOME/.claude/skills/gstack/bin" ]');
  });

  test('generated hook blocks only when NO install root resolves', () => {
    // The hook's block branch must gate on the resolved root being empty,
    // not on any single hardcoded directory.
    expect(teamInit).toContain('if [ -z "$_GSTACK_ROOT" ]; then');
  });
});
