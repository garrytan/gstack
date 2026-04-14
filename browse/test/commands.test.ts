/**
 * Integration tests for all browse commands
 *
 * Tests run against a local test server serving fixture HTML files.
 * A real browse server is started and commands are sent via the CLI HTTP interface.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { resolveServerScript } from '../src/cli';
import { handleReadCommand as _handleReadCommand } from '../src/read-commands';
import { handleWriteCommand as _handleWriteCommand } from '../src/write-commands';
import { handleMetaCommand } from '../src/meta-commands';
import { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry, CircularBuffer } from '../src/buffers';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';

// Thin wrappers that bridge old test calls (bm as 3rd arg) to new signatures (session + bm)
const handleReadCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleReadCommand(cmd, args, b.getActiveSession());
const handleWriteCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleWriteCommand(cmd, args, b.getActiveSession(), b);

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;

  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  // Force kill browser instead of graceful close (avoids hang)
  try { testServer.server.stop(); } catch {}
  // bm.close() can hang — just let process exit handle it
  setTimeout(() => process.exit(0), 500);
});

// ─── Navigation ─────────────────────────────────────────────────

describe('Navigation', () => {
  test('goto navigates to URL', async () => {
    const result = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    expect(result).toContain('Navigated to');
    expect(result).toContain('200');
  });

  test('url returns current URL', async () => {
    const result = await handleMetaCommand('url', [], bm, async () => {});
    expect(result).toContain('/basic.html');
  });

  test('back goes back', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleWriteCommand('back', [], bm);
    expect(result).toContain('Back');
  });

  test('forward goes forward', async () => {
    const result = await handleWriteCommand('forward', [], bm);
    expect(result).toContain('Forward');
  });

  test('reload reloads page', async () => {
    const result = await handleWriteCommand('reload', [], bm);
    expect(result).toContain('Reloaded');
  });
});

// ─── Content Extraction ─────────────────────────────────────────

describe('Content extraction', () => {
  beforeAll(async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
  });

  test('text returns cleaned page text', async () => {
    const result = await handleReadCommand('text', [], bm);
    expect(result).toContain('Hello World');
    expect(result).toContain('Item one');
    expect(result).not.toContain('<h1>');
  });

  test('html returns full page HTML', async () => {
    const result = await handleReadCommand('html', [], bm);
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('<h1 id="title">Hello World</h1>');
  });

  test('html with selector returns element innerHTML', async () => {
    const result = await handleReadCommand('html', ['#content'], bm);
    expect(result).toContain('Some body text here.');
    expect(result).toContain('<li>Item one</li>');
  });

  test('links returns all links', async () => {
    const result = await handleReadCommand('links', [], bm);
    expect(result).toContain('Page 1');
    expect(result).toContain('Page 2');
    expect(result).toContain('External');
    expect(result).toContain('→');
  });

  test('forms discovers form fields', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleReadCommand('forms', [], bm);
    const forms = JSON.parse(result);
    expect(forms.length).toBe(2);
    expect(forms[0].id).toBe('login-form');
    expect(forms[0].method).toBe('post');
    expect(forms[0].fields.length).toBeGreaterThanOrEqual(2);
    expect(forms[1].id).toBe('profile-form');

    // Check field discovery
    const emailField = forms[0].fields.find((f: any) => f.name === 'email');
    expect(emailField).toBeDefined();
    expect(emailField.type).toBe('email');
    expect(emailField.required).toBe(true);
  });

  test('accessibility returns ARIA tree', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('accessibility', [], bm);
    expect(result).toContain('Hello World');
  });
});

// ─── JavaScript / CSS / Attrs ───────────────────────────────────

describe('Inspection', () => {
  beforeAll(async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
  });

  test('js evaluates expression', async () => {
    const result = await handleReadCommand('js', ['document.title'], bm);
    expect(result).toBe('Test Page - Basic');
  });

  test('js returns objects as JSON', async () => {
    const result = await handleReadCommand('js', ['({a: 1, b: 2})'], bm);
    const obj = JSON.parse(result);
    expect(obj.a).toBe(1);
    expect(obj.b).toBe(2);
  });

  test('js supports await expressions', async () => {
    const result = await handleReadCommand('js', ['await Promise.resolve(42)'], bm);
    expect(result).toBe('42');
  });

  test('js does not false-positive on await substring', async () => {
    const result = await handleReadCommand('js', ['(() => { const awaitable = 5; return awaitable })()'], bm);
    expect(result).toBe('5');
  });

  test('eval supports await in single-line file', async () => {
    const tmp = '/tmp/eval-await-test.js';
    fs.writeFileSync(tmp, 'await Promise.resolve("hello from eval")');
    try {
      const result = await handleReadCommand('eval', [tmp], bm);
      expect(result).toBe('hello from eval');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('eval does not wrap when await is only in a comment', async () => {
    const tmp = '/tmp/eval-comment-test.js';
    fs.writeFileSync(tmp, '// no need to await this\ndocument.title');
    try {
      const result = await handleReadCommand('eval', [tmp], bm);
      expect(result).toBe('Test Page - Basic');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('eval multi-line with await and explicit return', async () => {
    const tmp = '/tmp/eval-multiline-await.js';
    fs.writeFileSync(tmp, 'const data = await Promise.resolve("multi");\nreturn data;');
    try {
      const result = await handleReadCommand('eval', [tmp], bm);
      expect(result).toBe('multi');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('eval multi-line with await but no return gives empty string', async () => {
    const tmp = '/tmp/eval-multiline-no-return.js';
    fs.writeFileSync(tmp, 'const data = await Promise.resolve("lost");\ndata;');
    try {
      const result = await handleReadCommand('eval', [tmp], bm);
      expect(result).toBe('');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('js handles multi-line with await', async () => {
    const code = 'const x = await Promise.resolve(42);\nreturn x;';
    const result = await handleReadCommand('js', [code], bm);
    expect(result).toBe('42');
  });

  test('js handles await with semicolons', async () => {
    const result = await handleReadCommand('js', ['const x = await Promise.resolve(5); return x + 1;'], bm);
    expect(result).toBe('6');
  });

  test('js handles await with statement keywords', async () => {
    const result = await handleReadCommand('js', ['const res = await Promise.resolve("ok"); return res;'], bm);
    expect(result).toBe('ok');
  });

  test('js still works for simple expressions', async () => {
    const result = await handleReadCommand('js', ['1 + 2'], bm);
    expect(result).toBe('3');
  });

  test('css returns computed property', async () => {
    const result = await handleReadCommand('css', ['h1', 'color'], bm);
    // Navy color
    expect(result).toContain('0, 0, 128');
  });

  test('css returns font-family', async () => {
    const result = await handleReadCommand('css', ['body', 'font-family'], bm);
    expect(result).toContain('Helvetica');
  });

  test('attrs returns element attributes', async () => {
    const result = await handleReadCommand('attrs', ['#content'], bm);
    const attrs = JSON.parse(result);
    expect(attrs.id).toBe('content');
    expect(attrs['data-testid']).toBe('main-content');
    expect(attrs['data-version']).toBe('1.0');
  });
});

// ─── Interaction ────────────────────────────────────────────────

describe('Interaction', () => {
  test('fill + click works on form', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);

    let result = await handleWriteCommand('fill', ['#email', 'test@example.com'], bm);
    expect(result).toContain('Filled');

    result = await handleWriteCommand('fill', ['#password', 'secret123'], bm);
    expect(result).toContain('Filled');

    // Verify values were set
    const emailVal = await handleReadCommand('js', ['document.querySelector("#email").value'], bm);
    expect(emailVal).toBe('test@example.com');

    result = await handleWriteCommand('click', ['#login-btn'], bm);
    expect(result).toContain('Clicked');
  });

  test('select works on dropdown', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleWriteCommand('select', ['#role', 'admin'], bm);
    expect(result).toContain('Selected');

    const val = await handleReadCommand('js', ['document.querySelector("#role").value'], bm);
    expect(val).toBe('admin');
  });

  test('click on option ref auto-routes to selectOption', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    // Reset select to default
    await handleReadCommand('js', ['document.querySelector("#role").value = ""'], bm);
    const snap = await handleMetaCommand('snapshot', [], bm, async () => {});
    // Find an option ref (e.g., "Admin" option)
    const optionLine = snap.split('\n').find((l: string) => l.includes('[option]') && l.includes('"Admin"'));
    expect(optionLine).toBeDefined();
    const refMatch = optionLine!.match(/@(e\d+)/);
    expect(refMatch).toBeDefined();
    const ref = `@${refMatch![1]}`;
    const result = await handleWriteCommand('click', [ref], bm);
    expect(result).toContain('auto-routed');
    expect(result).toContain('Selected');
    // Verify the select value actually changed
    const val = await handleReadCommand('js', ['document.querySelector("#role").value'], bm);
    expect(val).toBe('admin');
  });

  test('click CSS selector on option gives helpful error', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    try {
      await handleWriteCommand('click', ['option[value="admin"]'], bm);
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toContain('select');
      expect(err.message).toContain('option');
    }
  }, 15000);

  test('hover works', async () => {
    const result = await handleWriteCommand('hover', ['h1'], bm);
    expect(result).toContain('Hovered');
  });

  test('wait finds existing element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('wait', ['#title'], bm);
    expect(result).toContain('appeared');
  });

  test('scroll works', async () => {
    const result = await handleWriteCommand('scroll', ['footer'], bm);
    expect(result).toContain('Scrolled');
  });

  test('viewport changes size', async () => {
    const result = await handleWriteCommand('viewport', ['375x812'], bm);
    expect(result).toContain('Viewport set');

    const size = await handleReadCommand('js', ['`${window.innerWidth}x${window.innerHeight}`'], bm);
    expect(size).toBe('375x812');

    // Reset
    await handleWriteCommand('viewport', ['1280x720'], bm);
  });

  test('type and press work', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    await handleWriteCommand('click', ['#name'], bm);

    const result = await handleWriteCommand('type', ['John Doe'], bm);
    expect(result).toContain('Typed');

    const val = await handleReadCommand('js', ['document.querySelector("#name").value'], bm);
    expect(val).toBe('John Doe');
  });
});

// ─── SPA / Console / Network ───────────────────────────────────

describe('SPA and buffers', () => {
  test('wait handles delayed rendering', async () => {
    await handleWriteCommand('goto', [baseUrl + '/spa.html'], bm);
    const result = await handleWriteCommand('wait', ['.loaded'], bm);
    expect(result).toContain('appeared');

    const text = await handleReadCommand('text', [], bm);
    expect(text).toContain('SPA Content Loaded');
  });

  test('console captures messages', async () => {
    const result = await handleReadCommand('console', [], bm);
    expect(result).toContain('[SPA] Starting render');
    expect(result).toContain('[SPA] Render complete');
  });

  test('console --clear clears buffer', async () => {
    const result = await handleReadCommand('console', ['--clear'], bm);
    expect(result).toContain('cleared');

    const after = await handleReadCommand('console', [], bm);
    expect(after).toContain('no console messages');
  });

  test('network captures requests', async () => {
    const result = await handleReadCommand('network', [], bm);
    expect(result).toContain('GET');
    expect(result).toContain('/spa.html');
  });

  test('network --clear clears buffer', async () => {
    const result = await handleReadCommand('network', ['--clear'], bm);
    expect(result).toContain('cleared');
  });
});

// ─── Cookies / Storage ──────────────────────────────────────────

describe('Cookies and storage', () => {
  test('cookies returns array', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('cookies', [], bm);
    // Test server doesn't set cookies, so empty array
    expect(result).toBe('[]');
  });

  test('storage set and get works', async () => {
    await handleReadCommand('storage', ['set', 'testData', 'testValue'], bm);
    const result = await handleReadCommand('storage', [], bm);
    const storage = JSON.parse(result);
    expect(storage.localStorage.testData).toBe('testValue');
  });

  test('storage read redacts sensitive keys', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleReadCommand('storage', ['set', 'auth_token', 'my-secret-token'], bm);
    await handleReadCommand('storage', ['set', 'api_key', 'key-12345'], bm);
    await handleReadCommand('storage', ['set', 'displayName', 'normalValue'], bm);
    const result = await handleReadCommand('storage', [], bm);
    const storage = JSON.parse(result);
    expect(storage.localStorage.auth_token).toMatch(/REDACTED/);
    expect(storage.localStorage.api_key).toMatch(/REDACTED/);
    expect(storage.localStorage.displayName).toBe('normalValue');
  });

  test('storage read redacts sensitive values by prefix', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // JWT value under innocuous key name
    await handleReadCommand('storage', ['set', 'userData', 'eyJhbGciOiJIUzI1NiJ9.payload.sig'], bm);
    // GitHub PAT under innocuous key name
    await handleReadCommand('storage', ['set', 'repoAccess', 'ghp_abc123def456'], bm);
    const result = await handleReadCommand('storage', [], bm);
    const storage = JSON.parse(result);
    expect(storage.localStorage.userData).toMatch(/REDACTED/);
    expect(storage.localStorage.repoAccess).toMatch(/REDACTED/);
  });

  test('storage redaction includes value length', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleReadCommand('storage', ['set', 'session_token', 'abc123'], bm);
    const result = await handleReadCommand('storage', [], bm);
    const storage = JSON.parse(result);
    expect(storage.localStorage.session_token).toBe('[REDACTED — 6 chars]');
  });
});

// ─── Performance ────────────────────────────────────────────────

describe('Performance', () => {
  test('perf returns timing data', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('perf', [], bm);
    expect(result).toContain('dns');
    expect(result).toContain('ttfb');
    expect(result).toContain('load');
    expect(result).toContain('ms');
  });
});

// ─── Visual ─────────────────────────────────────────────────────

describe('Visual', () => {
  test('screenshot saves file', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const screenshotPath = '/tmp/browse-test-screenshot.png';
    const result = await handleMetaCommand('screenshot', [screenshotPath], bm, async () => {});
    expect(result).toContain('Screenshot saved');
    expect(fs.existsSync(screenshotPath)).toBe(true);
    const stat = fs.statSync(screenshotPath);
    expect(stat.size).toBeGreaterThan(1000);
    fs.unlinkSync(screenshotPath);
  });

  test('screenshot --viewport saves viewport-only', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const p = '/tmp/browse-test-viewport.png';
    const result = await handleMetaCommand('screenshot', ['--viewport', p], bm, async () => {});
    expect(result).toContain('Screenshot saved (viewport)');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(1000);
    fs.unlinkSync(p);
  });

  test('screenshot with CSS selector crops to element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const p = '/tmp/browse-test-element-css.png';
    const result = await handleMetaCommand('screenshot', ['#title', p], bm, async () => {});
    expect(result).toContain('Screenshot saved (element)');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(100);
    fs.unlinkSync(p);
  });

  test('screenshot with @ref crops to element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleMetaCommand('snapshot', [], bm, async () => {});
    const p = '/tmp/browse-test-element-ref.png';
    const result = await handleMetaCommand('screenshot', ['@e1', p], bm, async () => {});
    expect(result).toContain('Screenshot saved (element)');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(100);
    fs.unlinkSync(p);
  });

  test('screenshot --clip crops to region', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const p = '/tmp/browse-test-clip.png';
    const result = await handleMetaCommand('screenshot', ['--clip', '0,0,100,100', p], bm, async () => {});
    expect(result).toContain('Screenshot saved (clip 0,0,100,100)');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(100);
    fs.unlinkSync(p);
  });

  test('screenshot --clip + selector throws', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('screenshot', ['--clip', '0,0,100,100', '#title'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Cannot use --clip with a selector/ref');
    }
  });

  test('screenshot --viewport + --clip throws', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('screenshot', ['--viewport', '--clip', '0,0,100,100'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Cannot use --viewport with --clip');
    }
  });

  test('screenshot --clip with invalid coords throws', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('screenshot', ['--clip', 'abc'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('all must be numbers');
    }
  });

  test('screenshot unknown flag throws', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('screenshot', ['--bogus', '/tmp/foo.png'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Unknown screenshot flag');
    }
  });

  test('screenshot --viewport still validates path', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('screenshot', ['--viewport', '/etc/evil.png'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Path must be within');
    }
  });

  test('screenshot treats relative dot-slash path as file path, not CSS selector', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // ./path/to/file.png must be treated as output path, not a CSS class selector (#495)
    const relPath = './browse-test-dotpath.png';
    const absPath = path.resolve(relPath);
    const result = await handleMetaCommand('screenshot', [relPath], bm, async () => {});
    expect(result).toContain('Screenshot saved');
    expect(fs.existsSync(absPath)).toBe(true);
    fs.unlinkSync(absPath);
  });

  test('screenshot with nonexistent selector throws timeout', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('screenshot', ['.nonexistent-element-xyz'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toBeDefined();
    }
  }, 10000);

  test('responsive saves 3 screenshots', async () => {
    await handleWriteCommand('goto', [baseUrl + '/responsive.html'], bm);
    const prefix = '/tmp/browse-test-resp';
    const result = await handleMetaCommand('responsive', [prefix], bm, async () => {});
    expect(result).toContain('mobile');
    expect(result).toContain('tablet');
    expect(result).toContain('desktop');

    expect(fs.existsSync(`${prefix}-mobile.png`)).toBe(true);
    expect(fs.existsSync(`${prefix}-tablet.png`)).toBe(true);
    expect(fs.existsSync(`${prefix}-desktop.png`)).toBe(true);

    // Cleanup
    fs.unlinkSync(`${prefix}-mobile.png`);
    fs.unlinkSync(`${prefix}-tablet.png`);
    fs.unlinkSync(`${prefix}-desktop.png`);
  });
});

// ─── Tabs ───────────────────────────────────────────────────────

describe('Tabs', () => {
  test('tabs lists all tabs', async () => {
    const result = await handleMetaCommand('tabs', [], bm, async () => {});
    expect(result).toContain('[');
    expect(result).toContain(']');
  });

  test('newtab opens new tab', async () => {
    const result = await handleMetaCommand('newtab', [baseUrl + '/forms.html'], bm, async () => {});
    expect(result).toContain('Opened tab');

    const tabCount = bm.getTabCount();
    expect(tabCount).toBeGreaterThanOrEqual(2);
  });

  test('tab switches to specific tab', async () => {
    const result = await handleMetaCommand('tab', ['1'], bm, async () => {});
    expect(result).toContain('Switched to tab 1');
  });

  test('closetab closes a tab', async () => {
    const before = bm.getTabCount();
    // Close the last opened tab
    const tabs = await bm.getTabListWithTitles();
    const lastTab = tabs[tabs.length - 1];
    const result = await handleMetaCommand('closetab', [String(lastTab.id)], bm, async () => {});
    expect(result).toContain('Closed tab');
    expect(bm.getTabCount()).toBe(before - 1);
  });
});

// ─── Diff ───────────────────────────────────────────────────────

describe('Diff', () => {
  test('diff shows differences between pages', async () => {
    const result = await handleMetaCommand(
      'diff',
      [baseUrl + '/basic.html', baseUrl + '/forms.html'],
      bm,
      async () => {}
    );
    expect(result).toContain('---');
    expect(result).toContain('+++');
    // basic.html has "Hello World", forms.html has "Form Test Page"
    expect(result).toContain('Hello World');
    expect(result).toContain('Form Test Page');
  });
});

// ─── Chain ──────────────────────────────────────────────────────

describe('Chain', () => {
  test('chain executes sequence of commands', async () => {
    const commands = JSON.stringify([
      ['goto', baseUrl + '/basic.html'],
      ['js', 'document.title'],
      ['css', 'h1', 'color'],
    ]);
    const result = await handleMetaCommand('chain', [commands], bm, async () => {});
    expect(result).toContain('[goto]');
    expect(result).toContain('Test Page - Basic');
    expect(result).toContain('[css]');
  });

  test('chain wraps page-content sub-commands with trust markers', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('chain', ['text'], bm, async () => {});
    expect(result).toContain('BEGIN UNTRUSTED EXTERNAL CONTENT');
    expect(result).toContain('END UNTRUSTED EXTERNAL CONTENT');
  });

  test('chain reports real error when write command fails', async () => {
    const commands = JSON.stringify([
      ['goto', 'http://localhost:1/unreachable'],
    ]);
    const result = await handleMetaCommand('chain', [commands], bm, async () => {});
    expect(result).toContain('[goto] ERROR:');
    expect(result).not.toContain('Unknown meta command');
    expect(result).not.toContain('Unknown read command');
  });
});

// ─── Status ─────────────────────────────────────────────────────

describe('Status', () => {
  test('status reports health', async () => {
    const result = await handleMetaCommand('status', [], bm, async () => {});
    expect(result).toContain('Status: healthy');
    expect(result).toContain('Tabs:');
  });
});

// ─── CLI server script resolution ───────────────────────────────

describe('CLI server script resolution', () => {
  test('prefers adjacent browse/src/server.ts for compiled project installs', () => {
    const root = fs.mkdtempSync('/tmp/gstack-cli-');
    const execPath = path.join(root, '.claude/skills/gstack/browse/dist/browse');
    const serverPath = path.join(root, '.claude/skills/gstack/browse/src/server.ts');

    fs.mkdirSync(path.dirname(execPath), { recursive: true });
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(serverPath, '// test server\n');

    const resolved = resolveServerScript(
      { HOME: path.join(root, 'empty-home') },
      '$bunfs/root',
      execPath
    );

    expect(resolved).toBe(serverPath);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ─── CLI lifecycle ──────────────────────────────────────────────

describe('CLI lifecycle', () => {
  test('dead state file triggers a clean restart', async () => {
    const stateFile = `/tmp/browse-test-state-${Date.now()}.json`;
    fs.writeFileSync(stateFile, JSON.stringify({
      port: 1,
      token: 'fake',
      pid: 999999,
    }));

    const cliPath = path.resolve(__dirname, '../src/cli.ts');
    const cliEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) cliEnv[k] = v;
    }
    cliEnv.BROWSE_STATE_FILE = stateFile;
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const proc = spawn('bun', ['run', cliPath, 'status'], {
        timeout: 15000,
        env: cliEnv,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => stdout += d.toString());
      proc.stderr.on('data', (d) => stderr += d.toString());
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

    let restartedPid: number | null = null;
    if (fs.existsSync(stateFile)) {
      restartedPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
      fs.unlinkSync(stateFile);
    }
    if (restartedPid) {
      try { process.kill(restartedPid, 'SIGTERM'); } catch {}
    }

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Status: healthy');
    expect(result.stderr).toContain('Starting server');
  }, 20000);
});

// ─── Buffer bounds ──────────────────────────────────────────────

describe('Buffer bounds', () => {
  test('console buffer caps at 50000 entries', () => {
    consoleBuffer.clear();
    for (let i = 0; i < 50_010; i++) {
      addConsoleEntry({ timestamp: i, level: 'log', text: `msg-${i}` });
    }
    expect(consoleBuffer.length).toBe(50_000);
    const entries = consoleBuffer.toArray();
    expect(entries[0].text).toBe('msg-10');
    expect(entries[entries.length - 1].text).toBe('msg-50009');
    consoleBuffer.clear();
  });

  test('network buffer caps at 50000 entries', () => {
    networkBuffer.clear();
    for (let i = 0; i < 50_010; i++) {
      addNetworkEntry({ timestamp: i, method: 'GET', url: `http://x/${i}` });
    }
    expect(networkBuffer.length).toBe(50_000);
    const entries = networkBuffer.toArray();
    expect(entries[0].url).toBe('http://x/10');
    expect(entries[entries.length - 1].url).toBe('http://x/50009');
    networkBuffer.clear();
  });

  test('totalAdded counters keep incrementing past buffer cap', () => {
    const startConsole = consoleBuffer.totalAdded;
    const startNetwork = networkBuffer.totalAdded;
    for (let i = 0; i < 100; i++) {
      addConsoleEntry({ timestamp: i, level: 'log', text: `t-${i}` });
      addNetworkEntry({ timestamp: i, method: 'GET', url: `http://t/${i}` });
    }
    expect(consoleBuffer.totalAdded).toBe(startConsole + 100);
    expect(networkBuffer.totalAdded).toBe(startNetwork + 100);
    consoleBuffer.clear();
    networkBuffer.clear();
  });
});

// ─── CircularBuffer Unit Tests ─────────────────────────────────

describe('CircularBuffer', () => {
  test('push and toArray return items in insertion order', () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1); buf.push(2); buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.length).toBe(3);
  });

  test('overwrites oldest when full', () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1); buf.push(2); buf.push(3); buf.push(4);
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.length).toBe(3);
  });

  test('totalAdded increments past capacity', () => {
    const buf = new CircularBuffer<number>(2);
    buf.push(1); buf.push(2); buf.push(3); buf.push(4); buf.push(5);
    expect(buf.totalAdded).toBe(5);
    expect(buf.length).toBe(2);
    expect(buf.toArray()).toEqual([4, 5]);
  });

  test('last(n) returns most recent entries', () => {
    const buf = new CircularBuffer<number>(5);
    for (let i = 1; i <= 5; i++) buf.push(i);
    expect(buf.last(3)).toEqual([3, 4, 5]);
    expect(buf.last(10)).toEqual([1, 2, 3, 4, 5]); // clamped
    expect(buf.last(1)).toEqual([5]);
  });

  test('get and set work by index', () => {
    const buf = new CircularBuffer<string>(3);
    buf.push('a'); buf.push('b'); buf.push('c');
    expect(buf.get(0)).toBe('a');
    expect(buf.get(2)).toBe('c');
    buf.set(1, 'B');
    expect(buf.get(1)).toBe('B');
    expect(buf.get(-1)).toBeUndefined();
    expect(buf.get(5)).toBeUndefined();
  });

  test('clear resets size but not totalAdded', () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1); buf.push(2); buf.push(3);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.totalAdded).toBe(3);
    expect(buf.toArray()).toEqual([]);
  });

  test('works with capacity=1', () => {
    const buf = new CircularBuffer<number>(1);
    buf.push(10);
    expect(buf.toArray()).toEqual([10]);
    buf.push(20);
    expect(buf.toArray()).toEqual([20]);
    expect(buf.totalAdded).toBe(2);
  });
});

// ─── Dialog Handling ─────────────────────────────────────────

describe('Dialog handling', () => {
  test('alert does not hang — auto-accepted', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dialog.html'], bm);
    await handleWriteCommand('click', ['#alert-btn'], bm);
    // If we get here, dialog was handled (no hang)
    const result = await handleReadCommand('dialog', [], bm);
    expect(result).toContain('alert');
    expect(result).toContain('Hello from alert');
    expect(result).toContain('accepted');
  });

  test('confirm is auto-accepted by default', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dialog.html'], bm);
    await handleWriteCommand('click', ['#confirm-btn'], bm);
    // Wait for DOM update
    await new Promise(r => setTimeout(r, 100));
    const result = await handleReadCommand('js', ['document.querySelector("#confirm-result").textContent'], bm);
    expect(result).toBe('confirmed');
  });

  test('dialog-dismiss changes behavior', async () => {
    const setResult = await handleWriteCommand('dialog-dismiss', [], bm);
    expect(setResult).toContain('dismissed');

    await handleWriteCommand('goto', [baseUrl + '/dialog.html'], bm);
    await handleWriteCommand('click', ['#confirm-btn'], bm);
    await new Promise(r => setTimeout(r, 100));
    const result = await handleReadCommand('js', ['document.querySelector("#confirm-result").textContent'], bm);
    expect(result).toBe('cancelled');

    // Reset to accept
    await handleWriteCommand('dialog-accept', [], bm);
  });

  test('dialog-accept with text provides prompt response', async () => {
    const setResult = await handleWriteCommand('dialog-accept', ['TestUser'], bm);
    expect(setResult).toContain('TestUser');

    await handleWriteCommand('goto', [baseUrl + '/dialog.html'], bm);
    await handleWriteCommand('click', ['#prompt-btn'], bm);
    await new Promise(r => setTimeout(r, 100));
    const result = await handleReadCommand('js', ['document.querySelector("#prompt-result").textContent'], bm);
    expect(result).toBe('TestUser');

    // Reset
    await handleWriteCommand('dialog-accept', [], bm);
  });

  test('dialog --clear clears buffer', async () => {
    const cleared = await handleReadCommand('dialog', ['--clear'], bm);
    expect(cleared).toContain('cleared');
    const after = await handleReadCommand('dialog', [], bm);
    expect(after).toContain('no dialogs');
  });
});

// ─── Element State Checks (is) ─────────────────────────────────

describe('Element state checks', () => {
  beforeAll(async () => {
    await handleWriteCommand('goto', [baseUrl + '/states.html'], bm);
  });

  test('is visible returns true for visible element', async () => {
    const result = await handleReadCommand('is', ['visible', '#visible-div'], bm);
    expect(result).toBe('true');
  });

  test('is hidden returns true for hidden element', async () => {
    const result = await handleReadCommand('is', ['hidden', '#hidden-div'], bm);
    expect(result).toBe('true');
  });

  test('is visible returns false for hidden element', async () => {
    const result = await handleReadCommand('is', ['visible', '#hidden-div'], bm);
    expect(result).toBe('false');
  });

  test('is enabled returns true for enabled input', async () => {
    const result = await handleReadCommand('is', ['enabled', '#enabled-input'], bm);
    expect(result).toBe('true');
  });

  test('is disabled returns true for disabled input', async () => {
    const result = await handleReadCommand('is', ['disabled', '#disabled-input'], bm);
    expect(result).toBe('true');
  });

  test('is checked returns true for checked checkbox', async () => {
    const result = await handleReadCommand('is', ['checked', '#checked-box'], bm);
    expect(result).toBe('true');
  });

  test('is checked returns false for unchecked checkbox', async () => {
    const result = await handleReadCommand('is', ['checked', '#unchecked-box'], bm);
    expect(result).toBe('false');
  });

  test('is editable returns true for normal input', async () => {
    const result = await handleReadCommand('is', ['editable', '#enabled-input'], bm);
    expect(result).toBe('true');
  });

  test('is editable returns false for readonly input', async () => {
    const result = await handleReadCommand('is', ['editable', '#readonly-input'], bm);
    expect(result).toBe('false');
  });

  test('is focused after click', async () => {
    await handleWriteCommand('click', ['#enabled-input'], bm);
    const result = await handleReadCommand('is', ['focused', '#enabled-input'], bm);
    expect(result).toBe('true');
  });

  test('is with @ref works', async () => {
    await handleMetaCommand('snapshot', ['-i'], bm, async () => {});
    // Find a ref for the enabled input
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, async () => {});
    const textboxLine = snap.split('\n').find(l => l.includes('[textbox]'));
    if (textboxLine) {
      const refMatch = textboxLine.match(/@(e\d+)/);
      if (refMatch) {
        const ref = `@${refMatch[1]}`;
        const result = await handleReadCommand('is', ['visible', ref], bm);
        expect(result).toBe('true');
      }
    }
  });

  test('is with unknown property throws', async () => {
    try {
      await handleReadCommand('is', ['bogus', '#enabled-input'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Unknown property');
    }
  });

  test('is with missing args throws', async () => {
    try {
      await handleReadCommand('is', ['visible'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── File Upload ─────────────────────────────────────────────────

describe('File upload', () => {
  test('upload single file', async () => {
    await handleWriteCommand('goto', [baseUrl + '/upload.html'], bm);
    // Create a temp file to upload
    const tempFile = '/tmp/browse-test-upload.txt';
    fs.writeFileSync(tempFile, 'test content');
    const result = await handleWriteCommand('upload', ['#file-input', tempFile], bm);
    expect(result).toContain('Uploaded');
    expect(result).toContain('browse-test-upload.txt');

    // Verify upload handler fired
    await new Promise(r => setTimeout(r, 100));
    const text = await handleReadCommand('js', ['document.querySelector("#upload-result").textContent'], bm);
    expect(text).toContain('browse-test-upload.txt');
    fs.unlinkSync(tempFile);
  });

  test('upload with @ref works', async () => {
    await handleWriteCommand('goto', [baseUrl + '/upload.html'], bm);
    const tempFile = '/tmp/browse-test-upload2.txt';
    fs.writeFileSync(tempFile, 'ref upload test');
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, async () => {});
    // Find the file input ref (it won't appear as "file input" in aria — use CSS selector instead)
    const result = await handleWriteCommand('upload', ['#file-input', tempFile], bm);
    expect(result).toContain('Uploaded');
    fs.unlinkSync(tempFile);
  });

  test('upload nonexistent file throws', async () => {
    await handleWriteCommand('goto', [baseUrl + '/upload.html'], bm);
    try {
      await handleWriteCommand('upload', ['#file-input', '/tmp/nonexistent-file-12345.txt'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('File not found');
    }
  });

  test('upload missing args throws', async () => {
    try {
      await handleWriteCommand('upload', ['#file-input'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── Eval command ───────────────────────────────────────────────

describe('Eval', () => {
  test('eval runs JS file', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const tempFile = '/tmp/browse-test-eval.js';
    fs.writeFileSync(tempFile, 'document.title + " — evaluated"');
    const result = await handleReadCommand('eval', [tempFile], bm);
    expect(result).toBe('Test Page - Basic — evaluated');
    fs.unlinkSync(tempFile);
  });

  test('eval returns object as JSON', async () => {
    const tempFile = '/tmp/browse-test-eval-obj.js';
    fs.writeFileSync(tempFile, '({title: document.title, keys: Object.keys(document.body.dataset)})');
    const result = await handleReadCommand('eval', [tempFile], bm);
    const obj = JSON.parse(result);
    expect(obj.title).toBe('Test Page - Basic');
    expect(Array.isArray(obj.keys)).toBe(true);
    fs.unlinkSync(tempFile);
  });

  test('eval file not found throws', async () => {
    try {
      await handleReadCommand('eval', ['/tmp/nonexistent-eval.js'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('File not found');
    }
  });

  test('eval no arg throws', async () => {
    try {
      await handleReadCommand('eval', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── Press command ──────────────────────────────────────────────

describe('Press', () => {
  test('press Tab moves focus', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    await handleWriteCommand('click', ['#email'], bm);
    const result = await handleWriteCommand('press', ['Tab'], bm);
    expect(result).toContain('Pressed Tab');
  });

  test('press no arg throws', async () => {
    try {
      await handleWriteCommand('press', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── Cookie command ─────────────────────────────────────────────

describe('Cookie command', () => {
  test('cookie sets value', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('cookie', ['testcookie=testvalue'], bm);
    expect(result).toContain('Cookie set');

    const cookies = await handleReadCommand('cookies', [], bm);
    expect(cookies).toContain('testcookie');
    expect(cookies).toContain('testvalue');
  });

  test('cookie no arg throws', async () => {
    try {
      await handleWriteCommand('cookie', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('cookie no = throws', async () => {
    try {
      await handleWriteCommand('cookie', ['invalid'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── Header command ─────────────────────────────────────────────

describe('Header command', () => {
  test('header sets value and is sent', async () => {
    const result = await handleWriteCommand('header', ['X-Test:test-value'], bm);
    expect(result).toContain('Header set');

    await handleWriteCommand('goto', [baseUrl + '/echo'], bm);
    const echoText = await handleReadCommand('text', [], bm);
    expect(echoText).toContain('x-test');
    expect(echoText).toContain('test-value');
  });

  test('header no arg throws', async () => {
    try {
      await handleWriteCommand('header', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('header no colon throws', async () => {
    try {
      await handleWriteCommand('header', ['invalid'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── PDF command ────────────────────────────────────────────────

describe('PDF', () => {
  test('pdf saves file with size', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const pdfPath = '/tmp/browse-test.pdf';
    const result = await handleMetaCommand('pdf', [pdfPath], bm, async () => {});
    expect(result).toContain('PDF saved');
    expect(fs.existsSync(pdfPath)).toBe(true);
    const stat = fs.statSync(pdfPath);
    expect(stat.size).toBeGreaterThan(100);
    fs.unlinkSync(pdfPath);
  });
});

// ─── Empty page edge cases ──────────────────────────────────────

describe('Empty page', () => {
  test('text returns empty on empty page', async () => {
    await handleWriteCommand('goto', [baseUrl + '/empty.html'], bm);
    const result = await handleReadCommand('text', [], bm);
    expect(result).toBe('');
  });

  test('links returns empty on empty page', async () => {
    const result = await handleReadCommand('links', [], bm);
    expect(result).toBe('');
  });

  test('forms returns empty array on empty page', async () => {
    const result = await handleReadCommand('forms', [], bm);
    expect(JSON.parse(result)).toEqual([]);
  });
});

// ─── Error paths ────────────────────────────────────────────────

describe('Errors', () => {
  // Write command errors
  test('goto with no arg throws', async () => {
    try {
      await handleWriteCommand('goto', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('click with no arg throws', async () => {
    try {
      await handleWriteCommand('click', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('fill with no value throws', async () => {
    try {
      await handleWriteCommand('fill', ['#input'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('select with no value throws', async () => {
    try {
      await handleWriteCommand('select', ['#sel'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('hover with no arg throws', async () => {
    try {
      await handleWriteCommand('hover', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('type with no arg throws', async () => {
    try {
      await handleWriteCommand('type', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('wait with no arg throws', async () => {
    try {
      await handleWriteCommand('wait', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('viewport with bad format throws', async () => {
    try {
      await handleWriteCommand('viewport', ['badformat'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('useragent with no arg throws', async () => {
    try {
      await handleWriteCommand('useragent', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  // Read command errors
  test('js with no expression throws', async () => {
    try {
      await handleReadCommand('js', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('css with missing property throws', async () => {
    try {
      await handleReadCommand('css', ['h1'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('attrs with no selector throws', async () => {
    try {
      await handleReadCommand('attrs', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  // Meta command errors
  test('tab with non-numeric id throws', async () => {
    try {
      await handleMetaCommand('tab', ['abc'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('diff with missing urls throws', async () => {
    try {
      await handleMetaCommand('diff', [baseUrl + '/basic.html'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('chain with invalid JSON falls back to pipe format', async () => {
    // Non-JSON input is now treated as pipe-delimited format
    // 'not json' → [["not", "json"]] → "not" is unknown command → error in result
    const result = await handleMetaCommand('chain', ['not json'], bm, async () => {});
    expect(result).toContain('ERROR');
    expect(result).toContain('Unknown command: not');
  });

  test('chain with no arg throws', async () => {
    try {
      await handleMetaCommand('chain', [], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('unknown read command throws', async () => {
    try {
      await handleReadCommand('bogus' as any, [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Unknown');
    }
  });

  test('unknown write command throws', async () => {
    try {
      await handleWriteCommand('bogus' as any, [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Unknown');
    }
  });

  test('unknown meta command throws', async () => {
    try {
      await handleMetaCommand('bogus' as any, [], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Unknown');
    }
  });
});

// ─── Workflow: Navigation + Snapshot + Interaction ───────────────

describe('Workflows', () => {
  test('navigation → snapshot → click @ref → verify URL', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, async () => {});
    // Find a link ref
    const linkLine = snap.split('\n').find(l => l.includes('[link]'));
    expect(linkLine).toBeDefined();
    const refMatch = linkLine!.match(/@(e\d+)/);
    expect(refMatch).toBeDefined();
    // Click the link
    await handleWriteCommand('click', [`@${refMatch![1]}`], bm);
    // URL should have changed
    const url = await handleMetaCommand('url', [], bm, async () => {});
    expect(url).toBeTruthy();
  });

  test('form: goto → snapshot → fill @ref → click @ref', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, async () => {});
    // Find textbox and button
    const textboxLine = snap.split('\n').find(l => l.includes('[textbox]'));
    const buttonLine = snap.split('\n').find(l => l.includes('[button]') && l.includes('"Submit"'));
    if (textboxLine && buttonLine) {
      const textRef = textboxLine.match(/@(e\d+)/)![1];
      const btnRef = buttonLine.match(/@(e\d+)/)![1];
      await handleWriteCommand('fill', [`@${textRef}`, 'testuser'], bm);
      await handleWriteCommand('click', [`@${btnRef}`], bm);
    }
  });

  test('tabs: newtab → goto → switch → verify isolation', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const tabsBefore = bm.getTabCount();
    await handleMetaCommand('newtab', [baseUrl + '/forms.html'], bm, async () => {});
    expect(bm.getTabCount()).toBe(tabsBefore + 1);

    const url = await handleMetaCommand('url', [], bm, async () => {});
    expect(url).toContain('/forms.html');

    // Switch back to previous tab
    const tabs = await bm.getTabListWithTitles();
    const prevTab = tabs.find(t => t.url.includes('/basic.html'));
    if (prevTab) {
      bm.switchTab(prevTab.id);
      const url2 = await handleMetaCommand('url', [], bm, async () => {});
      expect(url2).toContain('/basic.html');
    }

    // Clean up extra tab
    const allTabs = await bm.getTabListWithTitles();
    const formTab = allTabs.find(t => t.url.includes('/forms.html'));
    if (formTab) await bm.closeTab(formTab.id);
  });

  test('cookies: set → read → reload → verify persistence', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('cookie', ['workflow-test=persisted'], bm);
    await handleWriteCommand('reload', [], bm);
    const cookies = await handleReadCommand('cookies', [], bm);
    expect(cookies).toContain('workflow-test');
    expect(cookies).toContain('persisted');
  });
});

// ─── Wait load states ──────────────────────────────────────────

describe('Wait load states', () => {
  test('wait --networkidle succeeds after page load', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('wait', ['--networkidle'], bm);
    expect(result).toBe('Network idle');
  });

  test('wait --load succeeds', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('wait', ['--load'], bm);
    expect(result).toBe('Page loaded');
  });

  test('wait --domcontentloaded succeeds', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('wait', ['--domcontentloaded'], bm);
    expect(result).toBe('DOM content loaded');
  });

  test('wait --networkidle with custom timeout', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('wait', ['--networkidle', '5000'], bm);
    expect(result).toBe('Network idle');
  });

  test('wait with selector still works', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('wait', ['#title'], bm);
    expect(result).toContain('appeared');
  });
});

// ─── Console --errors ──────────────────────────────────────────

describe('Console --errors', () => {
  test('console --errors filters to error and warning only', async () => {
    // Clear existing entries
    await handleReadCommand('console', ['--clear'], bm);

    // Add mixed entries
    addConsoleEntry({ timestamp: Date.now(), level: 'log', text: 'info message' });
    addConsoleEntry({ timestamp: Date.now(), level: 'warning', text: 'warn message' });
    addConsoleEntry({ timestamp: Date.now(), level: 'error', text: 'error message' });

    const result = await handleReadCommand('console', ['--errors'], bm);
    expect(result).toContain('warn message');
    expect(result).toContain('error message');
    expect(result).not.toContain('info message');

    // Cleanup
    consoleBuffer.clear();
  });

  test('console --errors returns empty message when no errors', async () => {
    consoleBuffer.clear();
    addConsoleEntry({ timestamp: Date.now(), level: 'log', text: 'just a log' });

    const result = await handleReadCommand('console', ['--errors'], bm);
    expect(result).toBe('(no console errors)');

    consoleBuffer.clear();
  });

  test('console --errors on empty buffer', async () => {
    consoleBuffer.clear();
    const result = await handleReadCommand('console', ['--errors'], bm);
    expect(result).toBe('(no console errors)');
  });

  test('console without flag still returns all messages', async () => {
    consoleBuffer.clear();
    addConsoleEntry({ timestamp: Date.now(), level: 'log', text: 'all messages test' });

    const result = await handleReadCommand('console', [], bm);
    expect(result).toContain('all messages test');

    consoleBuffer.clear();
  });
});

// ─── Cookie Import ─────────────────────────────────────────────

describe('Cookie import', () => {
  test('cookie-import loads valid JSON cookies', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const tempFile = '/tmp/browse-test-cookies.json';
    const cookies = [
      { name: 'test-cookie', value: 'test-value' },
      { name: 'another', value: '123' },
    ];
    fs.writeFileSync(tempFile, JSON.stringify(cookies));

    const result = await handleWriteCommand('cookie-import', [tempFile], bm);
    expect(result).toBe('Loaded 2 cookies from /tmp/browse-test-cookies.json');

    // Verify cookies were set
    const cookieList = await handleReadCommand('cookies', [], bm);
    expect(cookieList).toContain('test-cookie');
    expect(cookieList).toContain('test-value');
    expect(cookieList).toContain('another');

    fs.unlinkSync(tempFile);
  });

  test('cookie-import auto-fills domain from page URL', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const tempFile = '/tmp/browse-test-cookies-nodomain.json';
    // Cookies without domain — should auto-fill from page URL
    const cookies = [{ name: 'autofill-test', value: 'works' }];
    fs.writeFileSync(tempFile, JSON.stringify(cookies));

    const result = await handleWriteCommand('cookie-import', [tempFile], bm);
    expect(result).toContain('Loaded 1');

    const cookieList = await handleReadCommand('cookies', [], bm);
    expect(cookieList).toContain('autofill-test');

    fs.unlinkSync(tempFile);
  });

  test('cookie-import preserves explicit domain', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const tempFile = '/tmp/browse-test-cookies-domain.json';
    // Domain must match page hostname (127.0.0.1) — cross-domain cookies are now rejected
    const cookies = [{ name: 'explicit', value: 'domain', domain: '127.0.0.1', path: '/foo' }];
    fs.writeFileSync(tempFile, JSON.stringify(cookies));

    const result = await handleWriteCommand('cookie-import', [tempFile], bm);
    expect(result).toContain('Loaded 1');

    fs.unlinkSync(tempFile);
  });

  test('cookie-import with empty array succeeds', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const tempFile = '/tmp/browse-test-cookies-empty.json';
    fs.writeFileSync(tempFile, '[]');

    const result = await handleWriteCommand('cookie-import', [tempFile], bm);
    expect(result).toBe('Loaded 0 cookies from /tmp/browse-test-cookies-empty.json');

    fs.unlinkSync(tempFile);
  });

  test('cookie-import throws on file not found', async () => {
    try {
      await handleWriteCommand('cookie-import', ['/tmp/nonexistent-cookies.json'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('File not found');
    }
  });

  test('cookie-import throws on invalid JSON', async () => {
    const tempFile = '/tmp/browse-test-cookies-bad.json';
    fs.writeFileSync(tempFile, 'not json {{{');

    try {
      await handleWriteCommand('cookie-import', [tempFile], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Invalid JSON');
    }

    fs.unlinkSync(tempFile);
  });

  test('cookie-import throws on non-array JSON', async () => {
    const tempFile = '/tmp/browse-test-cookies-obj.json';
    fs.writeFileSync(tempFile, '{"name": "not-an-array"}');

    try {
      await handleWriteCommand('cookie-import', [tempFile], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('JSON array');
    }

    fs.unlinkSync(tempFile);
  });

  test('cookie-import throws on cookie missing name', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const tempFile = '/tmp/browse-test-cookies-noname.json';
    fs.writeFileSync(tempFile, JSON.stringify([{ value: 'no-name' }]));

    try {
      await handleWriteCommand('cookie-import', [tempFile], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('name');
    }

    fs.unlinkSync(tempFile);
  });

  test('cookie-import no arg throws', async () => {
    try {
      await handleWriteCommand('cookie-import', [], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── Security: Redact sensitive values (PR #21) ─────────────────

describe('Sensitive value redaction', () => {
  test('type command does not echo typed text', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('type', ['my-secret-password'], bm);
    expect(result).not.toContain('my-secret-password');
    expect(result).toContain('18 characters');
  });

  test('cookie command redacts value', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('cookie', ['session=secret123'], bm);
    expect(result).toContain('session');
    expect(result).toContain('****');
    expect(result).not.toContain('secret123');
  });

  test('header command redacts Authorization value', async () => {
    const result = await handleWriteCommand('header', ['Authorization:Bearer token-xyz'], bm);
    expect(result).toContain('Authorization');
    expect(result).toContain('****');
    expect(result).not.toContain('token-xyz');
  });

  test('header command shows non-sensitive values', async () => {
    const result = await handleWriteCommand('header', ['Content-Type:application/json'], bm);
    expect(result).toContain('Content-Type');
    expect(result).toContain('application/json');
    expect(result).not.toContain('****');
  });

  test('header command redacts X-API-Key', async () => {
    const result = await handleWriteCommand('header', ['X-API-Key:sk-12345'], bm);
    expect(result).toContain('X-API-Key');
    expect(result).toContain('****');
    expect(result).not.toContain('sk-12345');
  });

  test('storage set does not echo value', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('storage', ['set', 'apiKey', 'secret-api-key-value'], bm);
    expect(result).toContain('apiKey');
    expect(result).not.toContain('secret-api-key-value');
  });

  test('forms redacts password field values', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const formsResult = await handleReadCommand('forms', [], bm);
    const forms = JSON.parse(formsResult);
    // Find password fields and verify they're redacted
    for (const form of forms) {
      for (const field of form.fields) {
        if (field.type === 'password') {
          expect(field.value === undefined || field.value === '[redacted]').toBe(true);
        }
      }
    }
  });
});

// ─── Security: Path traversal prevention (PR #26) ───────────────

describe('Path traversal prevention', () => {
  test('screenshot rejects path outside safe dirs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('screenshot', ['/etc/evil.png'], bm, () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Path must be within');
    }
  });

  test('screenshot allows /tmp path', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('screenshot', ['/tmp/test-safe.png'], bm, () => {});
    expect(result).toContain('Screenshot saved');
    try { fs.unlinkSync('/tmp/test-safe.png'); } catch {}
  });

  test('pdf rejects path outside safe dirs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('pdf', ['/home/evil.pdf'], bm, () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Path must be within');
    }
  });

  test('responsive rejects path outside safe dirs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('responsive', ['/var/evil'], bm, () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Path must be within');
    }
  });

  test('eval rejects path traversal with ..', async () => {
    try {
      await handleReadCommand('eval', ['../../etc/passwd'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Path must be within');
    }
  });

  test('eval rejects absolute path outside safe dirs', async () => {
    try {
      await handleReadCommand('eval', ['/etc/passwd'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Path must be within');
    }
  });

  test('eval allows /tmp path', async () => {
    const tmpFile = '/tmp/test-eval-safe.js';
    fs.writeFileSync(tmpFile, 'document.title');
    try {
      const result = await handleReadCommand('eval', [tmpFile], bm);
      expect(typeof result).toBe('string');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  });

  test('screenshot rejects /tmpevil prefix collision', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('screenshot', ['/tmpevil/steal.png'], bm, () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Path must be within');
    }
  });

  test('cookie-import rejects path traversal', async () => {
    try {
      await handleWriteCommand('cookie-import', ['../../etc/shadow'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      // Traversal blocked by safe-directory check (#707) or explicit .. check
      expect(err.message).toMatch(/Path must be within|Path traversal/);
    }
  });

  test('cookie-import rejects absolute path outside safe dirs', async () => {
    try {
      await handleWriteCommand('cookie-import', ['/etc/passwd'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Path must be within');
    }
  });

  test('snapshot -a -o rejects path outside safe dirs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // First get a snapshot so refs exist
    await handleMetaCommand('snapshot', ['-i'], bm, () => {});
    try {
      await handleMetaCommand('snapshot', ['-a', '-o', '/etc/evil.png'], bm, () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Path must be within');
    }
  });
});

// ─── Chain command: cookie-import in chain ──────────────────────

describe('Chain with cookie-import', () => {
  test('cookie-import works inside chain', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const tmpCookies = '/tmp/test-chain-cookies.json';
    fs.writeFileSync(tmpCookies, JSON.stringify([
      { name: 'chain_test', value: 'chain_value', domain: '127.0.0.1', path: '/' }
    ]));
    try {
      const commands = JSON.stringify([
        ['cookie-import', tmpCookies],
      ]);
      const result = await handleMetaCommand('chain', [commands], bm, async () => {});
      expect(result).toContain('[cookie-import]');
      expect(result).toContain('Loaded 1 cookie');
    } finally {
      try { fs.unlinkSync(tmpCookies); } catch {}
    }
  });
});

// ─── Network Idle Detection ─────────────────────────────────────

describe('Network idle', () => {
  test('click on fetch button waits for XHR to complete', async () => {
    await handleWriteCommand('goto', [baseUrl + '/network-idle.html'], bm);
    // Click the button that triggers a fetch → networkidle waits for it
    await handleWriteCommand('click', ['#fetch-btn'], bm);
    // The DOM should be updated by the time click returns
    const result = await handleReadCommand('js', ['document.getElementById("result").textContent'], bm);
    expect(result).toContain('Data loaded');
  });

  test('click on static button has no latency penalty', async () => {
    await handleWriteCommand('goto', [baseUrl + '/network-idle.html'], bm);
    const start = Date.now();
    await handleWriteCommand('click', ['#static-btn'], bm);
    const elapsed = Date.now() - start;
    // Static click should complete well under 2s (the networkidle timeout)
    // networkidle resolves immediately when no requests are in flight
    expect(elapsed).toBeLessThan(1500);
    const result = await handleReadCommand('js', ['document.getElementById("static-result").textContent'], bm);
    expect(result).toBe('Static action done');
  });

  test('fill triggers networkidle wait', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    // fill should complete without error (networkidle resolves immediately on static page)
    const result = await handleWriteCommand('fill', ['#email', 'idle@test.com'], bm);
    expect(result).toContain('Filled');
  });
});

// ─── Chain Pipe Format ──────────────────────────────────────────

describe('Chain pipe format', () => {
  test('pipe-delimited commands work', async () => {
    const result = await handleMetaCommand(
      'chain',
      [`goto ${baseUrl}/basic.html | js document.title`],
      bm,
      async () => {}
    );
    expect(result).toContain('[goto]');
    expect(result).toContain('[js]');
    expect(result).toContain('Test Page - Basic');
  });

  test('pipe format with quoted args', async () => {
    const result = await handleMetaCommand(
      'chain',
      [`goto ${baseUrl}/forms.html | fill #email "pipe@test.com"`],
      bm,
      async () => {}
    );
    expect(result).toContain('[fill]');
    expect(result).toContain('Filled');
    // Verify the fill actually worked
    const val = await handleReadCommand('js', ['document.querySelector("#email").value'], bm);
    expect(val).toBe('pipe@test.com');
  });

  test('JSON format still works', async () => {
    const commands = JSON.stringify([
      ['goto', baseUrl + '/basic.html'],
      ['js', 'document.title'],
    ]);
    const result = await handleMetaCommand('chain', [commands], bm, async () => {});
    expect(result).toContain('[goto]');
    expect(result).toContain('Test Page - Basic');
  });

  test('pipe format with unknown command includes error', async () => {
    const result = await handleMetaCommand(
      'chain',
      ['bogus command'],
      bm,
      async () => {}
    );
    expect(result).toContain('ERROR');
    expect(result).toContain('Unknown command: bogus');
  });
});

// ─── State Persistence ──────────────────────────────────────────

describe('State persistence', () => {
  test('state save and load round-trip', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Set a cookie so we can verify it persists
    await handleWriteCommand('cookie', ['state_test=hello'], bm);

    // Save state
    const saveResult = await handleMetaCommand('state', ['save', 'test-roundtrip'], bm, async () => {});
    expect(saveResult).toContain('State saved');
    expect(saveResult).toContain('Cookies stored in plaintext');

    // Navigate away
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);

    // Load state — should restore to basic.html with cookie
    const loadResult = await handleMetaCommand('state', ['load', 'test-roundtrip'], bm, async () => {});
    expect(loadResult).toContain('State loaded');

    // Verify we're back on basic.html
    const url = await handleReadCommand('js', ['location.pathname'], bm);
    expect(url).toContain('basic.html');

    // Clean up
    try {
      const { resolveConfig } = await import('../src/config');
      const config = resolveConfig();
      fs.unlinkSync(`${config.stateDir}/browse-states/test-roundtrip.json`);
    } catch {}
  });

  test('state save rejects invalid names', async () => {
    try {
      await handleMetaCommand('state', ['save', '../../evil'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('alphanumeric');
    }
  });

  test('state save accepts valid names', async () => {
    const result = await handleMetaCommand('state', ['save', 'my-state_1'], bm, async () => {});
    expect(result).toContain('State saved');
    // Clean up
    try {
      const { resolveConfig } = await import('../src/config');
      const config = resolveConfig();
      fs.unlinkSync(`${config.stateDir}/browse-states/my-state_1.json`);
    } catch {}
  });

  test('state load rejects missing state', async () => {
    try {
      await handleMetaCommand('state', ['load', 'nonexistent-state-xyz'], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('State not found');
    }
  });

  test('state requires action and name', async () => {
    try {
      await handleMetaCommand('state', [], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── Frame (Iframe Support) ─────────────────────────────────────

describe('Frame', () => {
  test('frame switch to iframe and back', async () => {
    await handleWriteCommand('goto', [baseUrl + '/iframe.html'], bm);

    // Verify we're on the main page
    const mainTitle = await handleReadCommand('js', ['document.getElementById("main-title").textContent'], bm);
    expect(mainTitle).toBe('Main Page');

    // Switch to iframe by CSS selector
    const switchResult = await handleMetaCommand('frame', ['#test-frame'], bm, async () => {});
    expect(switchResult).toContain('Switched to frame');

    // Verify we can read iframe content
    const frameTitle = await handleReadCommand('js', ['document.getElementById("frame-title").textContent'], bm);
    expect(frameTitle).toBe('Inside Frame');

    // Switch back to main
    const mainResult = await handleMetaCommand('frame', ['main'], bm, async () => {});
    expect(mainResult).toBe('Switched to main frame');

    // Verify we're back on the main page
    const mainTitleAgain = await handleReadCommand('js', ['document.getElementById("main-title").textContent'], bm);
    expect(mainTitleAgain).toBe('Main Page');
  });

  test('snapshot shows frame context header', async () => {
    await handleWriteCommand('goto', [baseUrl + '/iframe.html'], bm);
    await handleMetaCommand('frame', ['#test-frame'], bm, async () => {});

    const snap = await handleMetaCommand('snapshot', ['-i'], bm, async () => {});
    expect(snap).toContain('[Context: iframe');

    // Clean up — return to main
    await handleMetaCommand('frame', ['main'], bm, async () => {});
  });

  test('goto throws error when in frame context', async () => {
    await handleWriteCommand('goto', [baseUrl + '/iframe.html'], bm);
    await handleMetaCommand('frame', ['#test-frame'], bm, async () => {});

    try {
      await handleWriteCommand('goto', ['https://example.com'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Cannot use goto inside a frame');
    }

    await handleMetaCommand('frame', ['main'], bm, async () => {});
  });

  test('frame requires argument', async () => {
    try {
      await handleMetaCommand('frame', [], bm, async () => {});
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('fill works inside iframe', async () => {
    await handleWriteCommand('goto', [baseUrl + '/iframe.html'], bm);
    await handleMetaCommand('frame', ['#test-frame'], bm, async () => {});

    const result = await handleWriteCommand('fill', ['#frame-input', 'hello from frame'], bm);
    expect(result).toContain('Filled');

    const value = await handleReadCommand('js', ['document.getElementById("frame-input").value'], bm);
    expect(value).toBe('hello from frame');

    await handleMetaCommand('frame', ['main'], bm, async () => {});
  });
});
