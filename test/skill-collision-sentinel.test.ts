/**
 * Collision Sentinel — insurance policy against upstream slash-command collisions.
 *
 * History: in April 2026 Claude Code shipped /checkpoint as a native alias
 * for /rewind, silently shadowing the gstack /checkpoint skill. Users
 * typed /checkpoint expecting to save state; agents routed to the built-in
 * or confabulated "this is a built-in you need to type directly" and nothing
 * was saved. We found out from users, not from tests.
 *
 * This file is the "never again" test. It enumerates every gstack skill name
 * from every SKILL.md.tmpl file in the repo and cross-checks against a
 * per-host list of known built-in slash commands. If any gstack skill name
 * collides with a host built-in, this test fails and names the collision.
 *
 * Maintenance: when Claude Code (or any other host we support) ships a new
 * built-in slash command, add the name to the host's KNOWN_BUILTINS list
 * below. If a gstack skill needs to coexist with a built-in anyway (e.g.,
 * we decide the semantic overlap is acceptable), add it to
 * KNOWN_COLLISIONS_TOLERATED with a written justification.
 *
 * Free tier. ~50ms runtime.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// ─── Host built-in registries ──────────────────────────────────────────────
//
// One const per host we support. Names are the slash-command identifier WITHOUT
// the leading slash. Keep sorted alphabetically within each host so diffs are
// reviewable. Cite the source (docs URL, release notes, or "observed") in the
// comment next to each entry — future maintainers need to know why an entry
// is on the list.

const KNOWN_BUILTINS: Record<string, string[]> = {
  'claude-code': [
    // Slash commands observed in 'claude --help' or cited in docs as of 2026-04.
    // Sources:
    //   https://code.claude.com/docs/en/checkpointing
    //   https://claudelog.com/mechanics/rewind/
    //   claude --help output
    //   Claude Code skill list dumps from live sessions
    'agents',         // Agent config
    'bare',           // Minimal mode
    'checkpoint',     // Alias of /rewind (the collision that started this file)
    'clear',          // Clear the conversation
    'compact',        // Context compaction
    'config',         // Config UI
    'context',        // Context usage display
    'continue',       // --continue / resume last conversation
    'cost',           // Cost display
    'exit',           // Exit shell
    'help',           // Help
    'init',           // Initialize a new CLAUDE.md file
    'mcp',            // MCP server config
    'model',          // Model selection
    'permissions',    // Permission config
    'plan',           // Plan mode toggle (also Shift+Tab)
    'quit',           // Quit
    'review',         // Review a pull request (BUILT-IN shipped in 2026)
    'rewind',         // Conversation rewind
    'security-review', // Security audit of pending changes
    'stats',          // Session stats
    'usage',          // API usage stats
  ],
  // Add codex/kiro/opencode/slate/cursor/openclaw/hermes/factory/gbrain
  // built-in lists when we encounter collisions. Claude Code is the primary
  // shadow risk because it's the biggest audience and ships the most
  // frequently; other hosts collide less often.
  // TODO: codex CLI built-ins (login, logout, exec, review, etc. — but we
  // invoke codex from gstack, we don't install skills INTO codex the same
  // way, so this is lower priority).
};

// Collisions we know about and have consciously decided to tolerate. The
// justification is mandatory — reviewers need the context next time the
// user reports confusion, and blind additions to this map should fail code
// review.
const KNOWN_COLLISIONS_TOLERATED: Record<string, string> = {
  // skill name → one-line justification + action plan
  'review': 'gstack /review (pre-landing diff analysis) pre-dates the Claude Code built-in /review (Review a pull request). The gstack skill is much richer (SQL safety, LLM trust boundary, specialist dispatch). Watch for user confusion reports and consider renaming to /diff-review or /pre-land if the collision bites. TODO: track user-reported incidents in TODOS.md.',
};

// Generic-verb watchlist: skill names that are single common verbs, which
// are at higher risk of being claimed by a future host built-in. Advisory
// only — the test prints a warning but doesn't fail. If a name here stops
// being safe, move it to the appropriate host's KNOWN_BUILTINS list.
const GENERIC_VERB_WATCHLIST = [
  'save', 'load', 'run', 'test', 'build', 'deploy',
  'fork', 'branch', 'commit', 'push', 'pull', 'merge', 'rebase',
  'start', 'stop', 'restart', 'reset', 'pause', 'resume',
  'show', 'list', 'find', 'search', 'view',
  'create', 'delete', 'remove', 'update', 'rename',
  'login', 'logout', 'auth',
];

// ─── Enumerator ────────────────────────────────────────────────────────────

interface GstackSkill {
  name: string;
  templatePath: string;
}

function enumerateGstackSkills(): GstackSkill[] {
  const skills: GstackSkill[] = [];
  // Scan one level deep for */SKILL.md.tmpl plus root SKILL.md.tmpl.
  const candidates = [
    path.join(ROOT, 'SKILL.md.tmpl'),
    ...fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(ROOT, d.name, 'SKILL.md.tmpl')),
  ];
  for (const tmpl of candidates) {
    if (!fs.existsSync(tmpl)) continue;
    const content = fs.readFileSync(tmpl, 'utf-8');
    // Parse the 'name:' field from YAML frontmatter.
    const frontmatter = content.match(/^---\n([\s\S]+?)\n---/);
    if (!frontmatter) continue;
    const nameMatch = frontmatter[1].match(/^name:\s*(\S+)/m);
    if (!nameMatch) continue;
    skills.push({ name: nameMatch[1].trim(), templatePath: tmpl });
  }
  return skills;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('skill-collision-sentinel', () => {
  const skills = enumerateGstackSkills();

  test('at least one skill is discovered (sanity)', () => {
    // If this fails, the enumerator broke, not the collision check.
    expect(skills.length).toBeGreaterThan(10);
  });

  test('no duplicate skill names within gstack', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const { name, templatePath } of skills) {
      if (seen.has(name)) {
        dupes.push(`${name} appears in both ${seen.get(name)} and ${templatePath}`);
      } else {
        seen.set(name, templatePath);
      }
    }
    if (dupes.length > 0) {
      throw new Error(`Duplicate skill names:\n  ${dupes.join('\n  ')}`);
    }
  });

  // Hard check: no gstack skill name collides with a known host built-in
  // unless the collision is explicitly tolerated. This is the test that
  // would have caught the /checkpoint bug in April 2026.
  for (const [host, builtins] of Object.entries(KNOWN_BUILTINS)) {
    test(`no skill name collides with a ${host} built-in (or has written justification)`, () => {
      const builtinSet = new Set(builtins);
      const collisions: Array<{ skill: string; builtin: string }> = [];
      for (const { name } of skills) {
        if (builtinSet.has(name) && !(name in KNOWN_COLLISIONS_TOLERATED)) {
          collisions.push({ skill: name, builtin: name });
        }
      }
      if (collisions.length > 0) {
        const msg = collisions.map(c =>
          `  /${c.skill} collides with ${host} built-in /${c.builtin}.\n` +
          `    Fix: rename the gstack skill (precedent: /checkpoint → /context-save+/context-restore),\n` +
          `    OR add an entry to KNOWN_COLLISIONS_TOLERATED with a written justification.`
        ).join('\n\n');
        throw new Error(`Found ${collisions.length} unresolved collision(s) with ${host} built-ins:\n\n${msg}`);
      }
    });
  }

  // Every KNOWN_COLLISIONS_TOLERATED entry must correspond to a real skill
  // AND a real built-in. Prevents the exception list from rotting with
  // stale entries after a rename.
  test('KNOWN_COLLISIONS_TOLERATED entries are all still active collisions', () => {
    const skillNames = new Set(skills.map(s => s.name));
    const allBuiltins = new Set<string>();
    for (const list of Object.values(KNOWN_BUILTINS)) {
      for (const name of list) allBuiltins.add(name);
    }
    const stale: string[] = [];
    for (const name of Object.keys(KNOWN_COLLISIONS_TOLERATED)) {
      if (!skillNames.has(name)) {
        stale.push(`  "${name}" is in KNOWN_COLLISIONS_TOLERATED but no gstack skill has that name — remove the exception`);
      } else if (!allBuiltins.has(name)) {
        stale.push(`  "${name}" is in KNOWN_COLLISIONS_TOLERATED but no host's KNOWN_BUILTINS lists it — remove the exception`);
      }
    }
    if (stale.length > 0) {
      throw new Error(`Stale tolerance entries:\n${stale.join('\n')}`);
    }
  });

  // Self-check: the /checkpoint rename actually landed. If someone reverts
  // the rename by accident, this catches it.
  test('the /checkpoint collision that started this file is actually resolved', () => {
    const names = new Set(skills.map(s => s.name));
    expect(names.has('checkpoint')).toBe(false);
    // And the replacements exist.
    expect(names.has('context-save')).toBe(true);
    expect(names.has('context-restore')).toBe(true);
  });

  // Advisory: print a warning for any skill whose name is a generic verb.
  // Doesn't fail — just informs reviewers.
  test('advisory: generic-verb watchlist (informational)', () => {
    const watchlist = new Set(GENERIC_VERB_WATCHLIST);
    const flagged: string[] = [];
    for (const { name } of skills) {
      if (watchlist.has(name)) flagged.push(name);
    }
    if (flagged.length > 0) {
      console.log(
        `\n⚠️  advisory: ${flagged.length} skill(s) use generic verbs that may be at risk ` +
        `of future host built-in collisions: ${flagged.map(n => `/${n}`).join(', ')}\n` +
        `   These are NOT current collisions — they're names to watch. If any become ` +
        `taken, the per-host test above will fail.\n`
      );
    }
    // Test always passes — this is advisory.
    expect(true).toBe(true);
  });
});
