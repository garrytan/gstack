/**
 * Static tripwire for #1835: child spawns reachable on Windows must pass
 * windowsHide, or every daemon relaunch / taskkill / icacls / powershell
 * invocation flashes a black console window (and can steal focus).
 *
 * Source-level, same style as server-auth.test.ts / cdp-session-cleanup.test.ts:
 * cheap, deterministic, runs on every platform.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SRC = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf-8');

/** Every occurrence of `needle` in `src` must have `windowsHide` within the
 * next `window` chars (the spawn's options object). */
function expectHideNearEvery(src: string, needle: string, window = 400): void {
  let idx = src.indexOf(needle);
  expect(idx).toBeGreaterThanOrEqual(0);
  while (idx !== -1) {
    const slice = src.slice(idx, idx + window);
    expect(slice).toMatch(/windowsHide:\s*true/);
    idx = src.indexOf(needle, idx + needle.length);
  }
}

describe('windowsHide on Windows-reachable spawns (#1835)', () => {
  test('daemon launch paths in cli.ts pass windowsHide', () => {
    const cli = SRC('cli.ts');
    // Installed path: node -e launcher — both the outer spawnSync and the
    // inner detached daemon spawn (inside the launcher code string).
    expect(cli).toContain('detached:true,windowsHide:true');
    expectHideNearEvery(cli, "'-e', launcherCode]");
    // Dev fallback: detached bun spawn.
    expectHideNearEvery(cli, "nodeSpawn('bun'");
    // taskkill (killServer).
    expectHideNearEvery(cli, "'taskkill'");
  });

  test('Windows-only process probes pass windowsHide', () => {
    // isProcessAlive no longer spawns anything (signal-0 on every platform,
    // #1952) — process-liveness-windows.test.ts pins that it stays
    // subprocess-free, which is stronger than hiding a window.
    // powershell DPAPI + tasklist in cookie import.
    const cookie = SRC('cookie-import-browser.ts');
    expectHideNearEvery(cookie, "'powershell'");
    expectHideNearEvery(cookie, "'tasklist'");
  });

  test('icacls calls in file-permissions.ts pass windowsHide', () => {
    const perms = SRC('file-permissions.ts');
    expect((perms.match(/'icacls'/g) || []).length).toBeGreaterThanOrEqual(3);
    expectHideNearEvery(perms, "'icacls'");
  });

  test('terminal-agent respawn in terminal-agent-control.ts passes windowsHide', () => {
    // The CLI cold-start + v1.44 watchdog respawn path. On Windows it runs
    // through the Node polyfill (dist/bun-polyfill.cjs) whose host default is
    // the opposite of Bun's — a visible console window on every watchdog
    // respawn is the symptom when the flag is dropped. Wider window: the
    // spawn's options object carries the full env wiring before the flag.
    expectHideNearEvery(SRC('terminal-agent-control.ts'), '(Bun as any).spawn(', 700);
  });

  test('SWEEP: every direct child_process call in src/ passes windowsHide (#2160, #2415)', () => {
    // Full-census tripwire: a NEW child_process call site without windowsHide
    // fails CI. Each exemption carries a reason — an interactive console
    // child must NOT get CREATE_NO_WINDOW.
    const EXEMPT: Array<{ file: string; needle: string; reason: string }> = [
      {
        file: 'domain-skill-commands.ts',
        needle: 'spawnSync(editor',
        reason: "interactive $EDITOR with stdio:'inherit' — windowsHide would detach a console editor into an invisible console",
      },
    ];

    const srcDir = path.join(import.meta.dir, '../src');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const raw = fs.readFileSync(path.join(srcDir, file), 'utf-8');
      if (!raw.includes('child_process')) continue;
      // Strip comments so documented history doesn't trip the census.
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // Collect the callable names this file binds to child_process:
      //   import { spawn as nodeSpawn } from 'child_process'
      //   const { execSync } = await import('child_process') / require(...)
      //   import * as cp from 'child_process'  → cp.<fn>( pattern
      const names = new Set<string>();
      const namespaces = new Set<string>();
      const importRe = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g;
      const dynRe = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+import\(|require\()['"](?:node:)?child_process['"]\)/g;
      const nsRe = /import\s*\*\s*as\s*(\w+)\s*from\s*['"](?:node:)?child_process['"]/g;
      for (const m of code.matchAll(importRe)) {
        for (const part of m[1].split(',')) {
          const alias = part.split(/\s+as\s+/).map((s) => s.trim()).filter(Boolean);
          const name = alias[alias.length - 1];
          if (name && /^(spawn|spawnSync|exec|execSync|execFile|execFileSync|nodeSpawn|cpSpawn)/.test(alias[0].trim())) names.add(name);
        }
      }
      for (const m of code.matchAll(dynRe)) {
        for (const part of m[1].split(',')) {
          const alias = part.split(':').map((s) => s.trim()).filter(Boolean);
          const name = alias[alias.length - 1];
          if (name && /^(spawn|spawnSync|exec|execSync|execFile|execFileSync)/.test(alias[0].trim())) names.add(name);
        }
      }
      for (const m of code.matchAll(nsRe)) namespaces.add(m[1]);

      const patterns: RegExp[] = [];
      for (const n of names) patterns.push(new RegExp(`(?<![.\\w'"\`])${n}\\(`, 'g'));
      for (const ns of namespaces) {
        patterns.push(new RegExp(`(?<![\\w'"\`])${ns}\\.(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\\(`, 'g'));
      }

      for (const re of patterns) {
        for (const m of code.matchAll(re)) {
          const slice = code.slice(m.index!, m.index! + 700);
          const exempt = EXEMPT.some((e) => e.file === file && slice.startsWith(e.needle));
          if (exempt) continue;
          if (!/windowsHide:\s*true/.test(slice)) {
            offenders.push(`${file}: ${slice.split('\n')[0].slice(0, 100)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('SWEEP: every Bun.spawn call in src/ passes windowsHide (#2575 residual)', () => {
    // Bun.spawn sites are structurally outside the child_process sweep above.
    // Native Bun hides consoles by default and the Node polyfill
    // (bun-polyfill.cjs) defaults windowsHide !== false since #2523/#2539 —
    // this census exists so an explicit flag documents the intent at every
    // site AND catches a regression if either default ever flips. Exemptions
    // carry reasons, same contract as the child_process sweep.
    const EXEMPT: Array<{ file: string; needle: string; reason: string }> = [];

    const srcDir = path.join(import.meta.dir, '../src');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const raw = fs.readFileSync(path.join(srcDir, file), 'utf-8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const re = /(?:\(Bun as any\)|Bun)\.spawn(?:Sync)?\(/g;
      for (const m of code.matchAll(re)) {
        const slice = code.slice(m.index!, m.index! + 900);
        const exempt = EXEMPT.some((e) => e.file === file && slice.includes(e.needle));
        if (exempt) continue;
        if (!/windowsHide:\s*true/.test(slice)) {
          offenders.push(`${file}: ${slice.split('\n')[0].slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
