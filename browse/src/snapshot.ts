/**
 * Snapshot command — accessibility tree with ref-based element selection
 *
 * Architecture (Locator map — no DOM mutation):
 *   1. page.locator(scope).ariaSnapshot() → YAML-like accessibility tree
 *   2. Parse tree, assign refs @e1, @e2, ...
 *   3. Build Playwright Locator for each ref (getByRole + nth)
 *   4. Store Map<string, Locator> on BrowserManager
 *   5. Return compact text output with refs prepended
 *
 * Extended features:
 *   --diff / -D:       Compare against last snapshot, return unified diff
 *   --annotate / -a:   Screenshot with overlay boxes at each @ref
 *   --output / -o:     Output path for annotated screenshot
 *   -C / --cursor-interactive: Scan for cursor:pointer/onclick/tabindex elements
 *
 * Later: "click @e3" → look up Locator → locator.click()
 */

import type { Page, Frame, Locator } from 'playwright';
import type { TabSession, RefEntry } from './tab-session';
import * as Diff from 'diff';
import { TEMP_DIR, isPathWithin } from './platform';

// Roles considered "interactive" for the -i flag
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem',
]);

interface SnapshotOptions {
  interactive?: boolean;       // -i: only interactive elements
  compact?: boolean;           // -c: remove empty structural elements
  depth?: number;              // -d N: limit tree depth
  selector?: string;           // -s SEL: scope to CSS selector
  diff?: boolean;              // -D / --diff: diff against last snapshot
  annotate?: boolean;          // -a / --annotate: annotated screenshot
  outputPath?: string;         // -o / --output: path for annotated screenshot
  cursorInteractive?: boolean; // -C / --cursor-interactive: scan cursor:pointer etc.
  heatmap?: string;            // -H / --heatmap: JSON color map for ref overlays
}

/**
 * Snapshot flag metadata — single source of truth for CLI parsing and doc generation.
 *
 * Imported by:
 *   - gen-skill-docs.ts (generates {{SNAPSHOT_FLAGS}} tables)
 *   - skill-parser.ts (validates flags in SKILL.md examples)
 */
export const SNAPSHOT_FLAGS: Array<{
  short: string;
  long: string;
  description: string;
  takesValue?: boolean;
  valueHint?: string;
  optionKey: keyof SnapshotOptions;
}> = [
  { short: '-i', long: '--interactive', description: 'Interactive elements only (buttons, links, inputs) with @e refs. Also auto-enables cursor-interactive scan (-C) to capture dropdowns and popovers.', optionKey: 'interactive' },
  { short: '-c', long: '--compact', description: 'Compact (no empty structural nodes)', optionKey: 'compact' },
  { short: '-d', long: '--depth', description: 'Limit tree depth (0 = root only, default: unlimited)', takesValue: true, valueHint: '<N>', optionKey: 'depth' },
  { short: '-s', long: '--selector', description: 'Scope to CSS selector', takesValue: true, valueHint: '<sel>', optionKey: 'selector' },
  { short: '-D', long: '--diff', description: 'Unified diff against previous snapshot (first call stores baseline)', optionKey: 'diff' },
  { short: '-a', long: '--annotate', description: 'Annotated screenshot with red overlay boxes and ref labels', optionKey: 'annotate' },
  { short: '-o', long: '--output', description: 'Output path for annotated screenshot (default: <temp>/browse-annotated.png)', takesValue: true, valueHint: '<path>', optionKey: 'outputPath' },
  { short: '-C', long: '--cursor-interactive', description: 'Cursor-interactive elements (@c refs — divs with pointer, onclick). Auto-enabled when -i is used.', optionKey: 'cursorInteractive' },
  { short: '-H', long: '--heatmap', description: 'Color-coded overlay screenshot from JSON map: \'{"@e1":"green","@e3":"red"}\'. Valid colors: green, yellow, red, blue, orange, gray.', takesValue: true, valueHint: '<json>', optionKey: 'heatmap' },
];

interface ParsedNode {
  indent: number;
  role: string;
  name: string | null;
  props: string;      // e.g., "[level=1]"
  children: string;   // inline text content after ":"
  rawLine: string;
}

/**
 * Parse CLI args into SnapshotOptions — driven by SNAPSHOT_FLAGS metadata.
 */
export function parseSnapshotArgs(args: string[]): SnapshotOptions {
  const opts: SnapshotOptions = {};
  for (let i = 0; i < args.length; i++) {
    const flag = SNAPSHOT_FLAGS.find(f => f.short === args[i] || f.long === args[i]);
    if (!flag) throw new Error(`Unknown snapshot flag: ${args[i]}`);
    if (flag.takesValue) {
      const value = args[++i];
      if (!value) throw new Error(`Usage: snapshot ${flag.short} <value>`);
      if (flag.optionKey === 'depth') {
        (opts as any)[flag.optionKey] = parseInt(value, 10);
        if (isNaN(opts.depth!)) throw new Error('Usage: snapshot -d <number>');
      } else {
        (opts as any)[flag.optionKey] = value;
      }
    } else {
      (opts as any)[flag.optionKey] = true;
    }
  }
  return opts;
}

/**
 * Parse one line of ariaSnapshot output.
 *
 * Format examples:
 *   - heading "Test" [level=1]
 *   - link "Link A":
 *     - /url: /a
 *   - textbox "Name"
 *   - paragraph: Some text
 *   - combobox "Role":
 */
function parseLine(line: string): ParsedNode | null {
  // Match: (indent)(- )(role)( "name")?( [props])?(: inline)?
  const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+(\[.*?\]))?\s*(?::\s*(.*))?$/);
  if (!match) {
    // Skip metadata lines like "- /url: /a"
    return null;
  }
  return {
    indent: match[1].length,
    role: match[2],
    name: match[3] ?? null,
    props: match[4] || '',
    children: match[5]?.trim() || '',
    rawLine: line,
  };
}

/**
 * Take an accessibility snapshot and build the ref map.
 */
export async function handleSnapshot(
  args: string[],
  session: TabSession,
  securityOpts?: { splitForScoped?: boolean },
): Promise<string> {
  const opts = parseSnapshotArgs(args);
  const page = session.getPage();
  // Frame-aware target for accessibility tree
  const target = session.getActiveFrameOrPage();
  const inFrame = session.getFrame() !== null;

  // Get accessibility tree via ariaSnapshot
  let rootLocator: Locator;
  if (opts.selector) {
    rootLocator = target.locator(opts.selector);
    const count = await rootLocator.count();
    if (count === 0) throw new Error(`Selector not found: ${opts.selector}`);
  } else {
    rootLocator = target.locator('body');
  }

  const ariaText = await rootLocator.ariaSnapshot();
  if (!ariaText || ariaText.trim().length === 0) {
    session.setRefMap(new Map());
    return '(no accessible elements found)';
  }

  // Parse the ariaSnapshot output
  const lines = ariaText.split('\n');
  const refMap = new Map<string, RefEntry>();
  const output: string[] = [];
  let refCounter = 1;

  // Track role+name occurrences for nth() disambiguation
  const roleNameCounts = new Map<string, number>();
  const roleNameSeen = new Map<string, number>();

  // First pass: count role+name pairs for disambiguation
  for (const line of lines) {
    const node = parseLine(line);
    if (!node) continue;
    const key = `${node.role}:${node.name || ''}`;
    roleNameCounts.set(key, (roleNameCounts.get(key) || 0) + 1);
  }

  // Second pass: assign refs and build locators
  for (const line of lines) {
    const node = parseLine(line);
    if (!node) continue;

    const depth = Math.floor(node.indent / 2);
    const isInteractive = INTERACTIVE_ROLES.has(node.role);

    // Depth filter
    if (opts.depth !== undefined && depth > opts.depth) continue;

    // Interactive filter: skip non-interactive but still count for locator indices
    if (opts.interactive && !isInteractive) {
      // Still track for nth() counts
      const key = `${node.role}:${node.name || ''}`;
      roleNameSeen.set(key, (roleNameSeen.get(key) || 0) + 1);
      continue;
    }

    // Compact filter: skip elements with no name and no inline content that aren't interactive
    if (opts.compact && !isInteractive && !node.name && !node.children) continue;

    // Assign ref
    const ref = `e${refCounter++}`;
    const indent = '  '.repeat(depth);

    // Build Playwright locator
    const key = `${node.role}:${node.name || ''}`;
    const seenIndex = roleNameSeen.get(key) || 0;
    roleNameSeen.set(key, seenIndex + 1);
    const totalCount = roleNameCounts.get(key) || 1;

    let locator: Locator;
    if (opts.selector) {
      locator = target.locator(opts.selector).getByRole(node.role as any, {
        name: node.name || undefined,
      });
    } else {
      locator = target.getByRole(node.role as any, {
        name: node.name || undefined,
      });
    }

    // Disambiguate with nth() if multiple elements share role+name
    if (totalCount > 1) {
      locator = locator.nth(seenIndex);
    }

    refMap.set(ref, { locator, role: node.role, name: node.name || '' });

    // Format output line
    let outputLine = `${indent}@${ref} [${node.role}]`;
    if (node.name) outputLine += ` "${node.name}"`;
    if (node.props) outputLine += ` ${node.props}`;
    if (node.children) outputLine += `: ${node.children}`;

    output.push(outputLine);
  }

  // ─── Cursor-interactive scan (-C, or auto with -i) ────────
  // Auto-enable cursor scan when interactive mode is on — agents asking for
  // interactive elements should always see clickable non-ARIA items too.
  if (opts.interactive && !opts.cursorInteractive) {
    opts.cursorInteractive = true;
  }
  if (opts.cursorInteractive) {
    try {
      const cursorElements = await target.evaluate(() => {
        const STANDARD_INTERACTIVE = new Set([
          'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS',
        ]);

        const results: Array<{ selector: string; text: string; reason: string }> = [];
        const allElements = document.querySelectorAll('*');

        for (const el of allElements) {
          // Skip standard interactive elements (already in ARIA tree)
          if (STANDARD_INTERACTIVE.has(el.tagName)) continue;
          // Skip hidden elements
          if (!(el as HTMLElement).offsetParent && el.tagName !== 'BODY') continue;

          const style = getComputedStyle(el);
          const hasCursorPointer = style.cursor === 'pointer';
          const hasOnclick = el.hasAttribute('onclick');
          const hasTabindex = el.hasAttribute('tabindex') && parseInt(el.getAttribute('tabindex')!, 10) >= 0;
          const hasRole = el.hasAttribute('role');

          // Check if element is inside a floating container (portal/popover/dropdown)
          const isInFloating = (() => {
            let parent: Element | null = el;
            while (parent && parent !== document.documentElement) {
              const pStyle = getComputedStyle(parent);
              const isFloating = (pStyle.position === 'fixed' || pStyle.position === 'absolute') &&
                parseInt(pStyle.zIndex || '0', 10) >= 10;
              const hasPortalAttr = parent.hasAttribute('data-floating-ui-portal') ||
                parent.hasAttribute('data-radix-popper-content-wrapper') ||
                parent.hasAttribute('data-radix-portal') ||
                parent.hasAttribute('data-popper-placement') ||
                parent.getAttribute('role') === 'listbox' ||
                parent.getAttribute('role') === 'menu';
              if (isFloating || hasPortalAttr) return true;
              parent = parent.parentElement;
            }
            return false;
          })();

          if (!hasCursorPointer && !hasOnclick && !hasTabindex) {
            // For elements inside floating containers, also check for role="option"/"menuitem"
            if (isInFloating && hasRole) {
              const role = el.getAttribute('role');
              if (role !== 'option' && role !== 'menuitem' && role !== 'menuitemcheckbox' && role !== 'menuitemradio') continue;
            } else {
              continue;
            }
          }
          // Skip elements with ARIA roles UNLESS they're inside a floating container
          // (floating container items may be missed by the accessibility tree)
          if (hasRole && !isInFloating) continue;

          // Build deterministic nth-child CSS path
          const parts: string[] = [];
          let current: Element | null = el;
          while (current && current !== document.documentElement) {
            const parent = current.parentElement;
            if (!parent) break;
            const siblings = [...parent.children];
            const index = siblings.indexOf(current) + 1;
            parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
            current = parent;
          }
          const selector = parts.join(' > ');

          const text = (el as HTMLElement).innerText?.trim().slice(0, 80) || el.tagName.toLowerCase();
          const reasons: string[] = [];
          if (isInFloating) reasons.push('popover-child');
          if (hasCursorPointer) reasons.push('cursor:pointer');
          if (hasOnclick) reasons.push('onclick');
          if (hasTabindex) reasons.push(`tabindex=${el.getAttribute('tabindex')}`);
          if (hasRole) reasons.push(`role=${el.getAttribute('role')}`);

          results.push({ selector, text, reason: reasons.join(', ') });
        }
        return results;
      });

      if (cursorElements.length > 0) {
        output.push('');
        output.push('── cursor-interactive (not in ARIA tree) ──');
        let cRefCounter = 1;
        for (const elem of cursorElements) {
          const ref = `c${cRefCounter++}`;
          const locator = target.locator(elem.selector);
          refMap.set(ref, { locator, role: 'cursor-interactive', name: elem.text });
          output.push(`@${ref} [${elem.reason}] "${elem.text}"`);
        }
      }
    } catch (err: any) {
      // Cursor scan fails on pages with strict CSP or when page has navigated
      if (!err?.message?.includes('Execution context') && !err?.message?.includes('closed') && !err?.message?.includes('Target') && !err?.message?.includes('Content Security')) throw err;
      output.push('');
      output.push('(cursor scan failed — CSP restriction)');
    }
  }

  // Store ref map on BrowserManager
  session.setRefMap(refMap);

  if (output.length === 0) {
    return '(no interactive elements found)';
  }

  const snapshotText = output.join('\n');

  // ─── Annotated screenshot (-a) ────────────────────────────
  if (opts.annotate) {
    const screenshotPath = opts.outputPath || `${TEMP_DIR}/browse-annotated.png`;
    // Validate output path — resolve symlinks to prevent symlink traversal attacks
    {
      const nodePath = require('path') as typeof import('path');
      const nodeFs = require('fs') as typeof import('fs');
      const absolute = nodePath.resolve(screenshotPath);
      const safeDirs = [TEMP_DIR, process.cwd()].map((d: string) => {
        try { return nodeFs.realpathSync(d); } catch (err: any) { if (err?.code !== 'ENOENT') throw err; return d; }
      });
      let realPath: string;
      try {
        realPath = nodeFs.realpathSync(absolute);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          try {
            const dir = nodeFs.realpathSync(nodePath.dirname(absolute));
            realPath = nodePath.join(dir, nodePath.basename(absolute));
          } catch (err2: any) {
            if (err2?.code !== 'ENOENT') throw err2;
            realPath = absolute;
          }
        } else {
          throw new Error(`Cannot resolve real path: ${screenshotPath} (${err.code})`);
        }
      }
      if (!safeDirs.some((dir: string) => isPathWithin(realPath, dir))) {
        throw new Error(`Path must be within: ${safeDirs.join(', ')}`);
      }
    }
    try {
      // Inject overlay divs at each ref's bounding box
      const boxes: Array<{ ref: string; box: { x: number; y: number; width: number; height: number } }> = [];
      for (const [ref, entry] of refMap) {
        try {
          const box = await entry.locator.boundingBox({ timeout: 1000 });
          if (box) {
            boxes.push({ ref: `@${ref}`, box });
          }
        } catch (err: any) {
          // Element may be offscreen, hidden, or page navigated — skip
          if (!err?.message?.includes('Timeout') && !err?.message?.includes('timeout') && !err?.message?.includes('closed') && !err?.message?.includes('Target') && !err?.message?.includes('Execution context')) throw err;
        }
      }

      await page.evaluate((boxes) => {
        for (const { ref, box } of boxes) {
          const overlay = document.createElement('div');
          overlay.className = '__browse_annotation__';
          overlay.style.cssText = `
            position: absolute; top: ${box.y}px; left: ${box.x}px;
            width: ${box.width}px; height: ${box.height}px;
            border: 2px solid red; background: rgba(255,0,0,0.1);
            pointer-events: none; z-index: 99999;
            font-size: 10px; color: red; font-weight: bold;
          `;
          const label = document.createElement('span');
          label.textContent = ref;
          label.style.cssText = 'position: absolute; top: -14px; left: 0; background: red; color: white; padding: 0 3px; font-size: 10px;';
          overlay.appendChild(label);
          document.body.appendChild(overlay);
        }
      }, boxes);

      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Always remove overlays
      await page.evaluate(() => {
        document.querySelectorAll('.__browse_annotation__').forEach(el => el.remove());
      });

      output.push('');
      output.push(`[annotated screenshot: ${screenshotPath}]`);
    } catch (err: any) {
      // Remove overlays even on screenshot failure — but only swallow page/browser errors
      if (!err?.message?.includes('closed') && !err?.message?.includes('Target') && !err?.message?.includes('Execution context') && !err?.message?.includes('screenshot')) throw err;
      try {
        await page.evaluate(() => {
          document.querySelectorAll('.__browse_annotation__').forEach(el => el.remove());
        });
      } catch (err2: any) {
        if (!err2?.message?.includes('closed') && !err2?.message?.includes('Target') && !err2?.message?.includes('Execution context')) throw err2;
      }
    }
  }

  // ─── Heatmap mode (-H) ──────────────────────────────────────
  if (opts.heatmap) {
    const heatmapPath = opts.outputPath || `${TEMP_DIR}/browse-heatmap.png`;
    // Validate output path
    {
      const nodePath = require('path') as typeof import('path');
      const nodeFs = require('fs') as typeof import('fs');
      const absolute = nodePath.resolve(heatmapPath);
      const safeDirs = [TEMP_DIR, process.cwd()].map((d: string) => {
        try { return nodeFs.realpathSync(d); } catch (err: any) { if (err?.code !== 'ENOENT') throw err; return d; }
      });
      let realPath: string;
      try {
        realPath = nodeFs.realpathSync(absolute);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          try {
            const dir = nodeFs.realpathSync(nodePath.dirname(absolute));
            realPath = nodePath.join(dir, nodePath.basename(absolute));
          } catch (err2: any) {
            if (err2?.code !== 'ENOENT') throw err2;
            realPath = absolute;
          }
        } else {
          throw new Error(`Cannot resolve real path: ${heatmapPath} (${err.code})`);
        }
      }
      if (!safeDirs.some((dir: string) => isPathWithin(realPath, dir))) {
        throw new Error(`Path must be within: ${safeDirs.join(', ')}`);
      }
    }

    // Parse and validate color map
    const VALID_COLORS = new Set(['green', 'yellow', 'red', 'blue', 'orange', 'gray']);
    const COLOR_MAP: Record<string, { border: string; bg: string }> = {
      green:  { border: '#00b400', bg: 'rgba(0,180,0,0.15)' },
      yellow: { border: '#ffb400', bg: 'rgba(255,180,0,0.15)' },
      red:    { border: '#ff0000', bg: 'rgba(255,0,0,0.15)' },
      blue:   { border: '#0066ff', bg: 'rgba(0,102,255,0.15)' },
      orange: { border: '#ff6600', bg: 'rgba(255,102,0,0.15)' },
      gray:   { border: '#888888', bg: 'rgba(136,136,136,0.15)' },
    };

    let colorAssignments: Record<string, string>;
    try {
      const parsed = JSON.parse(opts.heatmap);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      colorAssignments = parsed;
    } catch {
      throw new Error('Invalid heatmap JSON. Expected object: \'{"@e1":"green","@e3":"red"}\'');
    }

    // Validate colors
    for (const [ref, color] of Object.entries(colorAssignments)) {
      if (!VALID_COLORS.has(color)) {
        throw new Error(`Invalid heatmap color "${color}" for ${ref}. Valid: ${[...VALID_COLORS].join(', ')}`);
      }
    }

    try {
      const boxes: Array<{ ref: string; box: { x: number; y: number; width: number; height: number }; color: string }> = [];
      for (const [refKey, color] of Object.entries(colorAssignments)) {
        const cleanRef = refKey.startsWith('@') ? refKey.slice(1) : refKey;
        const entry = refMap.get(cleanRef);
        if (!entry) continue; // Skip refs not found on page
        try {
          const box = await entry.locator.boundingBox({ timeout: 1000 });
          if (box) {
            const colors = COLOR_MAP[color] || COLOR_MAP.gray;
            boxes.push({ ref: `@${cleanRef}`, box, color: JSON.stringify(colors) });
          }
        } catch {
          // Element may be offscreen or hidden — skip
        }
      }

      await page.evaluate((boxes) => {
        for (const { ref, box, color } of boxes) {
          const colors = JSON.parse(color);
          const overlay = document.createElement('div');
          overlay.className = '__browse_heatmap__';
          overlay.style.cssText = `
            position: absolute; top: ${box.y}px; left: ${box.x}px;
            width: ${box.width}px; height: ${box.height}px;
            border: 2px solid ${colors.border}; background: ${colors.bg};
            pointer-events: none; z-index: 99999;
            font-size: 10px; color: ${colors.border}; font-weight: bold;
          `;
          const label = document.createElement('span');
          label.textContent = ref;
          label.style.cssText = `position: absolute; top: -14px; left: 0; background: ${colors.border}; color: white; padding: 0 3px; font-size: 10px;`;
          overlay.appendChild(label);
          document.body.appendChild(overlay);
        }
      }, boxes);

      await page.screenshot({ path: heatmapPath, fullPage: true });

      // Remove heatmap overlays
      await page.evaluate(() => {
        document.querySelectorAll('.__browse_heatmap__').forEach(el => el.remove());
      });

      output.push('');
      output.push(`[heatmap screenshot: ${heatmapPath}]`);
    } catch (err: any) {
      // Cleanup on failure
      try {
        await page.evaluate(() => {
          document.querySelectorAll('.__browse_heatmap__').forEach(el => el.remove());
        });
      } catch {}
      if (!err?.message?.includes('closed') && !err?.message?.includes('Target') && !err?.message?.includes('Execution context') && !err?.message?.includes('screenshot')) throw err;
    }
  }

  // ─── Diff mode (-D) ───────────────────────────────────────
  if (opts.diff) {
    const lastSnapshot = session.getLastSnapshot();
    if (!lastSnapshot) {
      session.setLastSnapshot(snapshotText);
      return snapshotText + '\n\n(no previous snapshot to diff against — this snapshot stored as baseline)';
    }

    const changes = Diff.diffLines(lastSnapshot, snapshotText);
    const diffOutput: string[] = ['--- previous snapshot', '+++ current snapshot', ''];

    for (const part of changes) {
      const prefix = part.added ? '+' : part.removed ? '-' : ' ';
      const diffLines = part.value.split('\n').filter(l => l.length > 0);
      for (const line of diffLines) {
        diffOutput.push(`${prefix} ${line}`);
      }
    }

    session.setLastSnapshot(snapshotText);
    return diffOutput.join('\n');
  }

  // Store for future diffs
  session.setLastSnapshot(snapshotText);

  // Add frame context header when operating inside an iframe
  if (inFrame) {
    const frameUrl = session.getFrame()?.url() ?? 'unknown';
    output.unshift(`[Context: iframe src="${frameUrl}"]`);
  }

  // Split output for scoped tokens: trusted refs + untrusted text
  if (securityOpts?.splitForScoped) {
    const trustedRefs: string[] = [];
    const untrustedLines: string[] = [];

    for (const line of output) {
      // Lines starting with @ref are interactive elements (trusted metadata)
      const refMatch = line.match(/^(\s*)@(e\d+|c\d+)\s+\[([^\]]+)\]\s*(.*)/);
      if (refMatch) {
        const [, indent, ref, role, rest] = refMatch;
        // Truncate element name/content to 50 chars for trusted section
        const nameMatch = rest.match(/^"(.+?)"/);
        let truncName = nameMatch ? nameMatch[1] : rest.trim();
        if (truncName.length > 50) truncName = truncName.slice(0, 47) + '...';
        trustedRefs.push(`${indent}@${ref} [${role}] "${truncName}"`);
      }
      // All lines go to untrusted section (full content)
      untrustedLines.push(line);
    }

    const parts: string[] = [];
    if (trustedRefs.length > 0) {
      parts.push('INTERACTIVE ELEMENTS (trusted — use these @refs for click/fill):');
      parts.push(...trustedRefs);
      parts.push('');
    }
    parts.push('═══ BEGIN UNTRUSTED WEB CONTENT ═══');
    parts.push(...untrustedLines);
    parts.push('═══ END UNTRUSTED WEB CONTENT ═══');
    return parts.join('\n');
  }

  return output.join('\n');
}
