const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Gstack-Browse for Gemini CLI
 * Ported and refined with collaboration from Claude & Codex.
 *
 * Usage: node browse.js <command1> [args...] [command2] [args...] ...
 * All commands run in the same browser context — state is preserved
 * across the command chain (cookies, DOM, navigation history).
 */

const userDataDir = path.join(os.homedir(), '.gstack', 'gemini-browser-data');
const snapshotStateFile = path.join(os.tmpdir(), 'gstack-snapshot-state.json');

// Collected during session — output on demand by console/network commands
const consoleMessages = [];
const networkErrors = [];
const networkRequests = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[Runner] ${msg}\n`);
}

function out(msg) {
  process.stdout.write(msg + '\n');
}

/** Parse optional flag args until we hit a known command or end of argv */
function parseFlags(argv, offset, knownFlags) {
  const flags = {};
  let consumed = 0;
  while (offset + consumed < argv.length) {
    const arg = argv[offset + consumed];
    if (!arg.startsWith('-')) break;
    if (arg === '-o' && knownFlags.includes('-o')) {
      flags['-o'] = argv[offset + consumed + 1];
      consumed += 2;
    } else if (knownFlags.includes(arg)) {
      flags[arg] = true;
      consumed += 1;
    } else {
      break; // unknown flag, stop
    }
  }
  return { flags, consumed };
}

/** Get all interactive elements as an accessibility list */
async function getInteractiveElements(page, includeClickable = false) {
  const elements = await page.evaluate((includeClickable) => {
    const interactiveTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary']);
    const interactiveRoles = new Set(['button', 'link', 'checkbox', 'radio', 'textbox', 'combobox',
      'listbox', 'option', 'tab', 'menuitem', 'switch', 'slider', 'spinbutton', 'searchbox']);
    const results = [];
    let index = 1;

    document.querySelectorAll('*').forEach(el => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const isInteractive = interactiveTags.has(tag) || interactiveRoles.has(role) ||
        el.getAttribute('tabindex') !== null ||
        (includeClickable && (
          window.getComputedStyle(el).cursor === 'pointer' ||
          el.hasAttribute('onclick')
        ));

      if (!isInteractive) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

      const label = el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        (el.textContent || '').trim().slice(0, 60) ||
        el.getAttribute('value') ||
        '';
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string' ?
        '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      const selector = id || cls || tag;
      const type = el.getAttribute('type') || '';

      results.push({
        ref: `@e${index++}`,
        tag,
        type,
        role,
        label,
        selector,
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }
      });
    });
    return results;
  }, includeClickable);
  return elements;
}

/** Save accessibility snapshot for diff comparison */
function saveSnapshot(text) {
  fs.writeFileSync(snapshotStateFile, JSON.stringify({ text, ts: Date.now() }), 'utf8');
}

/** Load previous snapshot */
function loadSnapshot() {
  try {
    const data = JSON.parse(fs.readFileSync(snapshotStateFile, 'utf8'));
    return data.text;
  } catch {
    return null;
  }
}

/** Simple line-level diff */
function diffText(prev, curr) {
  if (!prev) return `[No previous snapshot — showing current]\n${curr}`;
  const prevLines = prev.split('\n');
  const currLines = curr.split('\n');
  const prevSet = new Set(prevLines);
  const currSet = new Set(currLines);
  const added = currLines.filter(l => !prevSet.has(l)).map(l => `+ ${l}`);
  const removed = prevLines.filter(l => !currSet.has(l)).map(l => `- ${l}`);
  if (added.length === 0 && removed.length === 0) return '(no changes)';
  return [...removed, ...added].join('\n');
}

/** Overlay numbered labels on interactive elements for annotated screenshot */
async function screenshotAnnotated(page, elements, outputPath) {
  await page.evaluate((elems) => {
    window.__gstack_labels = [];
    elems.forEach((el, i) => {
      const allEls = document.querySelectorAll(el.selector);
      // find the best match by position
      let target = null;
      allEls.forEach(candidate => {
        const rect = candidate.getBoundingClientRect();
        if (Math.abs(rect.left - el.rect.x) < 10 && Math.abs(rect.top - el.rect.y) < 10) {
          target = candidate;
        }
      });
      if (!target && allEls.length > 0) target = allEls[0];
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const label = document.createElement('div');
      label.id = `__gstack_lbl_${i}`;
      label.style.cssText = [
        'position:fixed',
        `left:${Math.max(0, rect.left - 2)}px`,
        `top:${Math.max(0, rect.top - 2)}px`,
        'background:#5b5bd6',
        'color:#fff',
        'font:bold 10px/14px monospace',
        'padding:1px 4px',
        'border-radius:3px',
        'z-index:2147483647',
        'pointer-events:none',
        'white-space:nowrap'
      ].join(';');
      label.textContent = el.ref;
      document.body.appendChild(label);
      window.__gstack_labels.push(label.id);
    });
  }, elements);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await page.screenshot({ path: outputPath, fullPage: true });

  await page.evaluate(() => {
    (window.__gstack_labels || []).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    delete window.__gstack_labels;
  });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const COMMANDS = {

  /**
   * goto <url>
   * Navigate to a URL.
   */
  goto: {
    argc: 1,
    fn: async (page, [url]) => {
      log(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      log(`Success: ${page.url()}`);
    }
  },

  /**
   * screenshot <filepath>
   * Full-page screenshot.
   */
  screenshot: {
    argc: 1,
    fn: async (page, [filepath]) => {
      log(`Screenshot → ${filepath}`);
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
      await page.screenshot({ path: filepath, fullPage: true });
      log('Screenshot saved.');
    }
  },

  /**
   * click <selector>
   * Click an element. Selector can be CSS or @eN ref from snapshot.
   */
  click: {
    argc: 1,
    fn: async (page, [selector], ctx) => {
      log(`Clicking ${selector}...`);
      const resolved = ctx.refs[selector] || selector;
      await page.waitForSelector(resolved, { timeout: 10000 });
      await page.click(resolved);
      try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
      log('Clicked.');
    }
  },

  /**
   * fill <selector> <text>
   * Fill an input field.
   */
  fill: {
    argc: 2,
    fn: async (page, [selector, text], ctx) => {
      log(`Filling ${selector}...`);
      const resolved = ctx.refs[selector] || selector;
      await page.waitForSelector(resolved, { timeout: 10000 });
      await page.fill(resolved, text);
      log('Filled.');
    }
  },

  /**
   * hover <selector>
   * Mouse over an element (reveals tooltips, dropdowns, etc.).
   */
  hover: {
    argc: 1,
    fn: async (page, [selector], ctx) => {
      log(`Hovering ${selector}...`);
      const resolved = ctx.refs[selector] || selector;
      await page.waitForSelector(resolved, { timeout: 10000 });
      await page.hover(resolved);
      log('Hovered.');
    }
  },

  /**
   * press <key>
   * Simulate a keyboard key press. Examples: Enter, Tab, Escape, ArrowDown.
   */
  press: {
    argc: 1,
    fn: async (page, [key]) => {
      log(`Pressing ${key}...`);
      await page.keyboard.press(key);
      log('Pressed.');
    }
  },

  /**
   * select <selector> <value>
   * Choose an option in a <select> element by value or label.
   */
  select: {
    argc: 2,
    fn: async (page, [selector, value], ctx) => {
      log(`Selecting "${value}" in ${selector}...`);
      const resolved = ctx.refs[selector] || selector;
      await page.waitForSelector(resolved, { timeout: 10000 });
      await page.selectOption(resolved, { label: value }).catch(() =>
        page.selectOption(resolved, { value })
      );
      log('Selected.');
    }
  },

  /**
   * text
   * Output the page's visible text content.
   */
  text: {
    argc: 0,
    fn: async (page) => {
      const textContent = await page.evaluate(() => document.body.innerText);
      out(textContent.slice(0, 50000));
    }
  },

  /**
   * html
   * Output the page's full HTML.
   */
  html: {
    argc: 0,
    fn: async (page) => {
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      out(html.slice(0, 50000));
    }
  },

  /**
   * links
   * List all links on the page (href, text, status check for SPA nav).
   */
  links: {
    argc: 0,
    fn: async (page) => {
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]')).map(a => ({
          href: a.href,
          text: (a.textContent || '').trim().slice(0, 80)
        })).filter(l => l.href && !l.href.startsWith('javascript:'));
      });
      if (links.length === 0) {
        out('No links found.');
      } else {
        out(`${links.length} links:`);
        links.forEach(l => out(`  ${l.href}  ${l.text ? `"${l.text}"` : ''}`));
      }
    }
  },

  /**
   * snapshot [-i] [-C] [-D] [-a] [-o <path>]
   *
   * Without flags:     Full accessibility tree text snapshot.
   * -i                 Interactive elements only (inputs, buttons, links, selects).
   * -C                 Include non-ARIA clickable divs (cursor:pointer, onclick).
   * -D                 Diff mode: show changes since last snapshot call.
   * -a -o <path>       Annotated screenshot with @eN labels saved to <path>.
   */
  snapshot: {
    parseArgs: (argv, offset) => {
      return parseFlags(argv, offset, ['-i', '-C', '-D', '-a', '-o']);
    },
    fn: async (page, flags) => {
      const interactive = flags['-i'] || flags['-C'] || false;
      const clickable = flags['-C'] || false;
      const diff = flags['-D'] || false;
      const annotate = flags['-a'] || false;
      const outputPath = flags['-o'];

      if (annotate && outputPath) {
        log(`Annotated screenshot → ${outputPath}`);
        const elements = await getInteractiveElements(page, clickable);
        await screenshotAnnotated(page, elements, outputPath);
        out(`Annotated screenshot saved: ${outputPath} (${elements.length} elements labeled)`);
        return;
      }

      // Build text snapshot
      if (interactive) {
        const elements = await getInteractiveElements(page, clickable);
        // Store @eN → CSS selector map in context
        page.__gstack_refs = {};
        elements.forEach(el => { page.__gstack_refs[el.ref] = el.selector; });

        const lines = elements.map(el => {
          const parts = [el.ref.padEnd(5), el.tag.padEnd(10)];
          if (el.type) parts.push(el.type.padEnd(8));
          if (el.label) parts.push(`"${el.label.slice(0, 50)}"`);
          parts.push(el.selector);
          return parts.join('  ');
        });

        const snapshotText = lines.join('\n');
        if (diff) {
          const prev = loadSnapshot();
          out(diffText(prev, snapshotText));
        } else {
          out(`${elements.length} interactive element${elements.length !== 1 ? 's' : ''}:`);
          out(snapshotText);
        }
        saveSnapshot(snapshotText);
      } else {
        // Full accessibility tree
        const snapshotText = await page.evaluate(() => {
          function nodeText(el, depth) {
            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            if (['script', 'style', 'noscript', 'svg'].includes(tag)) return '';
            const text = (el.textContent || '').trim().slice(0, 120);
            const role = el.getAttribute ? el.getAttribute('role') : '';
            const label = el.getAttribute ? (el.getAttribute('aria-label') || el.getAttribute('alt') || '') : '';
            const indent = '  '.repeat(Math.min(depth, 6));
            let line = '';
            if (text || role || label) {
              line = `${indent}${tag}${role ? `[${role}]` : ''}${label ? ` "${label}"` : ''}${text ? `: ${text.slice(0, 80)}` : ''}`;
            }
            const children = Array.from(el.children || []).map(c => nodeText(c, depth + 1)).filter(Boolean);
            return [line, ...children].filter(Boolean).join('\n');
          }
          return nodeText(document.body, 0);
        });

        if (diff) {
          const prev = loadSnapshot();
          out(diffText(prev, snapshotText));
        } else {
          out(snapshotText);
        }
        saveSnapshot(snapshotText);
      }
    }
  },

  /**
   * is <state> <selector>
   * Assert element state. States: visible, hidden, enabled, disabled, checked, editable.
   * Exits non-zero if assertion fails.
   */
  is: {
    argc: 2,
    fn: async (page, [state, selector], ctx) => {
      const resolved = ctx.refs[selector] || selector;
      log(`Checking ${selector} is ${state}...`);

      let result = false;
      try {
        switch (state) {
          case 'visible':  result = await page.isVisible(resolved, { timeout: 5000 }); break;
          case 'hidden':   result = !(await page.isVisible(resolved, { timeout: 5000 })); break;
          case 'enabled':  result = await page.isEnabled(resolved, { timeout: 5000 }); break;
          case 'disabled': result = await page.isDisabled(resolved, { timeout: 5000 }); break;
          case 'checked':  result = await page.isChecked(resolved, { timeout: 5000 }); break;
          case 'editable': result = await page.isEditable(resolved, { timeout: 5000 }); break;
          default:
            process.stderr.write(`Unknown state: ${state}. Valid: visible, hidden, enabled, disabled, checked, editable\n`);
            process.exitCode = 1;
            return;
        }
      } catch (e) {
        result = false;
      }

      if (result) {
        out(`✓ ${selector} is ${state}`);
      } else {
        out(`✗ FAIL: ${selector} is NOT ${state}`);
        process.exitCode = 1;
      }
    }
  },

  /**
   * count <selector>
   * Output the number of elements matching the selector.
   */
  count: {
    argc: 1,
    fn: async (page, [selector]) => {
      const n = await page.locator(selector).count();
      out(`${n} element${n !== 1 ? 's' : ''} match "${selector}"`);
    }
  },

  /**
   * wait <selector|Nms>
   * Wait for a CSS selector to appear, or pause for N milliseconds.
   * Example: wait .modal-open    wait 2000
   */
  wait: {
    argc: 1,
    fn: async (page, [arg]) => {
      if (/^\d+$/.test(arg)) {
        const ms = parseInt(arg, 10);
        log(`Waiting ${ms}ms...`);
        await page.waitForTimeout(ms);
        log(`Done waiting.`);
      } else {
        log(`Waiting for "${arg}"...`);
        await page.waitForSelector(arg, { timeout: 15000 });
        log(`"${arg}" appeared.`);
      }
    }
  },

  /**
   * scroll <direction|selector>
   * Scroll the page or an element into view.
   * direction: top | bottom | up | down
   * selector: any CSS selector — scrolls that element into view
   */
  scroll: {
    argc: 1,
    fn: async (page, [arg], ctx) => {
      if (['top', 'bottom', 'up', 'down'].includes(arg)) {
        log(`Scrolling ${arg}...`);
        await page.evaluate((dir) => {
          if (dir === 'top') window.scrollTo(0, 0);
          else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
          else if (dir === 'up') window.scrollBy(0, -window.innerHeight * 0.8);
          else if (dir === 'down') window.scrollBy(0, window.innerHeight * 0.8);
        }, arg);
      } else {
        const resolved = ctx.refs[arg] || arg;
        log(`Scrolling ${resolved} into view...`);
        await page.waitForSelector(resolved, { timeout: 5000 });
        await page.locator(resolved).scrollIntoViewIfNeeded();
      }
      log('Scrolled.');
    }
  },

  /**
   * viewport <WxH>
   * Resize the browser viewport. Example: viewport 375x812  viewport 1280x720
   */
  viewport: {
    argc: 1,
    fn: async (page, [dimensions]) => {
      const match = dimensions.match(/^(\d+)[x×](\d+)$/i);
      if (!match) {
        process.stderr.write(`Invalid viewport format: "${dimensions}". Use WxH, e.g. 375x812\n`);
        process.exitCode = 1;
        return;
      }
      const width = parseInt(match[1], 10);
      const height = parseInt(match[2], 10);
      log(`Setting viewport to ${width}x${height}...`);
      await page.setViewportSize({ width, height });
      log('Viewport set.');
    }
  },

  /**
   * js <code>
   * Execute JavaScript in the page context. Result is printed to stdout.
   * Wrap code in quotes: js "document.title"
   */
  js: {
    argc: 1,
    fn: async (page, [code]) => {
      log(`Executing JS...`);
      const result = await page.evaluate(code);
      out(JSON.stringify(result, null, 2));
    }
  },

  /**
   * console [--errors]
   * Output collected browser console messages.
   * --errors  Only show error-level messages.
   */
  console: {
    parseArgs: (argv, offset) => {
      return parseFlags(argv, offset, ['--errors']);
    },
    fn: async (_page, flags) => {
      const onlyErrors = flags['--errors'] || false;
      const msgs = onlyErrors
        ? consoleMessages.filter(m => m.type === 'error' || m.type === 'warning')
        : consoleMessages;
      if (msgs.length === 0) {
        out(onlyErrors ? 'No console errors.' : 'No console messages.');
      } else {
        out(`${msgs.length} console message${msgs.length !== 1 ? 's' : ''}:`);
        msgs.forEach(m => out(`  [${m.type}] ${m.text}`));
      }
    }
  },

  /**
   * network [--errors]
   * Output network requests made during the session.
   * --errors  Only show failed requests (4xx, 5xx, aborted).
   */
  network: {
    parseArgs: (argv, offset) => {
      return parseFlags(argv, offset, ['--errors']);
    },
    fn: async (_page, flags) => {
      const onlyErrors = flags['--errors'] || false;
      if (onlyErrors) {
        if (networkErrors.length === 0) {
          out('No network errors.');
        } else {
          out(`${networkErrors.length} network error${networkErrors.length !== 1 ? 's' : ''}:`);
          networkErrors.forEach(e => out(`  [${e.status || 'FAIL'}] ${e.url}${e.failure ? ` — ${e.failure}` : ''}`));
        }
      } else {
        const all = networkRequests;
        out(`${all.length} request${all.length !== 1 ? 's' : ''}:`);
        all.slice(-30).forEach(r => out(`  ${r.method}  ${r.url}`));
        if (all.length > 30) out(`  ... and ${all.length - 30} more`);
      }
    }
  },

  /**
   * cookie-import <filepath>
   * Import cookies from a JSON file (Playwright cookie format) into the session.
   * Useful for sharing sessions exported from setup-browser-cookies.
   */
  'cookie-import': {
    argc: 1,
    fn: async (page, [filepath]) => {
      log(`Importing cookies from ${filepath}...`);
      const raw = fs.readFileSync(filepath, 'utf8');
      const cookies = JSON.parse(raw);
      await page.context().addCookies(cookies);
      log(`Imported ${cookies.length} cookies.`);
    }
  }

};

// ─── Argument Parser ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const queue = [];
  let i = 0;
  while (i < argv.length) {
    const cmdName = argv[i];
    const definition = COMMANDS[cmdName];
    if (!definition) {
      process.stderr.write(`Error: Unknown command "${cmdName}"\n`);
      process.stderr.write(`Available: ${Object.keys(COMMANDS).join(', ')}\n`);
      process.exit(1);
    }

    let cmdArgs;
    let consumed;

    if (definition.parseArgs) {
      const result = definition.parseArgs(argv, i + 1);
      cmdArgs = result.flags;
      consumed = result.consumed;
    } else {
      const argc = definition.argc;
      if (i + argc >= argv.length && argc > 0) {
        process.stderr.write(`Error: "${cmdName}" requires ${argc} argument(s).\n`);
        process.exit(1);
      }
      cmdArgs = argv.slice(i + 1, i + 1 + argc);
      consumed = argc;
    }

    queue.push({ name: cmdName, fn: definition.fn, args: cmdArgs });
    i += 1 + consumed;
  }
  return queue;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stderr.write([
      'Usage: node browse.js <command1> [args...] [command2] [args...] ...',
      '',
      'Commands:',
      '  goto <url>                    Navigate to URL',
      '  screenshot <path>             Full-page screenshot',
      '  click <selector>              Click element',
      '  fill <selector> <text>        Fill input field',
      '  hover <selector>              Mouse over element',
      '  press <key>                   Keyboard key press (Enter, Tab, Escape, ...)',
      '  select <selector> <value>     Choose option in <select>',
      '  text                          Output page visible text',
      '  html                          Output page HTML',
      '  links                         List all page links',
      '  snapshot [-i] [-C] [-D] [-a -o <path>]  Accessibility snapshot',
      '  is <state> <selector>         Assert: visible|hidden|enabled|disabled|checked|editable',
      '  count <selector>              Count matching elements',
      '  wait <selector|Nms>           Wait for element or N milliseconds',
      '  scroll <top|bottom|up|down|selector>  Scroll page or element',
      '  viewport <WxH>                Set viewport size (e.g. 375x812)',
      '  js <code>                     Execute JavaScript, print result',
      '  console [--errors]            Output browser console messages',
      '  network [--errors]            Output network requests',
      '  cookie-import <path>          Import cookies from JSON file',
      '',
      'Selector hint: use @eN refs from snapshot -i output (e.g. @e3)',
      'Chain example: node browse.js goto https://example.com snapshot -i -a -o /tmp/shot.png',
    ].join('\n') + '\n');
    process.exit(0);
  }

  const queue = parseArgs(argv);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  // Collect console messages and network events
  page.on('console', msg => {
    const entry = { type: msg.type(), text: msg.text() };
    consoleMessages.push(entry);
    process.stderr.write(`[Browser/${entry.type}] ${entry.text}\n`);
  });
  page.on('pageerror', err => {
    const entry = { type: 'error', text: err.message };
    consoleMessages.push(entry);
    process.stderr.write(`[Browser/pageerror] ${err.message}\n`);
  });
  page.on('requestfailed', req => {
    networkErrors.push({ url: req.url(), failure: req.failure()?.errorText, status: null });
  });
  page.on('request', req => {
    networkRequests.push({ method: req.method(), url: req.url() });
  });
  page.on('response', res => {
    if (res.status() >= 400) {
      networkErrors.push({ url: res.url(), status: res.status(), failure: null });
    }
  });

  // Shared context (refs map populated by snapshot -i for @eN selectors)
  const ctx = { refs: {} };

  // Sync refs from page after each snapshot
  const wrapCtx = (fn) => async (pg, args) => {
    await fn(pg, args, ctx);
    // pull back any refs stored on page during snapshot
    if (pg.__gstack_refs) Object.assign(ctx.refs, pg.__gstack_refs);
  };

  try {
    for (const task of queue) {
      log(`> ${task.name}`);
      await task.fn(page, task.args, ctx);
      if (page.__gstack_refs) Object.assign(ctx.refs, page.__gstack_refs);
    }
  } catch (err) {
    process.stderr.write(`[Fatal] ${err.message}\n${err.stack || ''}\n`);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

main();
