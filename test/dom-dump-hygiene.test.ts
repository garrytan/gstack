/**
 * lib/dom-dump.js hygiene, exercised in a real Chromium page. The script is the
 * arrow function Aside runs through `pg.evaluate` and the fallback engine runs
 * through `$B js`; here Playwright's `page.evaluate` calls it the same way.
 * Chromium is driven directly through playwright-core (the engine the browse
 * daemon wraps) rather than through the daemon: no state file, no health
 * window, nothing to starve under a sharded CI run. Self-skips when the
 * Playwright Chromium bundle is not installed (`npx playwright install chromium`).
 *
 * Pins the rules the DOM dump promises before a page leaves the browser:
 * input values dropped, long data: URLs replaced (attributes, inlined CSS, and
 * existing <style> nodes), <meta content> emptied (viewport kept), query
 * strings cut from every URL attribute and from CSS url() in style attributes,
 * <style> nodes, and inlined sheets, script bodies emptied, linked stylesheets
 * inlined with author hex restored, cross-origin sheets named in the trailing
 * note and removed from the markup, print sheets wrapped in their @media,
 * alternate sheets dropped, <template> and <noscript> subtrees dropped, inline
 * on* handlers dropped, srcdoc emptied.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { DOM_DUMP_SCRIPT, DOM_DUMP_STYLE_ATTR, DOM_DUMP_NOTE_PREFIX } from '../lib/dom-dump-script';

const CHROMIUM = process.env.GSTACK_CHROMIUM_PATH || (() => { try { return chromium.executablePath(); } catch { return ''; } })();
const CHROMIUM_AVAILABLE = Boolean(CHROMIUM) && fs.existsSync(CHROMIUM);
const POSIX = process.platform !== 'win32';

describe.skipIf(!CHROMIUM_AVAILABLE || !POSIX)('lib/dom-dump.js in a real DOM (Playwright Chromium)', () => {
  test('applies every hygiene rule and inlines the linked stylesheet', async () => {
    const site = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-dom-dump-site-'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-dom-dump-out-'));
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname.replace(/^\//, '') || 'index.html';
        const f = path.join(site, p);
        return fs.existsSync(f) ? new Response(Bun.file(f)) : new Response('nope', { status: 404 });
      },
    });
    const big = 'data:image/png;base64,' + 'A'.repeat(1500);
    fs.writeFileSync(path.join(site, 'styles.css'), '.hero { background: linear-gradient(135deg, #6366f1, #8b5cf6); } .x { background-image: url("' + big + '"); } .y { background: url("/y.png?token=SECRETCSS") }\n');
    fs.writeFileSync(path.join(site, 'print.css'), '.p { font-size: 4px }\n');
    fs.writeFileSync(path.join(site, 'alt.css'), '.alt { color: #ff00ff }\n');
    fs.writeFileSync(path.join(site, 'index.html'), `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="description" content="SECRET DESCRIPTION">
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="http://127.0.0.1:1/cross-origin.css">
<link rel="stylesheet" media="print" href="print.css"><link rel="alternate stylesheet" href="alt.css" title="alt">
<script>window.__x = "SCRIPT BODY";</script></head><body>
<input value="SECRET INPUT"><textarea>SECRET TEXT</textarea>
<a href="/page?token=SECRET">link</a>
<img src="/img.png?sig=SECRETSIG" srcset="/a.png?s=SECRETSET 1x, /b.png?s=SECRETSET2 2x">
<form action="/submit?csrf=SECRETCSRF"><button formaction="/alt?f=SECRETFORM" onclick="track('SECRETHANDLER')">go</button></form>
<template><input value="SECRET TEMPLATE"><a href="/t?x=SECRETTPL">t</a></template><noscript><img src="/px.gif?id=SECRETNOSCRIPT"></noscript>
<div style="background-image:url(https://cdn.example/x.png?X-Amz-Signature=SECRETSIG2)">s</div><iframe srcdoc="<input value='SECRETSRCDOC'>"></iframe><svg><use xlink:href="/s.svg?v=SECRETXLINK"></use></svg>
<style>.inline { background: url("${big}") }</style>
<div data-long="${'L'.repeat(40)}" data-short="ok" title="${big}">x</div>
<img src="${big}">
</body></html>`);
    const url = `http://127.0.0.1:${server.port}/index.html`;
    const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, timeout: 90_000 });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      const html = String(await page.evaluate(`(${DOM_DUMP_SCRIPT})()`));
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain(`<style ${DOM_DUMP_STYLE_ATTR}=""`);
      expect(html).toContain('#6366f1');
      expect(html).not.toMatch(/<link[^>]*href="styles\.css"/);
      expect(html).not.toMatch(/<link[^>]*cross-origin\.css/); // named in the note, removed from the markup: the engine never sees a remote stylesheet
      expect(html).toContain(`<!-- ${DOM_DUMP_NOTE_PREFIX} `);
      expect(html).toContain('cross-origin stylesheets not resolved');
      expect(html).toContain('scripts stripped: 1');
      expect(html).not.toContain('SCRIPT BODY');
      expect(html).not.toContain('SECRET INPUT');
      expect(html).not.toContain('SECRET TEXT');
      expect(html).not.toContain('SECRET DESCRIPTION');
      expect(html).toContain('content="width=device-width"');
      expect(html).toContain('href="/page"');
      expect(html).not.toContain('token=SECRET');
      expect(html).not.toContain('SECRETSIG');
      expect(html).not.toContain('SECRETSET');
      expect(html).not.toContain('SECRETCSRF');
      expect(html).not.toContain('SECRETFORM');
      expect(html).not.toContain('SECRETHANDLER');
      expect(html).not.toMatch(/ onclick=/);
      expect(html).not.toContain('SECRET TEMPLATE');
      expect(html).not.toContain('SECRETTPL');
      expect(html).not.toContain('SECRETNOSCRIPT');
      expect(html).not.toMatch(/<template|<noscript/);
      expect(html).not.toContain('SECRETSIG2');
      expect(html).toContain('url(https://cdn.example/x.png)');
      expect(html).not.toContain('SECRETCSS');
      expect(html).toContain('url("/y.png")');
      expect(html).not.toContain('SECRETSRCDOC');
      expect(html).not.toContain('SECRETXLINK');
      expect(html).toMatch(/@media print \{[\s\S]*font-size: 4px[\s\S]*\}/); // a print sheet is scanned as print CSS, not as the page's styles
      expect(html).not.toContain('#ff00ff'); // an alternate stylesheet is not active CSS
      expect(html).not.toMatch(/<link[^>]*alt\.css/);
      expect(html).toContain('srcset="/a.png 1x, /b.png 2x"');
      expect(html).not.toContain('L'.repeat(40));
      expect(html).toContain('data-short="ok"');
      expect(html).not.toContain('A'.repeat(1500));
      expect(html).toContain('data:,gstack-stripped');
    } finally {
      await browser.close().catch(() => {});
      server.stop(true);
      fs.rmSync(site, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
