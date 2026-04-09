/**
 * Read commands — extract data from pages without side effects
 *
 * text, html, links, forms, accessibility, js, eval, css, attrs,
 * console, network, cookies, storage, perf
 */

import type { TabSession } from './tab-session';
import type { BrowserManager } from './browser-manager';
import { consoleBuffer, networkBuffer, dialogBuffer } from './buffers';
import type { Page, Frame } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { TEMP_DIR } from './platform';
import { inspectElement, formatInspectorResult, getModificationHistory } from './cdp-inspector';
import { validateReadPath } from './path-security';
// Re-export for backward compatibility (tests import from read-commands)
export { validateReadPath } from './path-security';

// Redaction patterns for sensitive cookie/storage values — exported for test coverage
export const SENSITIVE_COOKIE_NAME = /(^|[_.-])(token|secret|key|password|credential|auth|jwt|session|csrf|sid)($|[_.-])|api.?key/i;
export const SENSITIVE_COOKIE_VALUE = /^(eyJ|sk-|sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|sk-ant-|ghp_|gho_|github_pat_|xox[bpsa]-|AKIA[A-Z0-9]{16}|AIza|SG\.|Bearer\s|sbp_)/;

/** Detect await keyword, ignoring comments. Accepted risk: await in string literals triggers wrapping (harmless). */
function hasAwait(code: string): boolean {
  const stripped = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return /\bawait\b/.test(stripped);
}

/** Detect whether code needs a block wrapper {…} vs expression wrapper (…) inside an async IIFE. */
function needsBlockWrapper(code: string): boolean {
  const trimmed = code.trim();
  if (trimmed.split('\n').length > 1) return true;
  if (/\b(const|let|var|function|class|return|throw|if|for|while|switch|try)\b/.test(trimmed)) return true;
  if (trimmed.includes(';')) return true;
  return false;
}

/** Wrap code for page.evaluate(), using async IIFE with block or expression body as needed. */
function wrapForEvaluate(code: string): string {
  if (!hasAwait(code)) return code;
  const trimmed = code.trim();
  return needsBlockWrapper(trimmed)
    ? `(async()=>{\n${code}\n})()`
    : `(async()=>(${trimmed}))()`;
}

/**
 * Extract clean text from a page (strips script/style/noscript/svg).
 * Exported for DRY reuse in meta-commands (diff).
 */
export async function getCleanText(page: Page | Frame): Promise<string> {
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
  session: TabSession,
  browserManager: BrowserManager,
): Promise<string> {
  const bm = browserManager;
  const page = session.getPage();
  // Frame-aware target for content extraction
  const target = session.getActiveFrameOrPage();

  switch (command) {
    case 'text': {
      return await getCleanText(target);
    }

    case 'html': {
      const selector = args[0];
      if (selector) {
        const resolved = await session.resolveRef(selector);
        if ('locator' in resolved) {
          return await resolved.locator.innerHTML({ timeout: 5000 });
        }
        return await target.locator(resolved.selector).innerHTML({ timeout: 5000 });
      }
      // page.content() is page-only; use evaluate for frame compat
      const doctype = await target.evaluate(() => {
        const dt = document.doctype;
        return dt ? `<!DOCTYPE ${dt.name}>` : '';
      });
      const html = await target.evaluate(() => document.documentElement.outerHTML);
      return doctype ? `${doctype}\n${html}` : html;
    }

    case 'links': {
      const links = await target.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map(a => ({
          text: a.textContent?.trim().slice(0, 120) || '',
          href: (a as HTMLAnchorElement).href,
        })).filter(l => l.text && l.href)
      );
      return links.map(l => `${l.text} → ${l.href}`).join('\n');
    }

    case 'forms': {
      const forms = await target.evaluate(() => {
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
      const snapshot = await target.locator("body").ariaSnapshot();
      return snapshot;
    }

    case 'js': {
      const expr = args[0];
      if (!expr) throw new Error('Usage: browse js <expression>');
      const wrapped = wrapForEvaluate(expr);
      const result = await target.evaluate(wrapped);
      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
    }

    case 'eval': {
      const filePath = args[0];
      if (!filePath) throw new Error('Usage: browse eval <js-file>');
      validateReadPath(filePath);
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const code = fs.readFileSync(filePath, 'utf-8');
      const wrapped = wrapForEvaluate(code);
      const result = await target.evaluate(wrapped);
      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
    }

    case 'css': {
      const [selector, property] = args;
      if (!selector || !property) throw new Error('Usage: browse css <selector> <property>');
      const resolved = await session.resolveRef(selector);
      if ('locator' in resolved) {
        const value = await resolved.locator.evaluate(
          (el, prop) => getComputedStyle(el).getPropertyValue(prop),
          property
        );
        return value;
      }
      const value = await target.evaluate(
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
      const resolved = await session.resolveRef(selector);
      if ('locator' in resolved) {
        const attrs = await resolved.locator.evaluate((el) => {
          const result: Record<string, string> = {};
          for (const attr of el.attributes) {
            result[attr.name] = attr.value;
          }
          return result;
        });
        return JSON.stringify(attrs, null, 2);
      }
      const attrs = await target.evaluate((sel: string) => {
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

      // Network capture extensions
      if (args[0] === '--capture') {
        const {
          startCapture, stopCapture, getCaptureListener, isCaptureActive,
        } = await import('./network-capture');

        if (args[1] === 'stop') {
          // Detach listener from current page
          const page = bm.getPage();
          const listener = getCaptureListener();
          if (listener) page.removeListener('response', listener);
          const result = stopCapture();
          return `Network capture stopped. ${result.count} responses captured (${result.sizeKB}KB).`;
        }

        // Start capture
        if (isCaptureActive()) return 'Capture already active. Use --capture stop first.';
        const filterIdx = args.indexOf('--filter');
        const filterPattern = filterIdx >= 0 ? args[filterIdx + 1] : undefined;
        const info = startCapture(filterPattern);
        // Attach listener to current page
        const page = bm.getPage();
        const listener = getCaptureListener();
        if (listener) page.on('response', listener);
        return `Network capture started${info.filter ? ` (filter: ${info.filter})` : ''}. Use --capture stop to stop.`;
      }

      if (args[0] === '--export') {
        const { exportCapture } = await import('./network-capture');
        const { validateOutputPath: vop } = await import('./path-security');
        const exportPath = args[1];
        if (!exportPath) throw new Error('Usage: network --export <path>');
        vop(exportPath);
        const count = exportCapture(exportPath);
        return `Exported ${count} captured responses to ${exportPath}`;
      }

      if (args[0] === '--bodies') {
        const { getCaptureBuffer } = await import('./network-capture');
        return getCaptureBuffer().summary();
      }

      // Default: show request metadata
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

      const resolved = await session.resolveRef(selector);
      let locator;
      if ('locator' in resolved) {
        locator = resolved.locator;
      } else {
        locator = target.locator(resolved.selector);
      }

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
      // Redact cookie values that look like secrets (consistent with storage redaction)
      const redacted = cookies.map(c => {
        if (SENSITIVE_COOKIE_NAME.test(c.name) || SENSITIVE_COOKIE_VALUE.test(c.value)) {
          return { ...c, value: `[REDACTED — ${c.value.length} chars]` };
        }
        return c;
      });
      return JSON.stringify(redacted, null, 2);
    }

    case 'storage': {
      if (args[0] === 'set' && args[1]) {
        const key = args[1];
        const value = args[2] || '';
        await target.evaluate(([k, v]: string[]) => localStorage.setItem(k, v), [key, value]);
        return `Set localStorage["${key}"]`;
      }
      const storage = await target.evaluate(() => ({
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
      }));
      // Redact values that look like secrets (tokens, keys, passwords, JWTs)
      const SENSITIVE_KEY = /(^|[_.-])(token|secret|key|password|credential|auth|jwt|session|csrf)($|[_.-])|api.?key/i;
      const SENSITIVE_VALUE = /^(eyJ|sk-|sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|sk-ant-|ghp_|gho_|github_pat_|xox[bpsa]-|AKIA[A-Z0-9]{16}|AIza|SG\.|Bearer\s|sbp_)/;
      const redacted = JSON.parse(JSON.stringify(storage));
      for (const storeType of ['localStorage', 'sessionStorage'] as const) {
        const store = redacted[storeType];
        if (!store) continue;
        for (const [key, value] of Object.entries(store)) {
          if (typeof value !== 'string') continue;
          if (SENSITIVE_KEY.test(key) || SENSITIVE_VALUE.test(value)) {
            store[key] = `[REDACTED — ${value.length} chars]`;
          }
        }
      }
      return JSON.stringify(redacted, null, 2);
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

    case 'inspect': {
      // Parse flags
      let includeUA = false;
      let showHistory = false;
      let selector: string | undefined;

      for (const arg of args) {
        if (arg === '--all') {
          includeUA = true;
        } else if (arg === '--history') {
          showHistory = true;
        } else if (!selector) {
          selector = arg;
        }
      }

      // --history mode: return modification history
      if (showHistory) {
        const history = getModificationHistory();
        if (history.length === 0) return '(no style modifications)';
        return history.map((m, i) =>
          `[${i}] ${m.selector} { ${m.property}: ${m.oldValue} → ${m.newValue} } (${m.source}, ${m.method})`
        ).join('\n');
      }

      // If no selector given, check for stored inspector data
      if (!selector) {
        // Access stored inspector data from the server's in-memory state
        // The server stores this when the extension picks an element via POST /inspector/pick
        const stored = (bm as any)._inspectorData;
        const storedTs = (bm as any)._inspectorTimestamp;
        if (stored) {
          const stale = storedTs && (Date.now() - storedTs > 60000);
          let output = formatInspectorResult(stored, { includeUA });
          if (stale) output = '⚠ Data may be stale (>60s old)\n\n' + output;
          return output;
        }
        throw new Error('Usage: browse inspect [selector] [--all] [--history]\nOr pick an element in the Chrome sidebar first.');
      }

      // Direct inspection by selector
      const result = await inspectElement(page, selector, { includeUA });
      // Store for later retrieval
      (bm as any)._inspectorData = result;
      (bm as any)._inspectorTimestamp = Date.now();
      return formatInspectorResult(result, { includeUA });
    }

    case 'media': {
      const { extractMedia } = await import('./media-extract');
      const target = bm.getActiveFrameOrPage();
      const filter = args.includes('--images') ? 'images' as const
        : args.includes('--videos') ? 'videos' as const
        : args.includes('--audio') ? 'audio' as const
        : undefined;
      const selectorArg = args.find(a => !a.startsWith('--'));
      const result = await extractMedia(target, { selector: selectorArg, filter });
      return JSON.stringify(result, null, 2);
    }

    case 'data': {
      const target = bm.getActiveFrameOrPage();
      const wantJsonLd = args.includes('--jsonld') || args.length === 0;
      const wantOg = args.includes('--og') || args.length === 0;
      const wantTwitter = args.includes('--twitter') || args.length === 0;
      const wantMeta = args.includes('--meta') || args.length === 0;

      const result = await target.evaluate(({ wantJsonLd, wantOg, wantTwitter, wantMeta }) => {
        const data: Record<string, any> = {};

        if (wantJsonLd) {
          const scripts = document.querySelectorAll('script[type="application/ld+json"]');
          const jsonLd: any[] = [];
          scripts.forEach(s => {
            try { jsonLd.push(JSON.parse(s.textContent || '')); } catch {}
          });
          data.jsonLd = jsonLd;
        }

        if (wantOg) {
          const og: Record<string, string> = {};
          document.querySelectorAll('meta[property^="og:"]').forEach(m => {
            const prop = m.getAttribute('property')?.replace('og:', '') || '';
            og[prop] = m.getAttribute('content') || '';
          });
          data.openGraph = og;
        }

        if (wantTwitter) {
          const tw: Record<string, string> = {};
          document.querySelectorAll('meta[name^="twitter:"]').forEach(m => {
            const name = m.getAttribute('name')?.replace('twitter:', '') || '';
            tw[name] = m.getAttribute('content') || '';
          });
          data.twitterCards = tw;
        }

        if (wantMeta) {
          const meta: Record<string, string> = {};
          const canonical = document.querySelector('link[rel="canonical"]');
          if (canonical) meta.canonical = canonical.getAttribute('href') || '';
          const desc = document.querySelector('meta[name="description"]');
          if (desc) meta.description = desc.getAttribute('content') || '';
          const keywords = document.querySelector('meta[name="keywords"]');
          if (keywords) meta.keywords = keywords.getAttribute('content') || '';
          const author = document.querySelector('meta[name="author"]');
          if (author) meta.author = author.getAttribute('content') || '';
          const title = document.querySelector('title');
          if (title) meta.title = title.textContent || '';
          data.meta = meta;
        }

        return data;
      }, { wantJsonLd, wantOg, wantTwitter, wantMeta });

      return JSON.stringify(result, null, 2);
    }

    case 'ocr': {
      const { generateText } = await import('ai');
      const { createInterfazeProvider, INTERFAZE_MODEL, getInterfazePrecontext } = await import('./interfaze-client');
      const { interfazeSetupHint } = await import('./interfaze-auth');

      const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tiff?)$/i;
      const DOC_EXT = /\.(pdf)$/i;
      const MEDIA_TYPES: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.tif': 'image/tiff', '.tiff': 'image/tiff',
      };

      const wantJson = args.includes('--json');
      const posArgs = args.filter(a => a !== '--json');
      const provider = createInterfazeProvider();
      if (!provider) throw new Error(interfazeSetupHint('ocr'));

      let contentPart: { type: 'image'; image: Buffer } | { type: 'file'; data: Buffer; mediaType: string; filename: string };
      const first = posArgs[0];
      if (!first) {
        contentPart = { type: 'image', image: await page.screenshot({ fullPage: false }) };
      } else if (fs.existsSync(path.resolve(first)) && (IMAGE_EXT.test(first) || DOC_EXT.test(first))) {
        validateReadPath(first);
        const buf = fs.readFileSync(path.resolve(first));
        const ext = path.extname(first).toLowerCase();
        if (DOC_EXT.test(first)) {
          contentPart = { type: 'file', data: buf, mediaType: MEDIA_TYPES[ext] || 'application/octet-stream', filename: path.basename(first) };
        } else {
          contentPart = { type: 'image', image: buf };
        }
      } else {
        const resolved = await session.resolveRef(first);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        contentPart = { type: 'image', image: await locator.screenshot({ timeout: 5000 }) as Buffer };
      }

      const prompt = contentPart.type === 'file'
        ? 'Extract all text from this document. Preserve structure, headings, and line breaks.'
        : 'Extract all visible text from this image. Preserve line breaks where helpful.';

      const model = provider(INTERFAZE_MODEL);
      const { text, providerMetadata } = await generateText({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              contentPart as any,
            ],
          },
        ],
      });

      if (wantJson) {
        const pre = getInterfazePrecontext(providerMetadata as Record<string, unknown> | undefined);
        return JSON.stringify({ text, precontext: pre }, null, 2);
      }
      return text || '(no text extracted)';
    }

    case 'search': {
      const { generateText } = await import('ai');
      const { createInterfazeProvider, INTERFAZE_MODEL, getInterfazePrecontext } = await import('./interfaze-client');
      const { interfazeSetupHint } = await import('./interfaze-auth');

      let limit = 5;
      const parts: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
          limit = Math.min(20, Math.max(1, parseInt(args[i + 1], 10) || 5));
          i++;
          continue;
        }
        parts.push(args[i]);
      }
      const query = parts.join(' ').trim();
      if (!query) throw new Error('Usage: browse search <query> [--limit N]');

      const provider = createInterfazeProvider();
      if (!provider) throw new Error(interfazeSetupHint('search'));

      const model = provider(INTERFAZE_MODEL);
      const { text, providerMetadata } = await generateText({
        model,
        prompt:
          `Answer using web search. Summarize the top ${limit} most relevant sources with title, URL, and a short snippet for each.\n\nQuery: ${query}`,
      });

      const pre = getInterfazePrecontext(providerMetadata as Record<string, unknown> | undefined);
      const lines: string[] = [text || ''];
      if (pre !== undefined) {
        lines.push('');
        lines.push('--- precontext (raw search metadata) ---');
        lines.push(typeof pre === 'string' ? pre : JSON.stringify(pre, null, 2));
      }
      return lines.join('\n');
    }

    case 'ai-scrape': {
      const { generateObject } = await import('ai');
      const { createInterfazeProvider, INTERFAZE_MODEL, getInterfazePrecontext } = await import('./interfaze-client');
      const { interfazeSetupHint } = await import('./interfaze-auth');
      const { parseSchemaJson } = await import('./interfaze-schema');

      const wantJson = args.includes('--json');
      const filtered = args.filter(a => a !== '--json');
      const schemaIdx = filtered.indexOf('--schema');
      if (schemaIdx < 0 || !filtered[schemaIdx + 1]) {
        throw new Error(
          'Usage: browse ai-scrape <url> --schema {"field":"string"} [--json]',
        );
      }
      const schemaStr = filtered[schemaIdx + 1];
      const rest = filtered.filter((_, i) => i !== schemaIdx && i !== schemaIdx + 1);
      const url = rest[0];
      if (!url || !/^https?:\/\//i.test(url)) {
        throw new Error('Usage: browse ai-scrape <url> --schema {"field":"string"} [--json]');
      }

      const provider = createInterfazeProvider();
      if (!provider) throw new Error(interfazeSetupHint('ai-scrape'));

      const schema = parseSchemaJson(schemaStr);
      const model = provider(INTERFAZE_MODEL);
      const prompt = `Extract structured data from this page URL: ${url}
Follow the schema fields exactly. If a field is missing, use a reasonable empty value (empty string, 0, or false as appropriate).`;

      const { object, providerMetadata } = await generateObject({
        model,
        schema,
        prompt,
      });

      if (wantJson) {
        const pre = getInterfazePrecontext(providerMetadata as Record<string, unknown> | undefined);
        return JSON.stringify({ object, precontext: pre }, null, 2);
      }
      return JSON.stringify(object, null, 2);
    }

    default:
      throw new Error(`Unknown read command: ${command}`);
  }
}
