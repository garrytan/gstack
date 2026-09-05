/**
 * lib/aside-render.ts — the Aside-backed local-HTML renderer that replaced the
 * browse daemon for make-pdf, diagrams, and design previews.
 *
 * Pure pins run everywhere; the live render runs only where Aside is installed
 * and open (macOS dev machines) and self-skips elsewhere.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildRenderScript, lengthToInches, paperInches, renderWithAside, RENDER_SENTINEL } from '../lib/aside-render';
import { asideAvailable } from './helpers/aside-available';

describe('aside-render: option mapping', () => {
  test('lengths convert to inches (CDP unit)', () => {
    expect(lengthToInches('1in')).toBe(1);
    expect(lengthToInches('25.4mm')).toBeCloseTo(1, 6);
    expect(lengthToInches('2.54cm')).toBeCloseTo(1, 6);
    expect(lengthToInches('72pt')).toBe(1);
    expect(lengthToInches('96px')).toBe(1);
    expect(lengthToInches(48)).toBe(0.5);
    expect(lengthToInches(undefined)).toBeUndefined();
    expect(() => lengthToInches('1 furlong')).toThrow();
  });

  test('paper formats resolve case-insensitively', () => {
    expect(paperInches('Letter')).toEqual([8.5, 11]);
    expect(paperInches('a4')![0]).toBeCloseTo(8.27, 2);
    expect(paperInches('tabloid')).toEqual([11, 17]);
    expect(paperInches('napkin')).toBeUndefined();
  });
});

describe('aside-render: generated script follows the Aside contract', () => {
  const script = buildRenderScript('http://127.0.0.1:1/x.html', {
    file: '/x.html',
    waitFor: { selector: '#done', expression: 'window.ready' },
    steps: [
      { kind: 'pdf', out: '/tmp/a.pdf', options: { paperWidth: 8.5, paperHeight: 11, generateTaggedPDF: true, headerTemplate: '<b>h</b>', displayHeaderFooter: true, waitForPagedJs: true } },
      { kind: 'screenshot', out: '/tmp/m.jpg', width: 375, type: 'jpeg', quality: 60 },
      { kind: 'screenshot', out: '/tmp/el.png', selector: '#hero' },
      { kind: 'eval', expression: 'window.__svg', out: '/tmp/d.svg' },
      { kind: 'eval', expression: 'document.title' },
    ],
  });

  test('opens about:blank, installs the console hook, then loads with waitUntil load', () => {
    expect(script).toContain('openTab("about:blank")');
    expect(script.indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(script.indexOf('pg.goto('));
    expect(script).toContain('waitUntil: "load"');
    expect(script).toContain('waitForSelector("#done", { state: "attached"');
    expect(script).toContain('waitFor expression never became truthy');
  });

  test('pdf goes through CDP printToPDF with the full option set and the Paged.js wait', () => {
    expect(script).toContain('Page.printToPDF');
    expect(script).toContain('"generateTaggedPDF":true');
    expect(script).toContain('"headerTemplate":"<b>h</b>"');
    expect(script).toContain('__pagedjsAfterFired');
    expect(script).not.toContain('pg.pdf(');
  });

  test('sized screenshots emulate device metrics and clear them; element shots use the locator', () => {
    expect(script).toContain('Emulation.setDeviceMetricsOverride');
    expect(script).toContain('"width":375');
    expect(script).toContain('"mobile":true');
    expect(script).toContain('Emulation.clearDeviceMetricsOverride');
    expect(script).toContain('pg.locator("#hero").screenshot(');
    expect(script).not.toContain('setViewportSize');
  });

  test('evals run in-page via eval, data URLs decode to bytes, inline results are fenced', () => {
    expect(script).toContain('(0, eval)(src)');
    expect(script).toContain('/^data:[^;]+;base64,/');
    expect(script).toContain('EVAL_START 4');
    expect(script).toContain('EVAL_END 4');
  });

  test('every artifact stays inside the sandbox dir and the script ends with close + sentinel', () => {
    expect(script).toContain('path.join(pwd, "gstack-render-0.pdf")');
    expect(script).toContain('"gstack-render-3.svg"');
    expect(script).toContain('console.log("ASIDE_DIR=" + pwd)');
    const tail = script.trim().split('\n').slice(-2);
    expect(tail[0]).toBe('await closeTab(pg);');
    expect(tail[1]).toBe(`console.log(${JSON.stringify(RENDER_SENTINEL)});`);
  });
});

describe('aside-render: live render (needs the Aside app)', () => {
  const live = asideAvailable();
  test.skipIf(!live)('renders a served HTML file to PDF, screenshot, and eval outputs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-render-live-'));
    fs.writeFileSync(path.join(dir, 'doc.html'), '<!doctype html><title>Live Probe</title><h1>Hello Aside</h1><div id="done"></div><script>window.__v = "x".repeat(200000)</script>');
    try {
      const out = await renderWithAside({
        file: path.join(dir, 'doc.html'),
        waitFor: { selector: '#done' },
        steps: [
          { kind: 'pdf', out: path.join(dir, 'out.pdf'), options: { paperWidth: 8.5, paperHeight: 11, generateTaggedPDF: true, printBackground: true } },
          { kind: 'screenshot', out: path.join(dir, 'm.jpg'), width: 375, type: 'jpeg', quality: 50 },
          { kind: 'eval', expression: 'window.__v', out: path.join(dir, 'v.txt') },
          { kind: 'eval', expression: 'document.title' },
        ],
        timeoutMs: 90_000,
      });
      expect(out.error).toBeUndefined();
      expect(out.ok).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'out.pdf')).subarray(0, 4).toString()).toBe('%PDF');
      expect(fs.statSync(path.join(dir, 'm.jpg')).size).toBeGreaterThan(1000);
      expect(fs.statSync(path.join(dir, 'v.txt')).size).toBe(200000);
      expect(out.evals[3]).toBe('Live Probe');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
