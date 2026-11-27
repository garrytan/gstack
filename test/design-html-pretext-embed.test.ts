/**
 * /design-html's Pretext embedding recipe, run as written. "### Pretext Source
 * Embedding" in the generated design-html/SKILL.md tells the agent to copy
 * design-html/vendor/pretext-embed.html into the page, splice the vendored
 * bundle in at its PRETEXT_BUNDLE line with a documented awk command, and put
 * page code at its "// page code" line. The scaffold keeps the bundle in an
 * inert <script type="text/plain"> block and imports it through a Blob URL.
 * The static tier runs everywhere and pins the scaffold and what lets the
 * bundle sit in a raw-text <script>. The Chromium tier runs the documented awk
 * command on a page holding the scaffold, adds page code that calls every name
 * the scaffold binds (with variable names the minified bundle also uses), and
 * loads the page from file:// and from a 127.0.0.1 server. Its negative
 * control builds the old recipe (bundle and page code in one module) and
 * expects the ReferenceError that shipped. Chromium is driven through
 * playwright as in test/dom-dump-hygiene.test.ts and self-skips when no
 * Chromium is installed and on Windows.
 *
 * Value: protects=a page built from the documented Pretext recipe binds prepare/layout/... and runs; fails_when=the recipe puts page code in the bundle's module (ReferenceError), the splice command or the import breaks, or the bundle gains a sequence that ends its raw-text <script>; why_new=nothing ran the recipe, so a recipe that threw on first use shipped (#4855); seam=none; no_claim=the CDN fallback, which needs the network
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type Browser } from 'playwright';
import { between } from './helpers/prompt-structure';

const ROOT = path.resolve(import.meta.dir, '..');
const CHROMIUM = process.env.GSTACK_CHROMIUM_PATH || (() => { try { return chromium.executablePath(); } catch { return ''; } })();
const CHROMIUM_AVAILABLE = Boolean(CHROMIUM) && fs.existsSync(CHROMIUM);
const POSIX = process.platform !== 'win32';

const VENDOR = path.join(ROOT, 'design-html', 'vendor', 'pretext.js');
const BUNDLE = fs.readFileSync(VENDOR, 'utf-8');
const SCAFFOLD = fs.readFileSync(path.join(ROOT, 'design-html', 'vendor', 'pretext-embed.html'), 'utf-8');
const SECTION = between(fs.readFileSync(path.join(ROOT, 'design-html', 'SKILL.md'), 'utf-8'), '### Pretext Source Embedding', '### HTML Generation');
const PAGE_CODE_LINE = '// page code';
const NAMES = ['prepare', 'layout', 'prepareWithSegments', 'walkLineRanges', 'layoutNextLine', 'layoutWithLines'];
const LINE_HEIGHT = 20;
const WIDTH = 90;

/** Page code calling every name the scaffold binds. `r` and `h` are also top-level names in the minified bundle. */
function pageCode(handle: string, result: string): string {
  return `await document.fonts.ready
const text = 'Pretext measures this sentence once and lays it out across several narrow lines'
const font = '16px sans-serif'
const ${handle} = prepareWithSegments(text, font)
const ${result} = layout(prepare(text, font), ${WIDTH}, ${LINE_HEIGHT})
document.body.dataset.result = JSON.stringify({
  lineCount: ${result}.lineCount,
  height: ${result}.height,
  walked: walkLineRanges(${handle}, ${WIDTH}, () => {}),
  lines: layoutWithLines(${handle}, ${WIDTH}, ${LINE_HEIGHT}).lines.length,
  firstLine: layoutNextLine(${handle}, { segmentIndex: 0, graphemeIndex: 0 }, ${WIDTH})?.text ?? null,
})`;
}

/** The documented splice command, its <VENDOR> placeholder as the vendored bundle's path. */
function spliceCommand(): string {
  const cmd = SECTION.match(/`(awk -v f="<VENDOR>" [^`]+)`/)?.[1];
  if (!cmd) throw new Error('design-html/SKILL.md: no awk splice command under "### Pretext Source Embedding"');
  return cmd.replace('<VENDOR>', VENDOR);
}

function htmlDocument(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pretext recipe</title><link rel="icon" href="data:,"></head><body>\n${body}\n</body></html>`;
}

describe('/design-html Pretext embedding recipe (static)', () => {
  test('the skill points at the scaffold; the scaffold embeds the bundle once as inert text, imports it from a Blob URL and revokes it', () => {
    expect(SECTION).toContain('Copy `pretext-embed.html` beside it into the page');
    expect(SECTION).toContain(`put page code at \`${PAGE_CODE_LINE}\``);
    expect(SCAFFOLD.split('PRETEXT_BUNDLE').length - 1).toBe(1);
    expect(SCAFFOLD).toContain('<script type="text/plain" id="pretext-src">\nPRETEXT_BUNDLE\n</script>');
    expect(SCAFFOLD).toContain("new Blob([document.getElementById('pretext-src').text], { type: 'text/javascript' })");
    expect(SCAFFOLD).toContain('URL.revokeObjectURL(pretextURL)');
    expect(SCAFFOLD.indexOf(PAGE_CODE_LINE)).toBeGreaterThan(SCAFFOLD.indexOf('await import(pretextURL)'));
    expect(SCAFFOLD.lastIndexOf('</script>')).toBeGreaterThan(SCAFFOLD.indexOf(PAGE_CODE_LINE));
    for (const name of NAMES) {
      expect(BUNDLE, name).toMatch(new RegExp(`\\w+ as ${name}\\b`));
      expect(SCAFFOLD, name).toMatch(new RegExp(`[{,] ${name}[ ,]`));
    }
  });

  test('the vendored bundle can sit in a raw-text <script>: no closing tag and no comment opener', () => {
    expect(BUNDLE).not.toMatch(/<\/script/i);
    expect(BUNDLE).not.toContain('<!--');
  });
});

describe.skipIf(!CHROMIUM_AVAILABLE || !POSIX)('/design-html Pretext embedding recipe (Playwright Chromium)', () => {
  async function load(browser: Browser, url: string): Promise<{ errors: string[]; raw: string }> {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      const raw = await page.waitForFunction(() => document.body.dataset.result, null, { timeout: 10_000 })
        .then((h) => h.jsonValue() as Promise<string>)
        .catch(() => '');
      return { errors, raw };
    } finally {
      await page.close();
    }
  }

  test('a page built from the recipe binds every Pretext name and runs from file:// and 127.0.0.1; the old recipe throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pretext-embed-'));
    let server: ReturnType<typeof Bun.serve> | undefined;
    let browser: Browser | undefined;
    try {
      const finalized = path.join(dir, 'finalized.html');
      fs.writeFileSync(finalized, htmlDocument(SCAFFOLD.replace(PAGE_CODE_LINE, pageCode('h', 'r'))));
      const splice = Bun.spawnSync(['sh', '-c', spliceCommand()], { cwd: dir, timeout: 30_000 });
      expect(splice.exitCode, splice.stderr.toString()).toBe(0);
      const built = fs.readFileSync(finalized, 'utf-8');
      expect(built).toContain(`<script type="text/plain" id="pretext-src">\n${BUNDLE}</script>`);
      expect(built).not.toContain('PRETEXT_BUNDLE');
      const pages: Record<string, string> = {
        '/finalized.html': built,
        '/old.html': htmlDocument(`<script type="module">\n${BUNDLE}\n${pageCode('seg', 'res')}\n</script>`),
      };
      server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch: (req) => {
          const html = pages[new URL(req.url).pathname];
          return html ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('not found', { status: 404 });
        },
      });
      browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, timeout: 90_000 });
      for (const url of [`file://${finalized}`, `http://127.0.0.1:${server.port}/finalized.html`]) {
        const { errors, raw } = await load(browser, url);
        expect(errors, url).toEqual([]);
        expect(raw, `${url}: the page code never finished`).not.toBe('');
        const result = JSON.parse(raw);
        expect(result.lineCount, url).toBeGreaterThan(1);
        expect(result.height, url).toBe(result.lineCount * LINE_HEIGHT);
        expect(result.walked, url).toBe(result.lineCount);
        expect(result.lines, url).toBe(result.lineCount);
        expect(typeof result.firstLine === 'string' && result.firstLine.length > 0, url).toBe(true);
      }
      const old = await load(browser, `http://127.0.0.1:${server.port}/old.html`);
      expect(old.raw).toBe('');
      expect(old.errors).toContain('ReferenceError: prepareWithSegments is not defined');
    } finally {
      await browser?.close();
      server?.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
