/**
 * Write commands — navigate and interact with pages (side effects)
 *
 * goto, back, forward, reload, click, fill, select, hover, type,
 * press, scroll, wait, viewport, cookie, header, useragent
 */

import type { BrowserManager } from './browser-manager';

export async function handleWriteCommand(
  command: string,
  args: string[],
  bm: BrowserManager
): Promise<string> {
  const page = bm.getPage();

  switch (command) {
    case 'goto': {
      const url = args[0];
      if (!url) throw new Error('Usage: browse goto <url>');
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = response?.status() || 'unknown';
      return `Navigated to ${url} (${status})`;
    }

    case 'back': {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return `Back → ${page.url()}`;
    }

    case 'forward': {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return `Forward → ${page.url()}`;
    }

    case 'reload': {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return `Reloaded ${page.url()}`;
    }

    case 'click': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse click <selector>');
      const resolved = bm.resolveRef(selector);
      if ('handle' in resolved) {
        try {
          await resolved.handle.click({ timeout: 5000 });
        } catch (err) {
          bm.rethrowIfStaleRef(selector, err);
        }
      } else {
        await page.click(resolved.selector, { timeout: 5000 });
      }
      // Wait briefly for any navigation/DOM update
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return `Clicked ${selector} → now at ${page.url()}`;
    }

    case 'fill': {
      const [selector, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector || args.length < 2) throw new Error('Usage: browse fill <selector> <value>');
      const resolved = bm.resolveRef(selector);
      if ('handle' in resolved) {
        try {
          await resolved.handle.fill(value, { timeout: 5000 });
        } catch (err) {
          bm.rethrowIfStaleRef(selector, err);
        }
      } else {
        await page.fill(resolved.selector, value, { timeout: 5000 });
      }
      return `Filled ${selector}`;
    }

    case 'select': {
      const [selector, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector || args.length < 2) throw new Error('Usage: browse select <selector> <value>');
      const resolved = bm.resolveRef(selector);
      if ('handle' in resolved) {
        try {
          await resolved.handle.selectOption(value, { timeout: 5000 });
        } catch (err) {
          bm.rethrowIfStaleRef(selector, err);
        }
      } else {
        await page.selectOption(resolved.selector, value, { timeout: 5000 });
      }
      return `Selected "${value}" in ${selector}`;
    }

    case 'hover': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse hover <selector>');
      const resolved = bm.resolveRef(selector);
      if ('handle' in resolved) {
        try {
          await resolved.handle.hover({ timeout: 5000 });
        } catch (err) {
          bm.rethrowIfStaleRef(selector, err);
        }
      } else {
        await page.hover(resolved.selector, { timeout: 5000 });
      }
      return `Hovered ${selector}`;
    }

    case 'type': {
      const text = args.join(' ');
      if (!text) throw new Error('Usage: browse type <text>');
      await page.keyboard.type(text);
      return `Typed "${text}"`;
    }

    case 'press': {
      const key = args[0];
      if (!key) throw new Error('Usage: browse press <key> (e.g., Enter, Tab, Escape)');
      await page.keyboard.press(key);
      return `Pressed ${key}`;
    }

    case 'scroll': {
      const selector = args[0];
      if (selector) {
        const resolved = bm.resolveRef(selector);
        if ('handle' in resolved) {
          try {
            await resolved.handle.scrollIntoViewIfNeeded({ timeout: 5000 });
          } catch (err) {
            bm.rethrowIfStaleRef(selector, err);
          }
        } else {
          await page.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: 5000 });
        }
        return `Scrolled ${selector} into view`;
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      return 'Scrolled to bottom';
    }

    case 'wait': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse wait <selector>');
      const timeout = args[1] ? parseInt(args[1], 10) : 15000;
      const resolved = bm.resolveRef(selector);
      if ('handle' in resolved) {
        try {
          await resolved.handle.waitForElementState('visible', { timeout });
        } catch (err) {
          bm.rethrowIfStaleRef(selector, err);
        }
      } else {
        await page.waitForSelector(resolved.selector, { timeout });
      }
      return `Element ${selector} appeared`;
    }

    case 'viewport': {
      const size = args[0];
      if (!size || !size.includes('x')) throw new Error('Usage: browse viewport <WxH> (e.g., 375x812)');
      const [w, h] = size.split('x').map(Number);
      await bm.setViewport(w, h);
      return `Viewport set to ${w}x${h}`;
    }

    case 'cookie': {
      const cookieStr = args[0];
      if (!cookieStr || !cookieStr.includes('=')) throw new Error('Usage: browse cookie <name>=<value> [origin]');
      const eq = cookieStr.indexOf('=');
      const name = cookieStr.slice(0, eq);
      const value = cookieStr.slice(eq + 1);
      let cookieUrl: string;
      if (args[1]) {
        try {
          cookieUrl = new URL(args[1]).origin;
        } catch {
          throw new Error('Usage: browse cookie <name>=<value> [origin]');
        }
      } else {
        const currentUrl = page.url();
        if (currentUrl === 'about:blank') {
          throw new Error('Usage: browse cookie <name>=<value> [origin]');
        }
        cookieUrl = new URL(currentUrl).origin;
      }
      await page.context().addCookies([{
        name,
        value,
        url: cookieUrl,
      }]);
      return `Cookie set: ${name}=${value}`;
    }

    case 'header': {
      const headerStr = args[0];
      if (!headerStr || !headerStr.includes(':')) throw new Error('Usage: browse header <name>:<value>');
      const sep = headerStr.indexOf(':');
      const name = headerStr.slice(0, sep).trim();
      const value = headerStr.slice(sep + 1).trim();
      await bm.setExtraHeader(name, value);
      return `Header set: ${name}: ${value}`;
    }

    case 'useragent': {
      const ua = args.join(' ');
      if (!ua) throw new Error('Usage: browse useragent <string>');
      bm.setUserAgent(ua);
      return `User agent set (applies on next restart): ${ua}`;
    }

    default:
      throw new Error(`Unknown write command: ${command}`);
  }
}
