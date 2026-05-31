/**
 * Regression coverage for #1202 / #1694 — a direct ~/.claude/skills/gstack
 * checkout sits inside Claude/Cursor's recursive skill-discovery root, so every
 * generated host-mirror and source SKILL.md gets indexed (hundreds of phantom
 * skills; Claude drops descriptions, cursor-agent hard-freezes).
 *
 * setup's migrate_direct_claude_install + create_claude_runtime_root move the
 * checkout to ~/.gstack/repos/gstack and leave a runtime-only sidecar with
 * ZERO nested SKILL.md. These tests source those two functions straight out of
 * ./setup and exercise them against an isolated fake HOME — no real install is
 * touched and no full ./setup run (binary build / playwright) is needed.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SETUP = join(import.meta.dir, '..', 'setup');

// Run a bash snippet with the two setup functions sourced in, under a fresh
// fake HOME. Returns stdout (assertions are echoed as PASS/FAIL lines).
function runHarness(body: string): { out: string; code: number } {
  const home = mkdtempSync(join(tmpdir(), 'gstack-reloc-'));
  const script = `
set -u
export HOME='${home}'
log() { :; }
_link_or_copy() { ln -snf "$1" "$2"; }
eval "$(sed -n '/^migrate_direct_claude_install() {/,/^}/p' '${SETUP}')"
eval "$(sed -n '/^create_claude_runtime_root() {/,/^}/p' '${SETUP}')"

make_checkout() {
  local r="$1"; rm -rf "$r"
  mkdir -p "$r/.git" "$r/bin" "$r/scripts" "$r/browse/dist" "$r/review/specialists" "$r/plan-devex-review"
  printf '#!/bin/sh\\necho stub\\n' > "$r/bin/gstack-config"; chmod +x "$r/bin/gstack-config"
  : > "$r/ETHOS.md"; : > "$r/scripts/jargon-list.json"; : > "$r/review/checklist.md"
  : > "$r/plan-devex-review/dx-hall-of-fame.md"
  for s in office-hours ship review browse gstack-upgrade; do mkdir -p "$r/$s"; : > "$r/$s/SKILL.md"; done
  mkdir -p "$r/.cursor/skills/x"; : > "$r/.cursor/skills/x/SKILL.md"
}
${body}
`;
  const proc = spawnSync(['bash', '-c', script]);
  rmSync(home, { recursive: true, force: true });
  return { out: proc.stdout.toString(), code: proc.exitCode ?? 0 };
}

describe('migrate_direct_claude_install + create_claude_runtime_root (#1202)', () => {
  test('fresh global install relocates and builds a zero-SKILL.md sidecar', () => {
    const { out } = runHarness(`
      mkdir -p "$HOME/.claude/skills"
      make_checkout "$HOME/.claude/skills/gstack"
      SOURCE_GSTACK_DIR="$HOME/.claude/skills/gstack"; INSTALL_SKILLS_DIR="$HOME/.claude/skills"
      LOCAL_INSTALL=0; BROWSE_BIN=""; _CLAUDE_RELOCATED=0
      migrate_direct_claude_install
      create_claude_runtime_root "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR/gstack"
      echo "relocated=$_CLAUDE_RELOCATED"
      echo "moved=$([ -d "$HOME/.gstack/repos/gstack/.git" ] && echo 1 || echo 0)"
      echo "aliasRoot=$INSTALL_SKILLS_DIR"
      echo "nestedSkillMd=$(find "$HOME/.claude/skills/gstack" -name SKILL.md | wc -l | tr -d ' ')"
      echo "binResolves=$([ -x "$HOME/.claude/skills/gstack/bin/gstack-config" ] && echo 1 || echo 0)"
      echo "ethosResolves=$([ -e "$HOME/.claude/skills/gstack/ETHOS.md" ] && echo 1 || echo 0)"
    `);
    expect(out).toContain('relocated=1');
    expect(out).toContain('moved=1');
    expect(out).toContain(`aliasRoot=`);
    expect(out).toMatch(/aliasRoot=.*\/\.claude\/skills$/m);
    expect(out).toContain('nestedSkillMd=0');
    expect(out).toContain('binResolves=1');
    expect(out).toContain('ethosResolves=1');
  });

  test('re-run from the relocated path is idempotent and keeps the alias root', () => {
    const { out } = runHarness(`
      make_checkout "$HOME/.gstack/repos/gstack"
      SOURCE_GSTACK_DIR="$HOME/.gstack/repos/gstack"; INSTALL_SKILLS_DIR="$HOME/.gstack/repos"
      LOCAL_INSTALL=0; _CLAUDE_RELOCATED=0
      migrate_direct_claude_install
      echo "relocated=$_CLAUDE_RELOCATED"
      echo "aliasRoot=$INSTALL_SKILLS_DIR"
      echo "repoIntact=$([ -d "$HOME/.gstack/repos/gstack/.git" ] && echo 1 || echo 0)"
    `);
    expect(out).toContain('relocated=1');
    expect(out).toMatch(/aliasRoot=.*\/\.claude\/skills$/m);
    expect(out).toContain('repoIntact=1');
  });

  test('--local installs are never relocated', () => {
    const { out } = runHarness(`
      mkdir -p "$HOME/.claude/skills"
      make_checkout "$HOME/.claude/skills/gstack"
      SOURCE_GSTACK_DIR="$HOME/.claude/skills/gstack"; LOCAL_INSTALL=1; _CLAUDE_RELOCATED=0
      migrate_direct_claude_install
      echo "relocated=$_CLAUDE_RELOCATED"
      echo "stillThere=$([ -d "$HOME/.claude/skills/gstack/.git" ] && echo 1 || echo 0)"
    `);
    expect(out).toContain('relocated=0');
    expect(out).toContain('stillThere=1');
  });
});
