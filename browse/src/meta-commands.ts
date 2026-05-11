/**
 * Meta commands — tabs, server control, screenshots, chain, diff, snapshot
 */

import type { BrowserManager } from './browser-manager';
import { handleSnapshot } from './snapshot';
import { getCleanText } from './read-commands';
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS, PAGE_CONTENT_COMMANDS, wrapUntrustedContent, canonicalizeCommand } from './commands';
import { handleDomainSkillCommand } from './domain-skill-commands';
import { handleSkillCommand } from './browser-skill-commands';
import { validateNavigationUrl } from './url-validation';
import { checkScope, type TokenInfo } from './token-registry';
import { validateOutputPath, validateReadPath, SAFE_DIRECTORIES, escapeRegExp } from './path-security';
// Re-export for backward compatibility (tests import from meta-commands)
export { validateOutputPath, escapeRegExp } from './path-security';
import * as Diff from 'diff';
import * as fs from 'fs';
import * as path from 'path';
import { writeSecureFile, mkdirSecure } from './file-permissions';
import { TEMP_DIR } from './platform';
import { resolveConfig } from './config';
import type { Frame } from 'playwright';

/** Tokenize a pipe segment respecting double-quoted strings. */
function tokenizePipeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ' ' && !inQuote) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

// ─── PDF flag parsing (make-pdf contract) ─────────────────────────────
//
// The $B pdf command grew from a 2-line wrapper (format: 'A4') into a real
// PDF engine frontend. make-pdf/dist/pdf shells out to `browse pdf` with
// this flag set, so the contract here has to be stable.
//
// Mutex rules enforced:
//   --format vs --width/--height
//   --margins vs any --margin-*
//   --page-numbers vs --footer-template (page-numbers writes the footer itself)
//
// Units for dimensions: "1in" | "72pt" | "25mm" | "2.54cm". Bare numbers
// are interpreted as pixels (Playwright's default), which is almost never
// what callers want — we warn but don't reject.
//
// Large payloads: header/footer HTML and custom CSS can exceed Windows'
// 8191-char CreateProcess cap via argv. Callers pass `--from-file <path>`
// to a JSON file holding the full options. make-pdf always uses this path.
interface ParsedPdfArgs {
  output: string;
  format?: string;
  width?: string;
  height?: string;
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
  headerTemplate?: string;
  footerTemplate?: string;
  pageNumbers?: boolean;
  tagged?: boolean;
  outline?: boolean;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
  toc?: boolean;
}

function parsePdfArgs(args: string[]): ParsedPdfArgs {
  // --from-file short-circuits argv parsing entirely
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from-file') {
      const payloadPath = args[++i];
      if (!payloadPath) throw new Error('pdf: --from-file requires a path');
      return parsePdfFromFile(payloadPath);
    }
  }

  const result: ParsedPdfArgs = {
    output: `${TEMP_DIR}/browse-page.pdf`,
  };

  let margins: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--format') { result.format = requireValue(args, ++i, 'format'); }
    else if (a === '--page-size') { result.format = requireValue(args, ++i, 'page-size'); }
    else if (a === '--width') { result.width = requireValue(args, ++i, 'width'); }
    else if (a === '--height') { result.height = requireValue(args, ++i, 'height'); }
    else if (a === '--margins') { margins = requireValue(args, ++i, 'margins'); }
    else if (a === '--margin-top') { result.marginTop = requireValue(args, ++i, 'margin-top'); }
    else if (a === '--margin-right') { result.marginRight = requireValue(args, ++i, 'margin-right'); }
    else if (a === '--margin-bottom') { result.marginBottom = requireValue(args, ++i, 'margin-bottom'); }
    else if (a === '--margin-left') { result.marginLeft = requireValue(args, ++i, 'margin-left'); }
    else if (a === '--header-template') { result.headerTemplate = requireValue(args, ++i, 'header-template'); }
    else if (a === '--footer-template') { result.footerTemplate = requireValue(args, ++i, 'footer-template'); }
    else if (a === '--page-numbers') { result.pageNumbers = true; }
    else if (a === '--tagged') { result.tagged = true; }
    else if (a === '--outline') { result.outline = true; }
    else if (a === '--print-background') { result.printBackground = true; }
    else if (a === '--prefer-css-page-size') { result.preferCSSPageSize = true; }
    else if (a === '--toc') { result.toc = true; }
    else if (a.startsWith('--')) { throw new Error(`Unknown pdf flag: ${a}`); }
    else { positional.push(a); }
  }

  if (positional.length > 0) result.output = positional[0];

  if (margins !== undefined) {
    if (result.marginTop || result.marginRight || result.marginBottom || result.marginLeft) {
      throw new Error('pdf: --margins is mutex with --margin-top/--margin-right/--margin-bottom/--margin-left');
    }
    result.marginTop = result.marginRight = result.marginBottom = result.marginLeft = margins;
  }

  if (result.format && (result.width || result.height)) {
    throw new Error('pdf: --format is mutex with --width/--height');
  }
  if (result.pageNumbers && result.footerTemplate) {
    throw new Error('pdf: --page-numbers is mutex with --footer-template (page-numbers writes the footer itself)');
  }

  return result;
}

function parsePdfFromFile(payloadPath: string): ParsedPdfArgs {
  // Parity with load-html --from-file (browse/src/write-commands.ts) and
  // the direct load-html <file> path: every caller-supplied file path
  // must pass validateReadPath so the safe-dirs policy can't be skirted
  // by routing reads through the --from-file shortcut.
  try {
    validateReadPath(path.resolve(payloadPath));
  } catch {
    throw new Error(
      `pdf: --from-file ${payloadPath} must be under ${SAFE_DIRECTORIES.join(' or ')} (security policy). Copy the payload into the project tree or /tmp first.`
    );
  }
  const raw = fs.readFileSync(payloadPath, 'utf8');
  const json = JSON.parse(raw);
  const out: ParsedPdfArgs = {
    output: json.output || `${TEMP_DIR}/browse-page.pdf`,
    format: json.format,
    width: json.width,
    height: json.height,
    marginTop: json.marginTop,
    marginRight: json.marginRight,
    marginBottom: json.marginBottom,
    marginLeft: json.marginLeft,
    headerTemplate: json.headerTemplate,
    footerTemplate: json.footerTemplate,
    pageNumbers: json.pageNumbers === true,
    tagged: json.tagged === true,
    outline: json.outline === true,
    printBackground: json.printBackground === true,
    preferCSSPageSize: json.preferCSSPageSize === true,
    toc: json.toc === true,
  };
  return out;
}

function requireValue(args: string[], i: number, flag: string): string {
  const v = args[i];
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`pdf: --${flag} requires a value`);
  }
  return v;
}

function buildPdfOptions(parsed: ParsedPdfArgs): Record<string, unknown> {
  const opts: Record<string, unknown> = {};

  // Page size
  if (parsed.format) {
    opts.format = parsed.format.charAt(0).toUpperCase() + parsed.format.slice(1).toLowerCase();
  } else if (parsed.width && parsed.height) {
    opts.width = parsed.width;
    opts.height = parsed.height;
  } else {
    opts.format = 'Letter';
  }

  // Margins
  const margin: Record<string, string> = {};
  if (parsed.marginTop) margin.top = parsed.marginTop;
  if (parsed.marginRight) margin.right = parsed.marginRight;
  if (parsed.marginBottom) margin.bottom = parsed.marginBottom;
  if (parsed.marginLeft) margin.left = parsed.marginLeft;
  if (Object.keys(margin).length > 0) opts.margin = margin;

  // Header/footer
  const displayHeaderFooter =
    !!parsed.headerTemplate || !!parsed.footerTemplate || parsed.pageNumbers === true;
  if (displayHeaderFooter) {
    opts.displayHeaderFooter = true;
    // Provide minimum empty templates when only one is set, otherwise Chromium
    // emits its default ugly URL/date in the other slot.
    if (parsed.headerTemplate !== undefined) opts.headerTemplate = parsed.headerTemplate;
    else if (parsed.pageNumbers || parsed.footerTemplate) opts.headerTemplate = '<div></div>';

    if (parsed.pageNumbers) {
      opts.footerTemplate = [
        '<div style="font-size:9pt; font-family:Helvetica,Arial,sans-serif; color:#666; ',
        'width:100%; text-align:center;">',
        '<span class="pageNumber"></span> of <span class="totalPages"></span>',
        '</div>',
      ].join('');
    } else if (parsed.footerTemplate !== undefined) {
      opts.footerTemplate = parsed.footerTemplate;
    } else {
      opts.footerTemplate = '<div></div>';
    }
  }

  if (parsed.tagged === true) opts.tagged = true;
  if (parsed.outline === true) opts.outline = true;
  if (parsed.printBackground === true) opts.printBackground = true;
  if (parsed.preferCSSPageSize === true) opts.preferCSSPageSize = true;

  return opts;
}

/** Options passed from handleCommandInternal for chain routing */
export interface MetaCommandOpts {
  chainDepth?: number;
  /** Callback to route subcommands through the full security pipeline (handleCommandInternal) */
  executeCommand?: (body: { command: string; args?: string[]; tabId?: number }, tokenInfo?: TokenInfo | null) => Promise<{ status: number; result: string; json?: boolean }>;
  /** The port the daemon is listening on (needed by `$B skill run` to point spawned scripts at the daemon). */
  daemonPort?: number;
}

export async function handleMetaCommand(
  command: string,
  args: string[],
  bm: BrowserManager,
  shutdown: () => Promise<void> | void,
  tokenInfo?: TokenInfo | null,
  opts?: MetaCommandOpts,
): Promise<string> {
  // Per-tab operations use the active session; global operations use bm directly
  const session = bm.getActiveSession();

  switch (command) {
    // ─── Tabs ──────────────────────────────────────────
    case 'tabs': {
      const tabs = await bm.getTabListWithTitles();
      return tabs.map(t =>
        `${t.active ? '→ ' : '  '}[${t.id}] ${t.title || '(untitled)'} — ${t.url}`
      ).join('\n');
    }

    case 'tab': {
      const id = parseInt(args[0], 10);
      if (isNaN(id)) throw new Error('Usage: browse tab <id>');
      bm.switchTab(id);
      return `Switched to tab ${id}`;
    }

    case 'newtab': {
      // --json returns structured output (machine-parseable). Other flag-like
      // tokens are treated as the url. make-pdf always passes --json.
      let url: string | undefined;
      let jsonMode = false;
      for (const a of args) {
        if (a === '--json') { jsonMode = true; }
        else if (!url) { url = a; }
      }
      const id = await bm.newTab(url);
      if (jsonMode) {
        return JSON.stringify({ tabId: id, url: url ?? null });
      }
      return `Opened tab ${id}${url ? ` → ${url}` : ''}`;
    }

    case 'closetab': {
      const id = args[0] ? parseInt(args[0], 10) : undefined;
      await bm.closeTab(id);
      return `Closed tab${id ? ` ${id}` : ''}`;
    }

    case 'tab-each': {
      // Fan out a single command across every open tab. Returns a JSON
      // object: { results: [{tabId, url, title, status, output}], total }.
      // Restores the originally active tab when done so the user's view
      // doesn't shift under them.
      //
      // Usage: $B tab-each <command> [args...]
      //   $B tab-each snapshot -i      → snapshot every tab
      //   $B tab-each text             → grab clean text from every tab
      //   $B tab-each goto https://x.y → load the same URL in every tab
      if (args.length === 0) {
        throw new Error(
          'Usage: browse tab-each <command> [args...]\n' +
          'Example: browse tab-each snapshot -i'
        );
      }

      const innerRaw = args[0];
      const innerName = canonicalizeCommand(innerRaw);
      const innerArgs = args.slice(1);

      // Scope check the inner command before fanning out, so a single
      // permission failure aborts the whole batch instead of partially
      // mutating tabs.
      if (tokenInfo && tokenInfo.clientId !== 'root' && !checkScope(tokenInfo, innerName)) {
        throw new Error(
          `tab-each rejected: subcommand "${innerRaw}" not allowed by your token scope (${tokenInfo.scopes.join(', ')}).`
        );
      }

      const tabs = await bm.getTabListWithTitles();
      const originalActive = tabs.find(t => t.active)?.id ?? bm.getActiveTabId();

      const executeCmd = opts?.executeCommand;
      const results: Array<{
        tabId: number;
        url: string;
        title: string;
        status: number;
        output: string;
      }> = [];

      try {
        for (const tab of tabs) {
          // Skip chrome:// internal pages — they aren't useful targets and
          // many commands fail outright on them.
          if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
            results.push({
              tabId: tab.id,
              url: tab.url,
              title: tab.title || '',
              status: 0,
              output: 'skipped: internal page',
            });
            continue;
          }
          // Switch to the tab. Don't pull focus away — we're a background
          // operation; the user shouldn't see the OS window jump.
          bm.switchTab(tab.id, { bringToFront: false });

          let status = 0;
          let output = '';
          if (executeCmd) {
            const r = await executeCmd(
              { command: innerName, args: innerArgs, tabId: tab.id },
              tokenInfo,
            );
            status = r.status;
            output = r.result;
            if (status !== 200) {
              try { output = JSON.parse(output).error || output; } catch (err: any) { if (!(err instanceof SyntaxError)) throw err; }
            }
          } else {
            // Fallback path (CLI / test harness without a server context).
            // We don't recurse through read/write/meta directly here because
            // tab-each is only meaningful with the live server; surface a
            // clear error.
            status = 500;
            output = 'tab-each requires the browse server (no executeCommand context)';
          }

          results.push({
            tabId: tab.id,
            url: tab.url,
            title: tab.title || '',
            status,
            output,
          });
        }
      } finally {
        // Restore the original active tab so the user's view is unchanged.
        try { bm.switchTab(originalActive, { bringToFront: false }); } catch {}
      }

      return JSON.stringify({
        command: innerName,
        args: innerArgs,
        total: results.length,
        results,
      }, null, 2);
    }

    // ─── Server Control ────────────────────────────────
    case 'status': {
      const page = bm.getPage();
      const tabs = bm.getTabCount();
      const mode = bm.getConnectionMode();
      return [
        `Status: healthy`,
        `Mode: ${mode}`,
        `URL: ${page.url()}`,
        `Tabs: ${tabs}`,
        `PID: ${process.pid}`,
      ].join('\n');
    }

    case 'url': {
      return bm.getCurrentUrl();
    }

    case 'stop': {
      await shutdown();
      return 'Server stopped';
    }

    case 'restart': {
      // Signal that we want a restart — the CLI will detect exit and restart
      console.log('[browse] Restart requested. Exiting for CLI to restart.');
      await shutdown();
      return 'Restarting...';
    }

    // ─── Visual ────────────────────────────────────────
    case 'screenshot': {
      // Parse priority: flags (--viewport, --clip, --base64) → selector (@ref, CSS) → output path
      const page = bm.getPage();
      let outputPath = `${TEMP_DIR}/browse-screenshot.png`;
      let clipRect: { x: number; y: number; width: number; height: number } | undefined;
      let targetSelector: string | undefined;
      let viewportOnly = false;
      let base64Mode = false;

      const remaining: string[] = [];
      let flagSelector: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--viewport') {
          viewportOnly = true;
        } else if (args[i] === '--base64') {
          base64Mode = true;
        } else if (args[i] === '--selector') {
          flagSelector = args[++i];
          if (!flagSelector) throw new Error('Usage: screenshot --selector <css> [path]');
        } else if (args[i] === '--clip') {
          const coords = args[++i];
          if (!coords) throw new Error('Usage: screenshot --clip x,y,w,h [path]');
          const parts = coords.split(',').map(Number);
          if (parts.length !== 4 || parts.some(isNaN))
            throw new Error('Usage: screenshot --clip x,y,width,height — all must be numbers');
          clipRect = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        } else if (args[i].startsWith('--')) {
          throw new Error(`Unknown screenshot flag: ${args[i]}`);
        } else {
          remaining.push(args[i]);
        }
      }

      // Separate target (selector/@ref) from output path
      for (const arg of remaining) {
        // File paths containing / and ending with an image/pdf extension are never CSS selectors
        const isFilePath = arg.includes('/') && /\.(png|jpe?g|webp|pdf)$/i.test(arg);
        if (isFilePath) {
          outputPath = arg;
        } else if (arg.startsWith('@e') || arg.startsWith('@c') || arg.startsWith('.') || arg.startsWith('#') || arg.includes('[')) {
          targetSelector = arg;
        } else {
          outputPath = arg;
        }
      }

      // --selector flag takes precedence; conflict with positional selector.
      if (flagSelector !== undefined) {
        if (targetSelector !== undefined) {
          throw new Error('--selector conflicts with positional selector — choose one');
        }
        targetSelector = flagSelector;
      }

      validateOutputPath(outputPath);

      if (clipRect && targetSelector) {
        throw new Error('Cannot use --clip with a selector/ref — choose one');
      }
      if (viewportOnly && clipRect) {
        throw new Error('Cannot use --viewport with --clip — choose one');
      }

      // --base64 mode: capture to buffer instead of disk
      if (base64Mode) {
        let buffer: Buffer;
        if (targetSelector) {
          const resolved = await bm.resolveRef(targetSelector);
          const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
          buffer = await locator.screenshot({ timeout: 5000 });
        } else if (clipRect) {
          buffer = await page.screenshot({ clip: clipRect });
        } else {
          buffer = await page.screenshot({ fullPage: !viewportOnly });
        }
        if (buffer.length > 10 * 1024 * 1024) {
          throw new Error('Screenshot too large for --base64 (>10MB). Use disk path instead.');
        }
        return `data:image/png;base64,${buffer.toString('base64')}`;
      }

      if (targetSelector) {
        const resolved = await bm.resolveRef(targetSelector);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        await locator.screenshot({ path: outputPath, timeout: 5000 });
        return `Screenshot saved (element): ${outputPath}`;
      }

      if (clipRect) {
        await page.screenshot({ path: outputPath, clip: clipRect });
        return `Screenshot saved (clip ${clipRect.x},${clipRect.y},${clipRect.width},${clipRect.height}): ${outputPath}`;
      }

      await page.screenshot({ path: outputPath, fullPage: !viewportOnly });
      return `Screenshot saved${viewportOnly ? ' (viewport)' : ''}: ${outputPath}`;
    }

    case 'pdf': {
      const page = bm.getPage();
      const parsed = parsePdfArgs(args);
      validateOutputPath(parsed.output);

      // If --toc: wait up to 3s for Paged.js to signal by setting
      // window.__pagedjsAfterFired = true. If the polyfill isn't injected
      // (make-pdf v1 ships without Paged.js; TOC renders without page
      // numbers), we fall through silently — callers that require strict
      // TOC pagination should pass --require-paged-js too.
      if (parsed.toc) {
        const deadline = Date.now() + 3000;
        let ready = false;
        while (Date.now() < deadline) {
          try {
            ready = await page.evaluate('!!window.__pagedjsAfterFired');
          } catch { /* tab may still be hydrating */ }
          if (ready) break;
          await new Promise(r => setTimeout(r, 150));
        }
        // Intentionally non-fatal. Paged.js is optional in v1.
      }

      const opts = buildPdfOptions(parsed);
      opts.path = parsed.output;
      await page.pdf(opts);

      return `PDF saved: ${parsed.output}`;
    }

    case 'responsive': {
      const page = bm.getPage();
      const prefix = args[0] || `${TEMP_DIR}/browse-responsive`;
      validateOutputPath(prefix);
      const viewports = [
        { name: 'mobile', width: 375, height: 812 },
        { name: 'tablet', width: 768, height: 1024 },
        { name: 'desktop', width: 1280, height: 720 },
      ];
      const originalViewport = page.viewportSize();
      const results: string[] = [];

      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const screenshotPath = `${prefix}-${vp.name}.png`;
        validateOutputPath(screenshotPath);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        results.push(`${vp.name} (${vp.width}x${vp.height}): ${screenshotPath}`);
      }

      // Restore original viewport
      if (originalViewport) {
        await page.setViewportSize(originalViewport);
      }

      return results.join('\n');
    }

    // ─── Chain ─────────────────────────────────────────
    case 'chain': {
      // Read JSON array from args[0] (if provided) or expect it was passed as body
      const jsonStr = args[0];
      if (!jsonStr) throw new Error(
        'Usage: echo \'[["goto","url"],["text"]]\' | browse chain\n' +
        '   or: browse chain \'goto url | click @e5 | snapshot -ic\''
      );

      let rawCommands: string[][];
      try {
        rawCommands = JSON.parse(jsonStr);
        if (!Array.isArray(rawCommands)) throw new Error('not array');
      } catch (err: any) {
        // Fallback: pipe-delimited format "goto url | click @e5 | snapshot -ic"
        if (!(err instanceof SyntaxError) && err?.message !== 'not array') throw err;
        rawCommands = jsonStr.split(' | ')
          .filter(seg => seg.trim().length > 0)
          .map(seg => tokenizePipeSegment(seg.trim()));
      }

      // Canonicalize aliases across the whole chain. Pair canonical name with the raw
      // input so result labels + error messages reflect what the user typed, but every
      // dispatch path (scope check, WRITE_COMMANDS.has, watch blocking, handler lookup)
      // uses the canonical name. Otherwise `chain '[["setcontent","/tmp/x.html"]]'`
      // bypasses prevalidation or runs under the wrong command set.
      const commands = rawCommands.map(cmd => {
        const [rawName, ...cmdArgs] = cmd;
        const name = canonicalizeCommand(rawName);
        return { rawName, name, args: cmdArgs };
      });

      // Pre-validate ALL subcommands against the token's scope before executing any.
      // Uses canonical name so aliases don't bypass scope checks.
      if (tokenInfo && tokenInfo.clientId !== 'root') {
        for (const c of commands) {
          if (!checkScope(tokenInfo, c.name)) {
            throw new Error(
              `Chain rejected: subcommand "${c.rawName}" not allowed by your token scope (${tokenInfo.scopes.join(', ')}). ` +
              `All subcommands must be within scope.`
            );
          }
        }
      }

      // Route each subcommand through handleCommandInternal for full security:
      // scope, domain, tab ownership, content wrapping — all enforced per subcommand.
      // Chain-specific options: skip rate check (chain = 1 request), skip activity
      // events (chain emits 1 event), increment chain depth (recursion guard).
      const executeCmd = opts?.executeCommand;
      const results: string[] = [];
      let lastWasWrite = false;

      if (executeCmd) {
        // Full security pipeline via handleCommandInternal.
        // Pass rawName so the server's own canonicalization is a no-op (already canonical).
        for (const c of commands) {
          const cr = await executeCmd(
            { command: c.name, args: c.args },
            tokenInfo,
          );
          const label = c.rawName === c.name ? c.name : `${c.rawName}→${c.name}`;
          if (cr.status === 200) {
            results.push(`[${label}] ${cr.result}`);
          } else {
            // Parse error from JSON result
            let errMsg = cr.result;
            try { errMsg = JSON.parse(cr.result).error || cr.result; } catch (err: any) { if (!(err instanceof SyntaxError)) throw err; }
            results.push(`[${label}] ERROR: ${errMsg}`);
          }
          lastWasWrite = WRITE_COMMANDS.has(c.name);
        }
      } else {
        // Fallback: direct dispatch (CLI mode, no server context)
        const { handleReadCommand } = await import('./read-commands');
        const { handleWriteCommand } = await import('./write-commands');

        for (const c of commands) {
          const name = c.name;
          const cmdArgs = c.args;
          const label = c.rawName === name ? name : `${c.rawName}→${name}`;
          try {
            let result: string;
            if (WRITE_COMMANDS.has(name)) {
              if (bm.isWatching()) {
                result = 'BLOCKED: write commands disabled in watch mode';
              } else {
                result = await handleWriteCommand(name, cmdArgs, session, bm);
              }
              lastWasWrite = true;
            } else if (READ_COMMANDS.has(name)) {
              result = await handleReadCommand(name, cmdArgs, session);
              if (PAGE_CONTENT_COMMANDS.has(name)) {
                result = wrapUntrustedContent(result, bm.getCurrentUrl());
              }
              lastWasWrite = false;
            } else if (META_COMMANDS.has(name)) {
              result = await handleMetaCommand(name, cmdArgs, bm, shutdown, tokenInfo, opts);
              lastWasWrite = false;
            } else {
              throw new Error(`Unknown command: ${c.rawName}`);
            }
            results.push(`[${label}] ${result}`);
          } catch (err: any) {
            results.push(`[${label}] ERROR: ${err.message}`);
          }
        }
      }

      // Wait for network to settle after write commands before returning
      if (lastWasWrite) {
        await bm.getPage().waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      }

      return results.join('\n\n');
    }

    // ─── Diff ──────────────────────────────────────────
    case 'diff': {
      const [url1, url2] = args;
      if (!url1 || !url2) throw new Error('Usage: browse diff <url1> <url2>');

      const page = bm.getPage();
      const normalizedUrl1 = await validateNavigationUrl(url1);
      await page.goto(normalizedUrl1, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const text1 = await getCleanText(page);

      const normalizedUrl2 = await validateNavigationUrl(url2);
      await page.goto(normalizedUrl2, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const text2 = await getCleanText(page);

      const changes = Diff.diffLines(text1, text2);
      const output: string[] = [`--- ${url1}`, `+++ ${url2}`, ''];

      for (const part of changes) {
        const prefix = part.added ? '+' : part.removed ? '-' : ' ';
        const lines = part.value.split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          output.push(`${prefix} ${line}`);
        }
      }

      return wrapUntrustedContent(output.join('\n'), `diff: ${url1} vs ${url2}`);
    }

    // ─── Snapshot ─────────────────────────────────────
    case 'snapshot': {
      const isScoped = tokenInfo && tokenInfo.clientId !== 'root';
      const snapshotResult = await handleSnapshot(args, session, {
        splitForScoped: !!isScoped,
      });
      // Scoped tokens get split format (refs outside envelope); root gets basic wrapping
      if (isScoped) {
        return snapshotResult; // already has envelope from split format
      }
      return wrapUntrustedContent(snapshotResult, bm.getCurrentUrl());
    }

    // ─── Handoff ────────────────────────────────────
    case 'handoff': {
      const message = args.join(' ') || 'User takeover requested';
      return await bm.handoff(message);
    }

    case 'resume': {
      bm.resume();
      // Re-snapshot to capture current page state after human interaction
      const isScoped2 = tokenInfo && tokenInfo.clientId !== 'root';
      const snapshot = await handleSnapshot(['-i'], session, { splitForScoped: !!isScoped2 });
      if (isScoped2) {
        return `RESUMED\n${snapshot}`;
      }
      return `RESUMED\n${wrapUntrustedContent(snapshot, bm.getCurrentUrl())}`;
    }

    // ─── Headed Mode ──────────────────────────────────────
    case 'connect': {
      // connect is handled as a pre-server command in cli.ts
      // If we get here, server is already running — tell the user
      if (bm.getConnectionMode() === 'headed') {
        return 'Already in headed mode with extension.';
      }
      return 'The connect command must be run from the CLI (not sent to a running server). Run: $B connect';
    }

    case 'disconnect': {
      if (bm.getConnectionMode() !== 'headed') {
        return 'Not in headed mode — nothing to disconnect.';
      }
      // Signal that we want a restart in headless mode
      console.log('[browse] Disconnecting headed browser. Restarting in headless mode.');
      await shutdown();
      return 'Disconnected. Server will restart in headless mode on next command.';
    }

    case 'focus': {
      if (bm.getConnectionMode() !== 'headed') {
        return 'focus requires headed mode. Run `$B connect` first.';
      }
      try {
        const { execSync } = await import('child_process');
        // Try common Chromium-based browser app names to bring to foreground
        const appNames = ['Comet', 'Google Chrome', 'Arc', 'Brave Browser', 'Microsoft Edge'];
        let activated = false;
        for (const appName of appNames) {
          try {
            execSync(`osascript -e 'tell application "${appName}" to activate'`, { stdio: 'pipe', timeout: 3000 });
            activated = true;
            break;
          } catch (err: any) {
            // Try next browser — osascript fails if app not found or AppleScript errors
            if (err?.status === undefined && !err?.message?.includes('Command failed')) throw err;
          }
        }

        if (!activated) {
          return 'Could not bring browser to foreground. macOS only.';
        }

        // If a ref was passed, scroll it into view
        if (args.length > 0 && args[0].startsWith('@')) {
          try {
            const resolved = await bm.resolveRef(args[0]);
            if ('locator' in resolved) {
              await resolved.locator.scrollIntoViewIfNeeded({ timeout: 5000 });
              return `Browser activated. Scrolled ${args[0]} into view.`;
            }
          } catch (err: any) {
            // Ref not found or element gone — still activated the browser
            if (!err?.message?.includes('not found') && !err?.message?.includes('closed') && !err?.message?.includes('Target') && !err?.message?.includes('timeout')) throw err;
          }
        }

        return 'Browser window activated.';
      } catch (err: any) {
        return `focus failed: ${err.message}. macOS only.`;
      }
    }

    // ─── Watch ──────────────────────────────────────────
    case 'watch': {
      if (args[0] === 'stop') {
        if (!bm.isWatching()) return 'Not currently watching.';
        const result = bm.stopWatch();
        const durationSec = Math.round(result.duration / 1000);
        const lastSnapshot = result.snapshots.length > 0
          ? wrapUntrustedContent(result.snapshots[result.snapshots.length - 1], bm.getCurrentUrl())
          : '(none)';
        return [
          `WATCH STOPPED (${durationSec}s, ${result.snapshots.length} snapshots)`,
          '',
          'Last snapshot:',
          lastSnapshot,
        ].join('\n');
      }

      if (bm.isWatching()) return 'Already watching. Run `$B watch stop` to stop.';
      if (bm.getConnectionMode() !== 'headed') {
        return 'watch requires headed mode. Run `$B connect` first.';
      }

      bm.startWatch();
      return 'WATCHING — observing user browsing. Periodic snapshots every 5s.\nRun `$B watch stop` to stop and get summary.';
    }

    // ─── Inbox ──────────────────────────────────────────
    case 'inbox': {
      const { execSync } = await import('child_process');
      let gitRoot: string;
      try {
        gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch (err: any) {
        // execSync throws with exit status on non-git directories
        if (err?.status === undefined && !err?.message?.includes('Command failed')) throw err;
        return 'Not in a git repository — cannot locate inbox.';
      }

      const inboxDir = path.join(gitRoot, '.context', 'sidebar-inbox');
      if (!fs.existsSync(inboxDir)) return 'Inbox empty.';

      const files = fs.readdirSync(inboxDir)
        .filter(f => f.endsWith('.json') && !f.startsWith('.'))
        .sort()
        .reverse(); // newest first

      if (files.length === 0) return 'Inbox empty.';

      const messages: { timestamp: string; url: string; userMessage: string }[] = [];
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(inboxDir, file), 'utf-8'));
          messages.push({
            timestamp: data.timestamp || '',
            url: data.page?.url || 'unknown',
            userMessage: data.userMessage || '',
          });
        } catch (err: any) {
          // Skip malformed JSON or unreadable files
          if (!(err instanceof SyntaxError) && err?.code !== 'ENOENT' && err?.code !== 'EACCES') throw err;
        }
      }

      if (messages.length === 0) return 'Inbox empty.';

      const lines: string[] = [];
      lines.push(`SIDEBAR INBOX (${messages.length} message${messages.length === 1 ? '' : 's'})`);
      lines.push('────────────────────────────────');

      for (const msg of messages) {
        const ts = msg.timestamp ? `[${msg.timestamp}]` : '[unknown]';
        lines.push(`${ts} ${wrapUntrustedContent(msg.url, 'inbox-url')}`);
        lines.push(`  "${wrapUntrustedContent(msg.userMessage, 'inbox-message')}"`);
        lines.push('');
      }

      lines.push('────────────────────────────────');

      // Handle --clear flag
      if (args.includes('--clear')) {
        for (const file of files) {
          try { fs.unlinkSync(path.join(inboxDir, file)); } catch (err: any) { if (err?.code !== 'ENOENT') throw err; }
        }
        lines.push(`Cleared ${files.length} message${files.length === 1 ? '' : 's'}.`);
      }

      return lines.join('\n');
    }

    // ─── State ────────────────────────────────────────
    case 'state': {
      const [action, name] = args;
      if (!action || !name) throw new Error('Usage: state save|load <name>');

      // Sanitize name: alphanumeric + hyphens + underscores only
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error('State name must be alphanumeric (a-z, 0-9, _, -)');
      }

      const config = resolveConfig();
      const stateDir = path.join(config.stateDir, 'browse-states');
      mkdirSecure(stateDir);
      const statePath = path.join(stateDir, `${name}.json`);

      if (action === 'save') {
        const state = await bm.saveState();
        // V1: cookies + URLs only (not localStorage — breaks on load-before-navigate)
        const saveData = {
          version: 1,
          savedAt: new Date().toISOString(),
          cookies: state.cookies,
          pages: state.pages.map(p => ({ url: p.url, isActive: p.isActive })),
        };
        writeSecureFile(statePath, JSON.stringify(saveData, null, 2));
        return `State saved: ${statePath} (${state.cookies.length} cookies, ${state.pages.length} pages)\n⚠️  Cookies stored in plaintext. Delete when no longer needed.`;
      }

      if (action === 'load') {
        if (!fs.existsSync(statePath)) throw new Error(`State not found: ${statePath}`);
        const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        if (!Array.isArray(data.cookies) || !Array.isArray(data.pages)) {
          throw new Error('Invalid state file: expected cookies and pages arrays');
        }
        // Validate and filter cookies — reject malformed or internal-network cookies
        const validatedCookies = data.cookies.filter((c: any) => {
          if (typeof c !== 'object' || !c) return false;
          if (typeof c.name !== 'string' || typeof c.value !== 'string') return false;
          if (typeof c.domain !== 'string' || !c.domain) return false;
          const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
          if (d === 'localhost' || d.endsWith('.internal') || d === '169.254.169.254') return false;
          return true;
        });
        if (validatedCookies.length < data.cookies.length) {
          console.warn(`[browse] Filtered ${data.cookies.length - validatedCookies.length} invalid cookies from state file`);
        }
        // Warn on state files older than 7 days
        if (data.savedAt) {
          const ageMs = Date.now() - new Date(data.savedAt).getTime();
          const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
          if (ageMs > SEVEN_DAYS) {
            console.warn(`[browse] Warning: State file is ${Math.round(ageMs / 86400000)} days old. Consider re-saving.`);
          }
        }
        // Close existing pages, then restore (replace, not merge)
        bm.setFrame(null);
        await bm.closeAllPages();
        // Allowlist disk-loaded page fields — NEVER accept loadedHtml, loadedHtmlWaitUntil,
        // or owner from disk. Those are in-memory-only invariants; allowing them would let
        // a tampered state file smuggle HTML past load-html's safe-dirs + magic-byte + size
        // checks, or forge tab ownership for cross-agent authorization bypass.
        await bm.restoreState({
          cookies: validatedCookies,
          pages: data.pages.map((p: any) => ({
            url: typeof p.url === 'string' ? p.url : '',
            isActive: Boolean(p.isActive),
            storage: null,
          })),
        });
        return `State loaded: ${data.cookies.length} cookies, ${data.pages.length} pages`;
      }

      throw new Error('Usage: state save|load <name>');
    }

    // ─── Frame ───────────────────────────────────────
    case 'frame': {
      const target = args[0];
      if (!target) throw new Error('Usage: frame <selector|@ref|--name name|--url pattern|main>');

      if (target === 'main') {
        bm.setFrame(null);
        bm.clearRefs();
        return 'Switched to main frame';
      }

      const page = bm.getPage();
      let frame: Frame | null = null;

      if (target === '--name') {
        if (!args[1]) throw new Error('Usage: frame --name <name>');
        frame = page.frame({ name: args[1] });
      } else if (target === '--url') {
        if (!args[1]) throw new Error('Usage: frame --url <pattern>');
        frame = page.frame({ url: new RegExp(escapeRegExp(args[1])) });
      } else {
        // CSS selector or @ref for the iframe element
        const resolved = await bm.resolveRef(target);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        const elementHandle = await locator.elementHandle({ timeout: 5000 });
        frame = await elementHandle?.contentFrame() ?? null;
        await elementHandle?.dispose();
      }

      if (!frame) throw new Error(`Frame not found: ${target}`);
      bm.setFrame(frame);
      bm.clearRefs();
      return `Switched to frame: ${frame.url()}`;
    }

    // ─── UX Audit ─────────────────────────────────────
    case 'ux-audit': {
      const page = bm.getPage();

      // Extract page structure for UX behavioral analysis
      // Agent interprets the data and applies Krug's 6 usability tests
      // Uses textContent (not innerText) to avoid layout computation on large DOMs
      const data = await page.evaluate(() => {
        const HEADING_CAP = 50;
        const INTERACTIVE_CAP = 200;
        const TEXT_BLOCK_CAP = 50;

        // Site ID: logo or brand element
        const logoEl = document.querySelector('[class*="logo"], [id*="logo"], header img, [aria-label*="home"], a[href="/"]');
        const siteId = logoEl ? {
          found: true,
          text: (logoEl.textContent || '').trim().slice(0, 100),
          tag: logoEl.tagName,
          alt: (logoEl as HTMLImageElement).alt || null,
        } : { found: false, text: null, tag: null, alt: null };

        // Page name: main heading
        const h1 = document.querySelector('h1');
        const pageName = h1 ? {
          found: true,
          text: h1.textContent?.trim().slice(0, 200) || '',
        } : { found: false, text: null };

        // Navigation: primary nav elements
        const navEls = document.querySelectorAll('nav, [role="navigation"]');
        const navItems: Array<{ text: string; links: number }> = [];
        navEls.forEach((nav, i) => {
          if (i >= 5) return;
          const links = nav.querySelectorAll('a');
          navItems.push({
            text: (nav.getAttribute('aria-label') || `nav-${i}`).slice(0, 50),
            links: links.length,
          });
        });

        // "You are here" indicator: current/active nav items
        // Scoped to nav containers to avoid false positives from animation classes
        const activeNavItems = document.querySelectorAll('nav [aria-current], nav .active, nav .current, [role="navigation"] [aria-current], [role="navigation"] .active, [role="navigation"] .current');
        const youAreHere = Array.from(activeNavItems).slice(0, 5).map(el => ({
          text: (el.textContent || '').trim().slice(0, 50),
          tag: el.tagName,
        }));

        // Search: search box presence
        const searchEl = document.querySelector('input[type="search"], [role="search"], input[name*="search"], input[placeholder*="search" i], input[aria-label*="search" i]');
        const search = { found: !!searchEl };

        // Breadcrumbs
        const breadcrumbEl = document.querySelector('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, [class*="breadcrumb"]');
        const breadcrumbs = breadcrumbEl ? {
          found: true,
          items: Array.from(breadcrumbEl.querySelectorAll('a, span, li')).slice(0, 10).map(el => (el.textContent || '').trim().slice(0, 30)),
        } : { found: false, items: [] };

        // Headings: heading hierarchy
        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, HEADING_CAP).map(h => ({
          tag: h.tagName,
          text: (h.textContent || '').trim().slice(0, 80),
          size: getComputedStyle(h).fontSize,
        }));

        // Interactive elements: buttons, links, inputs
        const interactiveEls = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]')).slice(0, INTERACTIVE_CAP);
        const interactive = interactiveEls.map(el => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            text: (el.textContent || (el as HTMLInputElement).placeholder || '').trim().slice(0, 50),
            type: (el as HTMLInputElement).type || null,
            role: el.getAttribute('role'),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            visible: rect.width > 0 && rect.height > 0,
          };
        }).filter(el => el.visible);

        // Text blocks: paragraphs and large text areas
        const textBlocks = Array.from(document.querySelectorAll('p, [class*="description"], [class*="intro"], [class*="welcome"], [class*="hero"] p, main p')).slice(0, TEXT_BLOCK_CAP).map(el => ({
          text: (el.textContent || '').trim().slice(0, 200),
          wordCount: (el.textContent || '').trim().split(/\s+/).filter(Boolean).length,
        }));

        // Total visible text word count (textContent avoids layout computation)
        const bodyText = (document.body?.textContent || '').trim();
        const totalWords = bodyText.split(/\s+/).filter(Boolean).length;

        return {
          url: window.location.href,
          title: document.title,
          siteId,
          pageName,
          navigation: navItems,
          youAreHere,
          search,
          breadcrumbs,
          headings,
          interactive,
          textBlocks,
          totalWords,
        };
      });

      return JSON.stringify(data, null, 2);
    }

    case 'domain-skill': {
      return await handleDomainSkillCommand(args, bm);
    }

    case 'skill': {
      const port = opts?.daemonPort;
      if (port === undefined) {
        throw new Error('skill command requires daemonPort in MetaCommandOpts (server bug)');
      }
      return await handleSkillCommand(args, { port });
    }

    case 'cdp': {
      // Lazy import — cdp-bridge introduces module deps we don't want loaded
      // for projects that never use the CDP escape hatch.
      const { handleCdpCommand } = await import('./cdp-commands');
      return await handleCdpCommand(args, bm);
    }

    default:
      throw new Error(`Unknown meta command: ${command}`);
  }
}
