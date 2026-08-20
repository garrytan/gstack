/**
 * Static invariant: every gstackInjectToTerminal call in extension/*.js
 * must be preceded by an await on gstackScanForPTYInject on the same code
 * path (#1370 / D6).
 *
 * Why static, not runtime: extension/ runs in the chrome-extension origin;
 * we can't easily exercise it in a Bun test. The invariant codex's plan
 * review demanded is "no caller skips the scan." We get that by parsing
 * the JS source as text and asserting structural rules.
 *
 * The rules (kept simple — false positives are worse than false
 * negatives here since the wave has only two callers):
 *
 *   Rule 1: every file that calls gstackInjectToTerminal must also call
 *           gstackScanForPTYInject.
 *
 *   Rule 2: in any function that calls gstackInjectToTerminal, an
 *           `await ... gstackScanForPTYInject` MUST appear before the
 *           inject call when measured by source position (same function
 *           body).
 *
 *   Exemption: extension/sidepanel-terminal.js defines the inject
 *           function itself; it doesn't need to call scan-first inside
 *           the definition.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const EXTENSION_DIR = join(import.meta.dir, '..', 'extension');
const INJECT_FN = 'gstackInjectToTerminal';
const SCAN_FN = 'gstackScanForPTYInject';

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function findInjectCallSites(content: string): number[] {
  // Find positions of `gstackInjectToTerminal(` or `gstackInjectToTerminal?.(`
  // — but exclude the function DEFINITION (window.gstackInjectToTerminal = ).
  const sites: number[] = [];
  const callRe = /window\.gstackInjectToTerminal\s*\??\.?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(content)) !== null) {
    // Look back ~30 chars; if "window.gstackInjectToTerminal =" appears
    // right before, it's the definition, not a call.
    const back = Math.max(0, match.index - 30);
    const window30 = content.slice(back, match.index);
    if (window30.includes('gstackInjectToTerminal =')) continue;
    sites.push(match.index);
  }
  return sites;
}

function callsScan(content: string): boolean {
  return content.includes(SCAN_FN);
}

function findEnclosingFunctionStart(content: string, callerPos: number): number {
  // Walk backwards from callerPos looking for the most recent `function`
  // keyword, `=> {`, or `addEventListener('click',\s*async`. Conservative
  // — falls back to file start.
  const text = content.slice(0, callerPos);
  const candidates = [
    text.lastIndexOf('function '),
    text.lastIndexOf('=> {'),
    text.lastIndexOf('async function'),
    text.lastIndexOf('async ('),
    text.lastIndexOf('async () =>'),
  ];
  const idx = Math.max(...candidates);
  return idx >= 0 ? idx : 0;
}

describe('extension/* PTY injection invariant (#1370 / D6)', () => {
  test('every inject call site is preceded by a scan call in the same enclosing function', () => {
    const files = listJsFiles(EXTENSION_DIR);
    const offenders: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const sites = findInjectCallSites(content);
      if (sites.length === 0) continue;

      // Rule 1: file must reference the scan function.
      if (!callsScan(content)) {
        // Special-case sidepanel-terminal.js: it DEFINES the inject
        // function but doesn't call it from inside.
        if (file.endsWith('sidepanel-terminal.js')) continue;
        offenders.push(`${file} calls ${INJECT_FN} but never references ${SCAN_FN}`);
        continue;
      }

      // Rule 2: for each call site, find the enclosing function body and
      // verify a scan call precedes the inject within that body.
      for (const pos of sites) {
        const fnStart = findEnclosingFunctionStart(content, pos);
        const fnBody = content.slice(fnStart, pos);
        if (!fnBody.includes(SCAN_FN)) {
          const lineNum = content.slice(0, pos).split('\n').length;
          offenders.push(`${file}:${lineNum} ${INJECT_FN} call not preceded by ${SCAN_FN} in enclosing function`);
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'PTY-injection invariant violated:\n  - ' + offenders.join('\n  - '),
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test('sidepanel-terminal.js defines both gstackInjectToTerminal and gstackScanForPTYInject', () => {
    const file = join(EXTENSION_DIR, 'sidepanel-terminal.js');
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('window.gstackInjectToTerminal');
    expect(content).toContain('window.gstackScanForPTYInject');
  });

  test('inject function stays synchronous (D6 contract preservation)', () => {
    const file = join(EXTENSION_DIR, 'sidepanel-terminal.js');
    const content = readFileSync(file, 'utf-8');
    // The definition line should NOT contain "async" — async inject would
    // break every existing caller using `const ok = ...?.()` pattern.
    const match = content.match(/window\.gstackInjectToTerminal\s*=\s*(async\s+)?function/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBeUndefined(); // no `async` modifier
  });
});
