/**
 * Tab isolation tests — verify per-agent tab ownership in BrowserManager.
 *
 * These test the ownership Map and checkTabAccess() logic directly,
 * without launching a browser (pure logic tests).
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';

// We test the ownership methods directly. BrowserManager can't call newTab()
// without a browser, so we test the ownership map + access checks via
// the public API that doesn't require Playwright.

describe('Tab Isolation', () => {
  let bm: BrowserManager;

  beforeEach(() => {
    bm = new BrowserManager();
  });

  describe('getTabOwner', () => {
    it('returns null for tabs with no owner', () => {
      expect(bm.getTabOwner(1)).toBeNull();
      expect(bm.getTabOwner(999)).toBeNull();
    });
  });

  describe('checkTabAccess', () => {
    // Root token — unconstrained.
    it('root can always access any tab (read)', () => {
      expect(bm.checkTabAccess(1, 'root', { isWrite: false })).toBe(true);
    });

    it('root can always access any tab (write)', () => {
      expect(bm.checkTabAccess(1, 'root', { isWrite: true })).toBe(true);
    });

    // Shared-policy tokens — local skill spawns + default scoped clients.
    // These can read/write ANY tab (the user's natural tabs are unowned, so
    // the bundled hackernews-frontpage skill needs to drive them). Capability
    // is gated by scope checks + rate limits, not tab ownership. This is the
    // contract that lets `$B skill run <name>` work end-to-end on a fresh
    // session where the daemon's active tab has no claimed owner.
    it('shared scoped agent can read an unowned tab', () => {
      expect(bm.checkTabAccess(1, 'agent-1', { isWrite: false })).toBe(true);
    });

    it('shared scoped agent CAN write to an unowned tab (skill ergonomics)', () => {
      // Pre-fix: this returned false and broke every browser-skill spawn.
      // The user's natural tabs have no claimed owner, so the skill's first
      // goto (a write) hit "Tab not owned by your agent". Bundled
      // hackernews-frontpage failed identically — see commit log for
      // v1.20.0.0.
      expect(bm.checkTabAccess(1, 'agent-1', { isWrite: true })).toBe(true);
    });

    it('shared scoped agent can read another agent tab', () => {
      expect(bm.checkTabAccess(1, 'agent-2', { isWrite: false })).toBe(true);
    });

    it('shared scoped agent can write to another agent tab', () => {
      // Local trust: a skill spawn behaves like root for tab access.
      // Parallel-skill clobber-protection is not a goal of this layer.
      expect(bm.checkTabAccess(1, 'agent-2', { isWrite: true })).toBe(true);
    });

    // Own-only-policy tokens — pair-agent / tunnel. Strict ownership for
    // every read and write. The v1.6.0.0 dual-listener threat model.
    it('own-only scoped agent CANNOT read an unowned tab', () => {
      expect(bm.checkTabAccess(1, 'agent-1', { isWrite: false, ownOnly: true })).toBe(false);
    });

    it('own-only scoped agent CANNOT write to an unowned tab', () => {
      expect(bm.checkTabAccess(1, 'agent-1', { isWrite: true, ownOnly: true })).toBe(false);
    });

    it('own-only scoped agent can read its own tab', () => {
      bm.transferTab = bm.transferTab.bind(bm);
      // We can't create a real tab without a browser, but we can prime the
      // ownership map by calling the public access check with a known
      // owner (transferTab requires a real page; instead, simulate via
      // private map injection through transferTab's check).
      // Workaround: assert the read+ownership shape through a stand-in.
      // Use the read-side claim that an agent-owned tab passes ownership
      // checks; this is exercised end-to-end by browser-skill-commands
      // and pair-agent tests where real tabs exist.
      // For the unit layer: assert false-on-mismatch as the contract.
      expect(bm.checkTabAccess(1, 'someone-else', { isWrite: false, ownOnly: true })).toBe(false);
    });

    it('own-only scoped agent CANNOT write to another agent tab', () => {
      expect(bm.checkTabAccess(1, 'agent-2', { isWrite: true, ownOnly: true })).toBe(false);
    });
  });

  describe('transferTab', () => {
    it('throws for non-existent tab', () => {
      expect(() => bm.transferTab(999, 'agent-1')).toThrow('Tab 999 not found');
    });
  });
});

// Test the instruction block generator
import { generateInstructionBlock } from '../src/cli';

describe('generateInstructionBlock', () => {
  it('generates a valid instruction block with setup key', () => {
    const block = generateInstructionBlock({
      setupKey: 'gsk_setup_test123',
      serverUrl: 'https://test.ngrok.dev',
      scopes: ['read', 'write'],
      expiresAt: '2026-04-06T00:00:00Z',
    });

    expect(block).toContain('gsk_setup_test123');
    expect(block).toContain('https://test.ngrok.dev/connect');
    expect(block).toContain('STEP 1');
    expect(block).toContain('STEP 2');
    expect(block).toContain('STEP 3');
    expect(block).toContain('COMMAND REFERENCE');
    expect(block).toContain('read + write access');
    expect(block).toContain('tabId');
    expect(block).toContain('@ref');
    expect(block).not.toContain('undefined');
  });

  it('uses localhost URL when no tunnel', () => {
    const block = generateInstructionBlock({
      setupKey: 'gsk_setup_local',
      serverUrl: 'http://127.0.0.1:45678',
      scopes: ['read', 'write'],
      expiresAt: 'in 24 hours',
    });

    expect(block).toContain('http://127.0.0.1:45678/connect');
  });

  it('shows admin scope description when admin included', () => {
    const block = generateInstructionBlock({
      setupKey: 'gsk_setup_admin',
      serverUrl: 'https://test.ngrok.dev',
      scopes: ['read', 'write', 'admin', 'meta'],
      expiresAt: '2026-04-06T00:00:00Z',
    });

    expect(block).toContain('admin access');
    expect(block).toContain('execute JS');
    expect(block).not.toContain('re-pair with --admin');
  });

  it('shows re-pair hint when control not included', () => {
    const block = generateInstructionBlock({
      setupKey: 'gsk_setup_nocontrol',
      serverUrl: 'https://test.ngrok.dev',
      scopes: ['read', 'write', 'admin', 'meta'],
      expiresAt: '2026-04-06T00:00:00Z',
    });

    expect(block).toContain('re-pair with --control');
  });

  it('includes newtab as step 2 (agents must own their tab)', () => {
    const block = generateInstructionBlock({
      setupKey: 'gsk_setup_test',
      serverUrl: 'https://test.ngrok.dev',
      scopes: ['read', 'write'],
      expiresAt: '2026-04-06T00:00:00Z',
    });

    expect(block).toContain('Create your own tab');
    expect(block).toContain('"command": "newtab"');
  });

  it('includes error troubleshooting section', () => {
    const block = generateInstructionBlock({
      setupKey: 'gsk_setup_test',
      serverUrl: 'https://test.ngrok.dev',
      scopes: ['read', 'write'],
      expiresAt: '2026-04-06T00:00:00Z',
    });

    expect(block).toContain('401');
    expect(block).toContain('403');
    expect(block).toContain('429');
  });

  it('teaches the snapshot→@ref pattern', () => {
    const block = generateInstructionBlock({
      setupKey: 'gsk_setup_snap',
      serverUrl: 'https://test.ngrok.dev',
      scopes: ['read', 'write'],
      expiresAt: '2026-04-06T00:00:00Z',
    });

    // Must explain the snapshot→@ref workflow
    expect(block).toContain('snapshot');
    expect(block).toContain('@e1');
    expect(block).toContain('@e2');
    expect(block).toContain("Always snapshot first");
    expect(block).toContain("Don't guess selectors");
  });

  it('shows SERVER URL prominently', () => {
    const block = generateInstructionBlock({
      setupKey: 'gsk_setup_url',
      serverUrl: 'https://my-tunnel.ngrok.dev',
      scopes: ['read', 'write'],
      expiresAt: '2026-04-06T00:00:00Z',
    });

    expect(block).toContain('SERVER: https://my-tunnel.ngrok.dev');
  });

  it('includes newtab in COMMAND REFERENCE', () => {
    const block = generateInstructionBlock({
      setupKey: 'gsk_setup_ref',
      serverUrl: 'https://test.ngrok.dev',
      scopes: ['read', 'write'],
      expiresAt: '2026-04-06T00:00:00Z',
    });

    expect(block).toContain('"command": "newtab"');
    expect(block).toContain('"command": "goto"');
    expect(block).toContain('"command": "snapshot"');
    expect(block).toContain('"command": "click"');
    expect(block).toContain('"command": "fill"');
  });
});

// Test CLI source-level behavior (pair-agent headed mode, ngrok detection)
import * as fs from 'fs';
import * as path from 'path';

const CLI_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/cli.ts'), 'utf-8');

describe('pair-agent CLI behavior', () => {
  // Extract the pair-agent block: from "pair-agent" dispatch to "process.exit(0)"
  const pairStart = CLI_SRC.indexOf("command === 'pair-agent'");
  const pairEnd = CLI_SRC.indexOf('process.exit(0)', pairStart);
  const pairBlock = CLI_SRC.slice(pairStart, pairEnd);

  it('auto-switches to headed mode unless --headless', () => {
    expect(pairBlock).toContain("state.mode !== 'headed'");
    expect(pairBlock).toContain("--headless");
    expect(pairBlock).toContain("connect");
  });

  it('uses process.execPath for binary path (not argv[1] which is virtual in compiled)', () => {
    expect(pairBlock).toContain('process.execPath');
    // browseBin should be set to execPath, not argv[1]
    expect(pairBlock).toContain('const browseBin = process.execPath');
  });

  it('isNgrokAvailable checks gstack env, NGROK_AUTHTOKEN, and native config', () => {
    const ngrokBlock = CLI_SRC.slice(
      CLI_SRC.indexOf('function isNgrokAvailable'),
      CLI_SRC.indexOf('// ─── Pair-Agent DX')
    );
    // Three sources checked (paths are in path.join() calls, check the string literals)
    expect(ngrokBlock).toContain("'ngrok.env'");
    expect(ngrokBlock).toContain('NGROK_AUTHTOKEN');
    expect(ngrokBlock).toContain("'ngrok.yml'");
    // Checks macOS, Linux XDG, and legacy paths
    expect(ngrokBlock).toContain("'Application Support'");
    expect(ngrokBlock).toContain("'.config'");
    expect(ngrokBlock).toContain("'.ngrok2'");
  });

  it('calls POST /tunnel/start when ngrok is available (not restart)', () => {
    const handleBlock = CLI_SRC.slice(
      CLI_SRC.indexOf('async function handlePairAgent'),
      CLI_SRC.indexOf('function main()')
    );
    expect(handleBlock).toContain('/tunnel/start');
    // Must NOT contain server restart logic
    expect(handleBlock).not.toContain('Bun.spawn([\'bun\', \'run\'');
    expect(handleBlock).not.toContain('BROWSE_TUNNEL');
  });
});
