import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const CONFIG_BIN = path.join(ROOT, 'bin', 'gstack-config');

// gstack-config accepts arbitrary keys (free-form YAML store), so we can't
// build an authoritative set of "valid keys" from the script. Instead, defend
// the specific invariant this wave introduces: deprecated keys must not
// reappear in user-facing docs. Extend the denylist as future renames happen.
const DEPRECATED_KEYS = new Set<string>([
  // Renamed to artifacts_sync_mode in v1.27.0.0, doc references re-deprecated
  // in v1.36.0.0 alongside the same rename of *_prompted.
  'gbrain_sync_mode',
  'gbrain_sync_mode_prompted',
]);

function scanDocsForConfigKeys(): { docPath: string; key: string; line: number }[] {
  const hits: { docPath: string; key: string; line: number }[] = [];
  const docsDir = path.join(ROOT, 'docs');
  // Recurse docs/ but skip dotfiles. CHANGELOG.md/TODOS.md are excluded by virtue
  // of being top-level; we only scan docs/**.
  const stack = [docsDir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.name.endsWith('.md')) continue;
      const text = fs.readFileSync(full, 'utf-8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        // Match `gstack-config set <key>` or `gstack-config get <key>`.
        for (const m of line.matchAll(/gstack-config\s+(?:set|get)\s+([a-z][a-z0-9_]*)/g)) {
          hits.push({ docPath: full, key: m[1], line: idx + 1 });
        }
      });
    }
  }
  return hits;
}

function runConfig(args: string[], tmpHome: string) {
  return spawnSync(CONFIG_BIN, args, {
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpHome, GSTACK_HOME: tmpHome },
    timeout: 5000,
  });
}

describe('docs ↔ gstack-config key drift guard', () => {
  test('docs/ references at least one config key (smoke)', () => {
    const hits = scanDocsForConfigKeys();
    expect(hits.length).toBeGreaterThan(0);
  });

  test('no doc references a deprecated config key', () => {
    const hits = scanDocsForConfigKeys();
    const stale = hits.filter((h) => DEPRECATED_KEYS.has(h.key));
    if (stale.length > 0) {
      console.error('Deprecated config keys referenced in docs:', stale);
    }
    expect(stale).toEqual([]);
  });

  // gstack-config is a bash script; Windows can't exec it via spawnSync
  // without a Git Bash interpreter shim. Skip on Windows — the deprecated-key
  // denylist test above already pins the v1.27.0.0 rename behavior at the
  // doc layer, which is the actual invariant this wave defends.
  test.skipIf(process.platform === 'win32')('`explain_level` is exposed as a documented default', () => {
    const tmpHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gstack-cfg-'));
    try {
      const get = runConfig(['get', 'explain_level'], tmpHome);
      expect(get.status).toBe(0);
      expect(get.stdout.trim()).toBe('default');

      const defaults = runConfig(['defaults'], tmpHome);
      expect(defaults.status).toBe(0);
      expect(defaults.stdout).toContain('explain_level:');
      expect(defaults.stdout).toContain('default');

      const list = runConfig(['list'], tmpHome);
      expect(list.status).toBe(0);
      expect(list.stdout).toContain('explain_level:');
      expect(list.stdout).toContain('default');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('`gstack-config get artifacts_sync_mode` returns a value (the rename landed)', () => {
    // Run from a clean HOME so the user's local config doesn't pollute.
    const tmpHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gstack-cfg-'));
    try {
      const result = runConfig(['get', 'artifacts_sync_mode'], tmpHome);
      expect(result.status).toBe(0);
      // A known key returns its default value, not the "unknown key" error string.
      expect(result.stderr).not.toContain('not recognized');
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
