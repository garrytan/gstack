import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import { BrowserManager } from '../../src/browser-manager';
import { TabSession } from '../../src/tab-session';
import { handleWriteCommand } from '../../src/write-commands';
import { SAFE_DIRECTORIES } from '../../src/path-security';
import { isPathWithin } from '../../src/platform';

const project = fs.realpathSync(process.cwd());
const root = path.dirname(project);
const outside = path.join(root, 'private', 'outside.txt');
const temp = path.join(root, 'tmp', 'temp.txt');
if (SAFE_DIRECTORIES.some(dir => isPathWithin(outside, dir))) {
  throw new Error('Upload fixture outside target is inside the allowed directories');
}
for (const dir of [process.env.HOME!, process.env.GSTACK_HOME!, path.dirname(temp)]) {
  if (!isPathWithin(fs.realpathSync(dir), root)) throw new Error('Upload fixture state escaped its private root');
}

fs.mkdirSync('nested');
fs.writeFileSync('allowed.txt', 'synthetic allowed bytes');
fs.writeFileSync('nested/allowed.txt', 'synthetic allowed bytes');
fs.writeFileSync(outside, 'synthetic outside bytes');
fs.writeFileSync(temp, 'synthetic temp bytes');
fs.symlinkSync(outside, 'linked.txt');
fs.symlinkSync(path.join(root, 'private'), 'outside-dir', 'dir');
fs.symlinkSync(path.join(project, 'allowed.txt'), 'safe-link.txt');
fs.symlinkSync(path.join(project, 'nested'), 'safe-dir', 'dir');
fs.symlinkSync(path.join(root, 'private', 'missing.txt'), 'broken.txt');

const scenarios: Record<string, { paths: string[]; directory?: boolean }> = {
  'relative-file-link': { paths: ['linked.txt'] },
  'absolute-file-link': { paths: [path.join(project, 'linked.txt')] },
  'absolute-outside': { paths: [outside] },
  'relative-traversal': { paths: [path.relative(project, outside)] },
  'relative-directory-link': { paths: ['outside-dir/outside.txt'] },
  'absolute-directory-link': { paths: [path.join(project, 'outside-dir', 'outside.txt')] },
  'outside-directory-upload': { paths: ['outside-dir'], directory: true },
  'mixed-valid-first': { paths: ['allowed.txt', 'linked.txt'] },
  'mixed-invalid-first': { paths: ['linked.txt', 'allowed.txt'] },
  'mixed-outside-absolute': { paths: ['allowed.txt', outside] },
  'broken-link': { paths: ['broken.txt'] },
  'missing-file': { paths: ['missing.txt'] },
  'mixed-missing-file': { paths: ['allowed.txt', 'missing.txt'] },
  'relative-allowed': { paths: ['allowed.txt'] },
  'absolute-allowed': { paths: [path.join(project, 'allowed.txt')] },
  'safe-file-link': { paths: ['safe-link.txt'] },
  'safe-directory-link': { paths: ['safe-dir/allowed.txt'] },
  'safe-directory-upload': { paths: ['safe-dir'], directory: true },
  'multiple-allowed': { paths: ['allowed.txt', temp] },
};

const browser = await chromium.launch({ executablePath: process.argv[2], headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const session = new TabSession(page);
  const bm = new BrowserManager();
  const observations: Record<string, unknown> = {};
  for (const selector of ['css', 'ref']) {
    for (const [name, { paths, directory }] of Object.entries(scenarios)) {
      await page.setContent(`<input id="upload" type="file" multiple ${directory ? 'webkitdirectory' : ''}>`);
      await page.evaluate(() => {
        document.body.dataset.inputEvents = '0';
        document.querySelector('input')!.addEventListener('input', () => {
          document.body.dataset.inputEvents = String(Number(document.body.dataset.inputEvents) + 1);
        });
      });
      session.setRefMap(new Map([['e1', { locator: page.locator('#upload'), role: 'input', name: 'upload' }]]));
      let error: string | null = null;
      let result: string | null = null;
      try {
        result = await handleWriteCommand('upload', [selector === 'ref' ? '@e1' : '#upload', ...paths], session, bm);
      } catch (err) {
        error = (err as Error).message;
      }
      const delivered = await page.evaluate(async () => ({
        files: await Promise.all(Array.from(document.querySelector('input')!.files!).map(async file => ({
          name: file.name,
          text: await file.text(),
        }))),
        inputEvents: Number(document.body.dataset.inputEvents),
      }));
      observations[`${selector}:${name}`] = { error, result, ...delivered };
    }
  }
  console.log(JSON.stringify(observations));
} finally {
  await browser.close();
}
