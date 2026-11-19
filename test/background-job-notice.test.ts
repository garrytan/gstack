/**
 * Background-job notice (R115): before gstack adds anything that keeps running
 * or shows up on the user's machine (a launch agent, systemd unit, crontab
 * line, login item or browser extension), it tells them in one line what it
 * is called, what it does, where they'll see it and how to remove it:
 *
 *   Adding a <kind> called <label> that <what it does>. You'll see it <where>.
 *   Remove it with: <exact command>
 *
 * Each path that adds one has its own test below, and a repo-wide scan fails
 * when a new install step appears without that line just above it.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const INSTALL_STEPS: RegExp[] = [
  /launchctl\s+(load|bootstrap|enable)\b/,
  /systemctl\s+--user\s+(enable|start)\b/,
  /\bcrontab\s+(?!-l\b|-r\b)\S/,
  /autopilot\s+--install\b/,
  /Load unpacked/,
  /SMAppService|LSSharedFileList/,
  /Library\/LaunchAgents/,
  /devicectl\s+device\s+install\b/,
];

const NO_NOTICE_NEEDED: Record<string, { line: string; why: string }> = {
  'bin/gstack-gbrain-source-wireup': {
    line: 'PLIST_PATH="$HOME/Library/LaunchAgents/com.gstack.brain-sync.plist"',
    why: 'only removes ~/Library/LaunchAgents/com.gstack.brain-sync.plist on --uninstall; no gstack version writes it (checked below)',
  },
  'lib/gbrain-guards.ts': {
    line: '`\\`gbrain autopilot --install\\` set one up), or end the process that only mentions it`,',
    why: 'names an existing gbrain autopilot install in a refusal message; installs nothing',
  },
  'open-gstack-browser/SKILL.md.tmpl': {
    line: '> 4. If it\'s NOT listed at all, click **"Load unpacked"** and navigate to:',
    why: "its fallback loads gstack browse into gstack's own browser, which the user just opened; nothing goes into their regular Chrome",
  },
};

const SCANNED = /^(bin\/|lib\/|scripts\/|browse\/src\/|design\/src\/|ios-qa\/daemon\/src\/|make-pdf\/src\/|gstack-upgrade\/|setup$|CLAUDE\.md$|.*\.tmpl$)/;
const NOTICE_WINDOW = 12;

function hasNoticeAbove(lines: string[], i: number): boolean {
  const window = lines.slice(Math.max(0, i - NOTICE_WINDOW), i + 1).join('\n');
  return /Adding a /.test(window) && /Remove it\s+with:/.test(window);
}

function trackedFiles(): string[] {
  const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  expect(r.status).toBe(0);
  return r.stdout.split('\n').filter(f => f && SCANNED.test(f) && !f.includes('/test/'));
}

describe('background-job notice (R115)', () => {
  test('every install step in shipped code has the notice line just above it', () => {
    const missing: string[] = [];
    for (const rel of trackedFiles()) {
      const abs = path.join(ROOT, rel);
      if (!fs.statSync(abs).isFile()) continue;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (NO_NOTICE_NEEDED[rel]?.line === line.trim()) return;
        if (INSTALL_STEPS.some(re => re.test(line)) && !hasNoticeAbove(lines, i)) {
          missing.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(missing).toEqual([]);
  });

  test('each exemption still names a real install-step line in its file', () => {
    for (const [rel, { line }] of Object.entries(NO_NOTICE_NEEDED)) {
      expect(INSTALL_STEPS.some(re => re.test(line))).toBe(true);
      expect(read(rel).split('\n').map(l => l.trim())).toContain(line);
    }
  });

  test('sync-gbrain tells the user about com.gbrain.autopilot before installing it', () => {
    for (const rel of ['sync-gbrain/SKILL.md.tmpl', 'sync-gbrain/SKILL.md', 'CLAUDE.md']) {
      const text = read(rel).replace(/\s+/g, ' ');
      const notice = text.indexOf('Adding a background job called com.gbrain.autopilot');
      const install = text.indexOf('gbrain autopilot --install');
      expect(notice).toBeGreaterThan(-1);
      expect(install).toBeGreaterThan(notice);
      const line = text.slice(notice, install);
      expect(line).toContain("You'll see it under System Settings → General → Login Items");
      expect(line).toContain('Remove it with: gbrain autopilot --uninstall');
    }
  });

  test.skipIf(process.platform === 'win32')('gstack-extension prints the notice before opening chrome://extensions', () => {
    const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-notice-'));
    try {
      for (const name of ['osascript', 'open']) {
        fs.writeFileSync(path.join(stubs, name), '#!/bin/sh\necho STUB-OPENED-CHROME-EXTENSIONS\n', { mode: 0o755 });
      }
      fs.writeFileSync(path.join(stubs, 'pbcopy'), '#!/bin/sh\ncat >/dev/null\n', { mode: 0o755 });
      const r = spawnSync('bash', [path.join(ROOT, 'bin/gstack-extension')], {
        encoding: 'utf8',
        env: { HOME: stubs, PATH: `${stubs}:/usr/bin:/bin` },
        timeout: 30_000,
      });
      expect(r.status).toBe(0);
      const notice = r.stdout.indexOf('Adding a Chrome extension called gstack browse');
      expect(notice).toBeGreaterThan(-1);
      expect(r.stdout).toContain('Remove it with: chrome://extensions → gstack browse → Remove');
      expect(r.stdout.indexOf('STUB-OPENED-CHROME-EXTENSIONS')).toBeGreaterThan(notice);
      expect(r.stdout.indexOf("Click 'Load unpacked'")).toBeGreaterThan(notice);
      const manifest = JSON.parse(read('extension/manifest.json'));
      expect(manifest.name).toBe('gstack browse');
    } finally {
      fs.rmSync(stubs, { recursive: true, force: true });
    }
  });

  test('gstack-gbrain-source-wireup never writes its launch agent plist, and --uninstall removes it', () => {
    const lines = read('bin/gstack-gbrain-source-wireup').split('\n').filter(l => l.includes('PLIST_PATH'));
    const uses = lines.map(l => l.trim()).filter(l => !l.startsWith('#'));
    expect(uses).toEqual([
      'PLIST_PATH="$HOME/Library/LaunchAgents/com.gstack.brain-sync.plist"',
      'rm -f "$PLIST_PATH" 2>/dev/null || true',
    ]);
    expect(read('bin/gstack-gbrain-source-wireup')).not.toMatch(/launchctl/);
  });
});
