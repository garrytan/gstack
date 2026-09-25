import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { BrowserManager } from '../src/browser-manager';
import { TabSession } from '../src/tab-session';
import { handleWriteCommand } from '../src/write-commands';

let browser: Browser;
const actionBudget = 5_000;
const diagnosticBudget = 1_000;
const schedulingTolerance = 750;

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

for (const ref of [false, true]) {
  for (const detach of [false, true]) {
    test(`click ${ref ? 'resolved ref' : 'selector'} ${detach ? 'count-then-detach race' : 'missing target'} stays bounded`, async () => {
      const page = await browser.newPage();
      const session = new TabSession(page);
      const manager = new BrowserManager();
      const locator = page.locator('#target');
      await page.setContent('<button id="target" disabled>Waiting</button>');
      if (ref) session.setRefMap(new Map([['e1', { locator, role: 'button', name: 'Waiting' }]]));
      const resolve = session.resolveRef.bind(session);
      const resolution = spyOn(session, 'resolveRef').mockImplementation(async selector => {
        const result = await resolve(selector);
        if (!detach) await page.locator('#target').evaluate(el => el.remove());
        return result;
      });
      const locate = ref ? null : spyOn(page, 'locator').mockImplementation(() => locator);
      const count = locator.count.bind(locator);
      let counts = 0;
      const counting = spyOn(locator, 'count').mockImplementation(async () => {
        const result = await count();
        counts++;
        if (detach && counts === (ref ? 2 : 1)) await locator.evaluate(el => el.remove());
        return result;
      });
      try {
        const started = performance.now();
        let error: Error | undefined;
        try {
          await handleWriteCommand('click', [ref ? '@e1' : '#target'], session, manager);
        } catch (err) {
          error = err as Error;
        }
        const elapsed = performance.now() - started;
        expect(error?.message).toContain('Timeout 5000ms exceeded');
        expect(elapsed).toBeGreaterThanOrEqual(actionBudget - 100);
        expect(elapsed).toBeLessThan(actionBudget + diagnosticBudget + schedulingTolerance);
        if (detach) expect(await page.locator('#target').count()).toBe(0);
      } finally {
        counting.mockRestore();
        locate?.mockRestore();
        resolution.mockRestore();
        await page.close();
      }
    }, 40_000);
  }
}

test('successful selectors, refs and option auto-routing retain their behavior', async () => {
  const page = await browser.newPage();
  const session = new TabSession(page);
  const manager = new BrowserManager();
  try {
    await page.setContent('<button id="target" onclick="this.textContent += \'!\'">Click</button><select><option value="a">Alpha</option><option value="b">Beta</option></select>');
    session.setRefMap(new Map([
      ['e1', { locator: page.locator('#target'), role: 'button', name: 'Click' }],
      ['e2', { locator: page.locator('option[value="b"]'), role: 'option', name: 'Beta' }],
    ]));
    expect(await handleWriteCommand('click', ['#target'], session, manager)).toContain('Clicked');
    expect(await handleWriteCommand('click', ['@e1'], session, manager)).toContain('Clicked');
    expect(await page.locator('#target').innerText()).toBe('Click!!');
    expect(await handleWriteCommand('click', ['@e2'], session, manager)).toContain('auto-routed');
    expect(await page.locator('select').inputValue()).toBe('b');
  } finally {
    await page.close();
  }
});

test('option-selector guidance and genuine selector errors are preserved', async () => {
  const page = await browser.newPage();
  const session = new TabSession(page);
  const manager = new BrowserManager();
  try {
    await page.setContent('<select><option value="a">Alpha</option></select>');
    for (const [selector, message] of [['option', "Use 'browse select"], ['[invalid', 'parsing css selector']]) {
      let error: Error | undefined;
      try {
        await handleWriteCommand('click', [selector], session, manager);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).toContain(message);
    }
  } finally {
    await page.close();
  }
}, 10_000);
