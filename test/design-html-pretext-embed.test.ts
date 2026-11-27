/**
 * /design-html's Pretext embedding recipe, run as written in a real Chromium
 * page. The test takes the ```html block under "Pretext Source Embedding" in the
 * generated SKILL.md, splices the vendored bundle in at its PRETEXT_BUNDLE line
 * and page code in before its closing </script>, and loads the page from
 * file:// (the `open` fallback) and from a loopback server (the live preview and
 * gstack-render). The page code calls each name the recipe binds, using
 * variable names a minified bundle also uses, the way real page code does.
 * Chromium is driven through playwright-core directly, as in
 * test/dom-dump-hygiene.test.ts. Self-skips when the Playwright Chromium bundle
 * is not installed (`npx playwright install chromium`).
 *
 * Value: protects=a page built from the documented Pretext recipe binds prepare/layout/... and runs; fails_when=the recipe puts page code in the bundle's module (ReferenceError) or its import fails on file://; why_new=nothing ran the recipe, so a recipe that threw on first use shipped; seam=none
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { between } from './helpers/prompt-structure';

const ROOT = path.resolve(import.meta.dir, '..');
const CHROMIUM = process.env.GSTACK_CHROMIUM_PATH || (() => { try { return chromium.executablePath(); } catch { return ''; } })();
const CHROMIUM_AVAILABLE = Boolean(CHROMIUM) && fs.existsSync(CHROMIUM);
const POSIX = process.platform !== 'win32';

const MARKER = 'PRETEXT_BUNDLE';
const LINE_HEIGHT = 20;
const WIDTH = 90;

// `r` and `h` are top-level names in the minified bundle: pasted into the
// bundle's own module, this code fails before it runs.
const PAGE_CODE = `
await document.fonts.ready
const text = 'Pretext measures this sentence once and lays it out across several narrow lines'
const font = '16px sans-serif'
const h = prepareWithSegments(text, font)
const r = layout(prepare(text, font), ${WIDTH}, ${LINE_HEIGHT})
document.body.dataset.result = JSON.stringify({
  lineCount: r.lineCount,
  height: r.height,
  walked: walkLineRanges(h, ${WIDTH}, () => {}),
  lines: layoutWithLines(h, ${WIDTH}, ${LINE_HEIGHT}).lines.length,
  firstLine: layoutNextLine(h, { segmentIndex: 0, graphemeIndex: 0 }, ${WIDTH})?.text ?? null,
})
`;

/** The recipe's HTML with list-item indentation removed. */
function recipe(): string {
  const skill = fs.readFileSync(path.join(ROOT, 'design-html', 'SKILL.md'), 'utf-8');
  const section = between(skill, '### Pretext Source Embedding', '### HTML Generation');
  const block = section.match(/```html\n([\s\S]*?)\n[ \t]*```/);
  if (!block) throw new Error('design-html/SKILL.md: no ```html recipe under "### Pretext Source Embedding"');
  return block[1].replace(/^ {2}/gm, '');
}

function buildPage(): string {
  const bundle = fs.readFileSync(path.join(ROOT, 'design-html', 'vendor', 'pretext.js'), 'utf-8');
  const html = recipe();
  expect(html.split(MARKER).length - 1, `the recipe has exactly one ${MARKER} line`).toBe(1);
  const spliced = html.replace(MARKER, () => bundle.trimEnd());
  const close = spliced.lastIndexOf('</script>');
  expect(close, 'the recipe ends in the page module').toBeGreaterThan(spliced.indexOf(bundle.trimEnd()));
  const page = spliced.slice(0, close) + PAGE_CODE + spliced.slice(close);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pretext recipe</title></head><body>\n${page}\n</body></html>`;
}

describe.skipIf(!CHROMIUM_AVAILABLE || !POSIX)('/design-html Pretext embedding recipe (Playwright Chromium)', () => {
  test('a page built from the recipe binds every Pretext name and runs from file:// and from a loopback server', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pretext-embed-'));
    const file = path.join(dir, 'finalized.html');
    fs.writeFileSync(file, buildPage());
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(Bun.file(file), { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
    const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, timeout: 90_000 });
    try {
      for (const url of [`file://${file}`, `http://127.0.0.1:${server.port}/finalized.html`]) {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
        const raw = await page.waitForFunction(() => document.body.dataset.result, null, { timeout: 10_000 })
          .then((h) => h.jsonValue() as Promise<string>)
          .catch(() => '');
        expect(errors, url).toEqual([]);
        expect(raw, `${url}: the page code never finished`).not.toBe('');
        const result = JSON.parse(raw);
        expect(result.lineCount, url).toBeGreaterThan(1);
        expect(result.height, url).toBe(result.lineCount * LINE_HEIGHT);
        expect(result.walked, url).toBe(result.lineCount);
        expect(result.lines, url).toBe(result.lineCount);
        expect(typeof result.firstLine === 'string' && result.firstLine.length > 0, url).toBe(true);
        await page.close();
      }
    } finally {
      await browser.close();
      server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
