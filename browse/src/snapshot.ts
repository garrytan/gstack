/**
 * Snapshot command — accessibility tree with ref-based element selection
 *
 * Architecture (frozen handle map — no DOM mutation):
 *   1. page.locator(scope).ariaSnapshot() → YAML-like accessibility tree
 *   2. Parse tree, assign refs @e1, @e2, ...
 *   3. Build Playwright Locator for each ref (getByRole + nth)
 *   4. Resolve each locator to an ElementHandle and store it per tab
 *   5. Return compact text output with refs prepended
 *
 * Later: "click @e3" → look up frozen handle → handle.click()
 */

import type { ElementHandle, Locator } from 'playwright';
import type { BrowserManager } from './browser-manager';

// Roles considered "interactive" for the -i flag
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem',
]);

interface SnapshotOptions {
  interactive?: boolean;  // -i: only interactive elements
  compact?: boolean;      // -c: remove empty structural elements
  depth?: number;         // -d N: limit tree depth
  selector?: string;      // -s SEL: scope to CSS selector
}

interface ParsedNode {
  indent: number;
  role: string;
  name: string | null;
  props: string;      // e.g., "[level=1]"
  children: string;   // inline text content after ":"
  rawLine: string;
}

function unescapeQuotedText(value: string): string {
  return value.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
}

/**
 * Parse CLI args into SnapshotOptions
 */
export function parseSnapshotArgs(args: string[]): SnapshotOptions {
  const opts: SnapshotOptions = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-i':
      case '--interactive':
        opts.interactive = true;
        break;
      case '-c':
      case '--compact':
        opts.compact = true;
        break;
      case '-d':
      case '--depth':
        opts.depth = parseInt(args[++i], 10);
        if (isNaN(opts.depth!)) throw new Error('Usage: snapshot -d <number>');
        break;
      case '-s':
      case '--selector':
        opts.selector = args[++i];
        if (!opts.selector) throw new Error('Usage: snapshot -s <selector>');
        break;
      default:
        throw new Error(`Unknown snapshot flag: ${args[i]}`);
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
  const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+(\[.*?\]))?\s*(?::\s*(.*))?$/);
  if (!match) {
    // Skip metadata lines like "- /url: /a"
    return null;
  }
  return {
    indent: match[1].length,
    role: match[2],
    name: match[3] ? unescapeQuotedText(match[3]) : null,
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
  bm: BrowserManager
): Promise<string> {
  const opts = parseSnapshotArgs(args);
  const page = bm.getPage();

  // Get accessibility tree via ariaSnapshot
  let rootLocator: Locator;
  if (opts.selector) {
    rootLocator = page.locator(opts.selector);
    const count = await rootLocator.count();
    if (count === 0) throw new Error(`Selector not found: ${opts.selector}`);
  } else {
    rootLocator = page.locator('body');
  }

  const ariaText = await rootLocator.ariaSnapshot();
  if (!ariaText || ariaText.trim().length === 0) {
    bm.setRefMap(new Map());
    return '(no accessible elements found)';
  }

  // Parse the ariaSnapshot output
  const lines = ariaText.split('\n');
  const refMap = new Map<string, ElementHandle<Node>>();
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

  function markRoleNameSeen(node: ParsedNode) {
    const key = `${node.role}:${node.name || ''}`;
    roleNameSeen.set(key, (roleNameSeen.get(key) || 0) + 1);
  }

  // Second pass: assign refs and build locators
  for (const line of lines) {
    const node = parseLine(line);
    if (!node) continue;

    const depth = Math.floor(node.indent / 2);
    const isInteractive = INTERACTIVE_ROLES.has(node.role);

    // Depth filter
    if (opts.depth !== undefined && depth > opts.depth) {
      // Skipped nodes still occupy nth() slots for later same-name matches.
      markRoleNameSeen(node);
      continue;
    }

    // Interactive filter: skip non-interactive but still count for locator indices
    if (opts.interactive && !isInteractive) {
      // Still track for nth() counts
      markRoleNameSeen(node);
      continue;
    }

    // Compact filter: skip elements with no name and no inline content that aren't interactive
    if (opts.compact && !isInteractive && !node.name && !node.children) {
      markRoleNameSeen(node);
      continue;
    }

    const indent = '  '.repeat(depth);

    // Build Playwright locator
    const key = `${node.role}:${node.name || ''}`;
    const seenIndex = roleNameSeen.get(key) || 0;
    roleNameSeen.set(key, seenIndex + 1);
    const totalCount = roleNameCounts.get(key) || 1;

    let locator: Locator;
    if (opts.selector) {
      locator = page.locator(opts.selector).getByRole(node.role as any, {
        name: node.name || undefined,
      });
    } else {
      locator = page.getByRole(node.role as any, {
        name: node.name || undefined,
      });
    }

    // Disambiguate with nth() if multiple elements share role+name
    if (totalCount > 1) {
      locator = locator.nth(seenIndex);
    }

    // Some accessibility nodes (for example structural text nodes) do not map
    // cleanly back to a single DOM element. Skip those instead of stalling the
    // whole snapshot.
    let handle: ElementHandle<Node> | null = null;
    try {
      const count = await locator.count();
      if (count !== 1) continue;
      handle = await locator.elementHandle({ timeout: 100 });
    } catch {
      continue;
    }
    if (!handle) continue;

    const ref = `e${refCounter++}`;
    refMap.set(ref, handle);

    // Format output line
    let outputLine = `${indent}@${ref} [${node.role}]`;
    if (node.name) outputLine += ` "${node.name}"`;
    if (node.props) outputLine += ` ${node.props}`;
    if (node.children) outputLine += `: ${node.children}`;

    output.push(outputLine);
  }

  // Store ref map on BrowserManager
  bm.setRefMap(refMap);

  if (output.length === 0) {
    return '(no interactive elements found)';
  }

  return output.join('\n');
}
