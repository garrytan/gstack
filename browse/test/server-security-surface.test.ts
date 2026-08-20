/**
 * #2557 / ENG-OV9: pins the dead-shield removal AND the live L4 wiring.
 *
 * The removed surface: /health's `security` field read getStatus(), whose
 * only data source (~/.gstack/security/session-state.json) lost its only
 * writer when sidebar-agent.ts was ripped — so /health reported a permanent
 * 'inactive' or, wherever an old state file survived, a stale FALSE-GREEN
 * 'protected' ("no threats detected" when the real state was "not
 * measured"). Same fail-open class as #2026.
 *
 * The kept surface (ENG-OV9): security.ts is NOT dead — server.ts's
 * /pty-inject-scan path is the live L4 consumer (sidecar scan + URL
 * blocklist + datamark envelope), and security.ts's pure combiner/canary
 * exports stay. This test pins both directions so a future "cleanup" can't
 * silently take the live half, and a future re-feed of /health.security
 * from LIVE signals (isSidecarAvailable, content filters) must update this
 * test deliberately rather than resurrect the state-file path.
 *
 * Source-level, same style as windows-spawn-hide.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SRC = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf-8');

describe('#2557: dead shield surface stays dead', () => {
  test('/health carries no security field and server.ts does not import getStatus', () => {
    const server = SRC('server.ts');
    expect(server).not.toMatch(/security:\s*getSecurityStatus\(\)/);
    expect(server).not.toMatch(/getStatus as getSecurityStatus/);
    // The SECURITY session-state file must not be read anywhere in src/ —
    // that file has no writer, so any reader is a false-signal feed.
    // (session-persist.ts's per-project <stateDir>/session-state.json is a
    // different, live file — only the ~/.gstack/security/ one is dead.)
    for (const f of fs.readdirSync(path.join(import.meta.dir, '../src')).filter((x) => x.endsWith('.ts'))) {
      const code = SRC(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
      const refs = /security[/'",\s][^\n]{0,80}session-state\.json/.test(code);
      expect({ file: f, refs }).toEqual({ file: f, refs: false });
    }
  });

  test('security.ts no longer exports the unfed status surface', () => {
    const security = SRC('security.ts');
    expect(security).not.toMatch(/export function getStatus/);
    expect(security).not.toMatch(/export function (read|write)SessionState/);
    expect(security).not.toMatch(/export interface SessionState/);
    expect(security).not.toMatch(/export interface StatusDetail/);
  });

  test('the sidepanel shield markup is gone', () => {
    const html = fs.readFileSync(path.join(import.meta.dir, '../../extension/sidepanel.html'), 'utf-8');
    const css = fs.readFileSync(path.join(import.meta.dir, '../../extension/sidepanel.css'), 'utf-8');
    expect(html).not.toContain('security-shield');
    expect(css).not.toMatch(/\.security-shield\s*\{/);
  });
});

describe('ENG-OV9: the LIVE L4 path is untouched', () => {
  test('server.ts still consumes the sidecar on the inject-scan path', () => {
    const server = SRC('server.ts');
    expect(server).toContain("from './security-sidecar-client'");
    expect(server).toMatch(/isSidecarAvailable/);
    expect(server).toMatch(/scanWithSidecar\(/);
  });

  test('security.ts keeps the pure combiner + canary exports', () => {
    const security = SRC('security.ts');
    expect(security).toMatch(/export const THRESHOLDS/);
    expect(security).toMatch(/export function combineVerdict/);
    expect(security).toMatch(/export function generateCanary/);
    expect(security).toMatch(/export function injectCanary/);
    expect(security).toMatch(/export function checkCanaryInStructure/);
    expect(security).toMatch(/export function extractDomain/);
  });

  test('/health stays liveness-only: no token in any mode (regression wall from v1.63)', () => {
    const server = SRC('server.ts');
    // The /health handler block must not interpolate a token.
    const healthIdx = server.indexOf("url.pathname === '/health'");
    expect(healthIdx).toBeGreaterThan(0);
    const healthBlock = server.slice(healthIdx, healthIdx + 1500);
    expect(healthBlock).not.toMatch(/token:\s*[^n]/i);
  });
});
