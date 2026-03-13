/**
 * Read commands — extract data from pages without side effects
 *
 * text, html, links, forms, accessibility, js, eval, css, attrs,
 * console, network, cookies, storage, perf
 */

import type { BrowserManager } from './browser-manager';
import { consoleBuffer, networkBuffer, dialogBuffer } from './buffers';
import type { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// Security: Path validation to prevent path traversal attacks
const SAFE_DIRECTORIES = ['/tmp', process.cwd()];

function validateReadPath(filePath: string): void {
  if (path.isAbsolute(filePath)) {
    const resolved = path.resolve(filePath);
    const isSafe = SAFE_DIRECTORIES.some(dir => resolved === dir || resolved.startsWith(dir + '/'));
    if (!isSafe) {
      throw new Error(`Absolute path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
    }
  }
  const normalized = path.normalize(filePath);
  if (normalized.includes('..')) {
    throw new Error('Path traversal sequences (..) are not allowed');
  }
}

/**
 * Extract clean text from a page (strips script/style/noscript/svg).
 * Exported for DRY reuse in meta-commands (diff).
 */
export async function getCleanText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    const clone = body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
    return clone.innerText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
  });
}

export async function handleReadCommand(
  command: string,
  args: string[],
  bm: BrowserManager
): Promise<string> {
  const page = bm.getPage();

  switch (command) {
    case 'text': {
      return await getCleanText(page);
    }

    case 'html': {
      const selector = args[0];
      if (selector) {
        const resolved = bm.resolveRef(selector);
        if ('handle' in resolved) {
          try {
            return await resolved.handle.innerHTML();
          } catch (err) {
            bm.rethrowIfStaleRef(selector, err);
          }
        }
        return await page.innerHTML(resolved.selector);
      }
      return await page.content();
    }

    case 'links': {
      const links = await page.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map(a => ({
          text: a.textContent?.trim().slice(0, 120) || '',
          href: (a as HTMLAnchorElement).href,
        })).filter(l => l.text && l.href)
      );
      return links.map(l => `${l.text} → ${l.href}`).join('\n');
    }

    case 'forms': {
      const forms = await page.evaluate(() => {
        return [...document.querySelectorAll('form')].map((form, i) => {
          const fields = [...form.querySelectorAll('input, select, textarea')].map(el => {
            const input = el as HTMLInputElement;
            return {
              tag: el.tagName.toLowerCase(),
              type: input.type || undefined,
              name: input.name || undefined,
              id: input.id || undefined,
              placeholder: input.placeholder || undefined,
              required: input.required || undefined,
              value: input.type === 'password' ? '[redacted]' : (input.value || undefined),
              options: el.tagName === 'SELECT'
                ? [...(el as HTMLSelectElement).options].map(o => ({ value: o.value, text: o.text }))
                : undefined,
            };
          });
          return {
            index: i,
            action: form.action || undefined,
            method: form.method || 'get',
            id: form.id || undefined,
            fields,
          };
        });
      });
      return JSON.stringify(forms, null, 2);
    }

    case 'accessibility': {
      const snapshot = await page.locator("body").ariaSnapshot();
      return snapshot;
    }

    case 'js': {
      const expr = args[0];
      if (!expr) throw new Error('Usage: browse js <expression>');
      const result = await page.evaluate(expr);
      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
    }

    case 'eval': {
      const filePath = args[0];
      if (!filePath) throw new Error('Usage: browse eval <js-file>');
      validateReadPath(filePath);
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const code = fs.readFileSync(filePath, 'utf-8');
      const result = await page.evaluate(code);
      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
    }

    case 'css': {
      const [selector, property] = args;
      if (!selector || !property) throw new Error('Usage: browse css <selector> <property>');
      const resolved = bm.resolveRef(selector);
      if ('handle' in resolved) {
        try {
          const value = await resolved.handle.evaluate(
            (el, prop) => getComputedStyle(el as Element).getPropertyValue(prop),
            property
          );
          return value;
        } catch (err) {
          bm.rethrowIfStaleRef(selector, err);
        }
      }
      const value = await page.evaluate(
        ([sel, prop]) => {
          const el = document.querySelector(sel);
          if (!el) return `Element not found: ${sel}`;
          return getComputedStyle(el).getPropertyValue(prop);
        },
        [resolved.selector, property]
      );
      return value;
    }

    case 'attrs': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse attrs <selector>');
      const resolved = bm.resolveRef(selector);
      if ('handle' in resolved) {
        try {
          const attrs = await resolved.handle.evaluate((el) => {
            const result: Record<string, string> = {};
            for (const attr of (el as Element).attributes) {
              result[attr.name] = attr.value;
            }
            return result;
          });
          return JSON.stringify(attrs, null, 2);
        } catch (err) {
          bm.rethrowIfStaleRef(selector, err);
        }
      }
      const attrs = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return `Element not found: ${sel}`;
        const result: Record<string, string> = {};
        for (const attr of el.attributes) {
          result[attr.name] = attr.value;
        }
        return result;
      }, resolved.selector);
      return typeof attrs === 'string' ? attrs : JSON.stringify(attrs, null, 2);
    }

    case 'console': {
      if (args[0] === '--clear') {
        consoleBuffer.clear();
        return 'Console buffer cleared.';
      }
      const entries = args[0] === '--errors'
        ? consoleBuffer.toArray().filter(e => e.level === 'error' || e.level === 'warning')
        : consoleBuffer.toArray();
      if (entries.length === 0) return args[0] === '--errors' ? '(no console errors)' : '(no console messages)';
      return entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
      ).join('\n');
    }

    case 'network': {
      if (args[0] === '--clear') {
        networkBuffer.clear();
        return 'Network buffer cleared.';
      }
      if (networkBuffer.length === 0) return '(no network requests)';
      return networkBuffer.toArray().map(e =>
        `${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n');
    }

    case 'dialog': {
      if (args[0] === '--clear') {
        dialogBuffer.clear();
        return 'Dialog buffer cleared.';
      }
      if (dialogBuffer.length === 0) return '(no dialogs captured)';
      return dialogBuffer.toArray().map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`
      ).join('\n');
    }

    case 'is': {
      const property = args[0];
      const selector = args[1];
      if (!property || !selector) throw new Error('Usage: browse is <property> <selector>\nProperties: visible, hidden, enabled, disabled, checked, editable, focused');

      const resolved = bm.resolveRef(selector);
      if ('handle' in resolved) {
        try {
          const state = await resolved.handle.evaluate((el, prop) => {
            const node = el as HTMLElement & {
              disabled?: boolean;
              checked?: boolean;
              readOnly?: boolean;
              isContentEditable?: boolean;
            };
            const style = window.getComputedStyle(node);
            const visible =
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              (node.getClientRects().length > 0 || style.position === 'fixed');

            switch (prop) {
              case 'visible':
                return visible;
              case 'hidden':
                return !visible;
              case 'enabled':
                return !node.disabled;
              case 'disabled':
                return Boolean(node.disabled);
              case 'checked':
                return Boolean(node.checked);
              case 'editable':
                return !node.disabled && !node.readOnly && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));
              case 'focused':
                return node === document.activeElement;
              default:
                throw new Error(`Unknown property: ${prop}. Use: visible, hidden, enabled, disabled, checked, editable, focused`);
            }
          }, property);
          return String(state);
        } catch (err) {
          bm.rethrowIfStaleRef(selector, err);
        }
      }

      const locator = page.locator(resolved.selector);

      switch (property) {
        case 'visible':  return String(await locator.isVisible());
        case 'hidden':   return String(await locator.isHidden());
        case 'enabled':  return String(await locator.isEnabled());
        case 'disabled': return String(await locator.isDisabled());
        case 'checked':  return String(await locator.isChecked());
        case 'editable': return String(await locator.isEditable());
        case 'focused': {
          const isFocused = await locator.evaluate(
            (el) => el === document.activeElement
          );
          return String(isFocused);
        }
        default:
          throw new Error(`Unknown property: ${property}. Use: visible, hidden, enabled, disabled, checked, editable, focused`);
      }
    }

    case 'cookies': {
      const cookies = await page.context().cookies();
      return JSON.stringify(cookies, null, 2);
    }

    case 'storage': {
      if (args[0] === 'set' && args[1]) {
        const key = args[1];
        const value = args[2] || '';
        await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
        return `Set localStorage["${key}"]`;
      }
      const storage = await page.evaluate(() => ({
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
      }));
      return JSON.stringify(storage, null, 2);
    }

    case 'perf': {
      const timings = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        if (!nav) return 'No navigation timing data available.';
        return {
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          tcp: Math.round(nav.connectEnd - nav.connectStart),
          ssl: Math.round(nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          download: Math.round(nav.responseEnd - nav.responseStart),
          domParse: Math.round(nav.domInteractive - nav.responseEnd),
          domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load: Math.round(nav.loadEventEnd - nav.startTime),
          total: Math.round(nav.loadEventEnd - nav.startTime),
        };
      });
      if (typeof timings === 'string') return timings;
      return Object.entries(timings)
        .map(([k, v]) => `${k.padEnd(12)} ${v}ms`)
        .join('\n');
    }

    default:
      throw new Error(`Unknown read command: ${command}`);
  }
}
