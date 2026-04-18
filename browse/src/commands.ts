/**
 * Command registry — single source of truth for all browse commands.
 *
 * Dependency graph:
 *   commands.ts ──▶ server.ts (runtime dispatch)
 *                ──▶ gen-skill-docs.ts (doc generation)
 *                ──▶ skill-parser.ts (validation)
 *                ──▶ skill-check.ts (health reporting)
 *
 * Zero side effects. Safe to import from build scripts and tests.
 */

export const READ_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility',
  'js', 'eval', 'css', 'attrs',
  'console', 'network', 'cookies', 'storage', 'perf',
  'dialog', 'is',
  'inspect',
  'media', 'data',
]);

export const WRITE_COMMANDS = new Set([
  'goto', 'back', 'forward', 'reload',
  'load-html',
  'click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait',
  'viewport', 'cookie', 'cookie-import', 'cookie-import-browser', 'header', 'useragent',
  'upload', 'dialog-accept', 'dialog-dismiss',
  'style', 'cleanup', 'prettyscreenshot',
  'download', 'scrape', 'archive',
]);

export const META_COMMANDS = new Set([
  'tabs', 'tab', 'newtab', 'closetab',
  'status', 'stop', 'restart',
  'screenshot', 'pdf', 'responsive',
  'chain', 'diff',
  'url', 'snapshot',
  'handoff', 'resume',
  'connect', 'disconnect', 'focus',
  'inbox',
  'watch',
  'state',
  'frame',
  'ux-audit',
]);

export const ALL_COMMANDS = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);

/** Commands that return untrusted third-party page content */
export const PAGE_CONTENT_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility', 'attrs',
  'console', 'dialog',
  'media', 'data',
  'ux-audit',
]);

/** Wrap output from untrusted-content commands with trust boundary markers */
export function wrapUntrustedContent(result: string, url: string): string {
  // Sanitize URL: remove newlines to prevent marker injection via history.pushState
  const safeUrl = url.replace(/[\n\r]/g, '').slice(0, 200);
  // Escape marker strings in content to prevent boundary escape attacks
  const safeResult = result.replace(/--- (BEGIN|END) UNTRUSTED EXTERNAL CONTENT/g, '--- $1 UNTRUSTED EXTERNAL C\u200BONTENT');
  return `--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: ${safeUrl}) ---\n${safeResult}\n--- END UNTRUSTED EXTERNAL CONTENT ---`;
}

export const COMMAND_DESCRIPTIONS: Record<string, { category: string; description: string; usage?: string }> = {
  // Navigation
  'goto':    { category: 'Navigation', description: 'Navigate to URL (http://, https://, or file:// scoped to cwd/TEMP_DIR)', usage: 'goto <url>' },
  'load-html': { category: 'Navigation', description: 'Load a local HTML file via setContent (no HTTP server needed). For self-contained HTML (inline CSS/JS, data URIs). For HTML on disk, goto file://... is often cleaner.', usage: 'load-html <file> [--wait-until load|domcontentloaded|networkidle]' },
  'back':    { category: 'Navigation', description: 'History back' },
  'forward': { category: 'Navigation', description: 'History forward' },
  'reload':  { category: 'Navigation', description: 'Reload page' },
  'url':     { category: 'Navigation', description: 'Print current URL' },
  // Reading
  'text':    { category: 'Reading', description: 'Cleaned page text' },
  'html':    { category: 'Reading', description: 'innerHTML of selector (throws if not found), or full page HTML if no selector given', usage: 'html [selector]' },
  'links':   { category: 'Reading', description: 'All links as "text → href"' },
  'forms':   { category: 'Reading', description: 'Form fields as JSON' },
  'accessibility': { category: 'Reading', description: 'Full ARIA tree' },
  'media':   { category: 'Reading', description: 'All media elements (images, videos, audio) with URLs, dimensions, types', usage: 'media [--images|--videos|--audio] [selector]' },
  'data':    { category: 'Reading', description: 'Structured data: JSON-LD, Open Graph, Twitter Cards, meta tags', usage: 'data [--jsonld|--og|--meta|--twitter]' },
  // Inspection
  'js':      { category: 'Inspection', description: 'Run JavaScript expression and return result as string', usage: 'js <expr>' },
  'eval':    { category: 'Inspection', description: 'Run JavaScript from file and return result as string (path must be under /tmp or cwd)', usage: 'eval <file>' },
  'css':     { category: 'Inspection', description: 'Computed CSS value', usage: 'css <sel> <prop>' },
  'attrs':   { category: 'Inspection', description: 'Element attributes as JSON', usage: 'attrs <sel|@ref>' },
  'is':      { category: 'Inspection', description: 'State check (visible/hidden/enabled/disabled/checked/editable/focused)', usage: 'is <prop> <sel>' },
  'console': { category: 'Inspection', description: 'Console messages (--errors filters to error/warning)', usage: 'console [--clear|--errors]' },
  'network': { category: 'Inspection', description: 'Network requests', usage: 'network [--clear]' },
  'dialog':  { category: 'Inspection', description: 'Dialog messages', usage: 'dialog [--clear]' },
  'cookies': { category: 'Inspection', description: 'All cookies as JSON' },
  'storage': { category: 'Inspection', description: 'Read all localStorage + sessionStorage as JSON, or set <key> <value> to write localStorage', usage: 'storage [set k v]' },
  'perf':    { category: 'Inspection', description: 'Page load timings' },
  // Interaction
  'click':   { category: 'Interaction', description: 'Click element', usage: 'click <sel>' },
  'fill':    { category: 'Interaction', description: 'Fill input', usage: 'fill <sel> <val>' },
  'select':  { category: 'Interaction', description: 'Select dropdown option by value, label, or visible text', usage: 'select <sel> <val>' },
  'hover':   { category: 'Interaction', description: 'Hover element', usage: 'hover <sel>' },
  'type':    { category: 'Interaction', description: 'Type into focused element', usage: 'type <text>' },
  'press':   { category: 'Interaction', description: 'Press key — Enter, Tab, Escape, ArrowUp/Down/Left/Right, Backspace, Delete, Home, End, PageUp, PageDown, or modifiers like Shift+Enter', usage: 'press <key>' },
  'scroll':  { category: 'Interaction', description: 'Scroll element into view, or scroll to page bottom if no selector', usage: 'scroll [sel]' },
  'wait':    { category: 'Interaction', description: 'Wait for element, network idle, or page load (timeout: 15s)', usage: 'wait <sel|--networkidle|--load>' },
  'upload':  { category: 'Interaction', description: 'Upload file(s)', usage: 'upload <sel> <file> [file2...]' },
  'viewport':{ category: 'Interaction', description: 'Set viewport size and optional deviceScaleFactor (1-3, for retina screenshots). --scale requires a context rebuild.', usage: 'viewport [<WxH>] [--scale <n>]' },
  'cookie':  { category: 'Interaction', description: 'Set cookie on current page domain', usage: 'cookie <name>=<value>' },
  'cookie-import': { category: 'Interaction', description: 'Import cookies from JSON file', usage: 'cookie-import <json>' },
  'cookie-import-browser': { category: 'Interaction', description: 'Import cookies from installed Chromium browsers (opens picker, or use --domain for direct import)', usage: 'cookie-import-browser [browser] [--domain d]' },
  'header':  { category: 'Interaction', description: 'Set custom request header (colon-separated, sensitive values auto-redacted)', usage: 'header <name>:<value>' },
  'useragent': { category: 'Interaction', description: 'Set user agent', usage: 'useragent <string>' },
  'dialog-accept': { category: 'Interaction', description: 'Auto-accept next alert/confirm/prompt. Optional text is sent as the prompt response', usage: 'dialog-accept [text]' },
  'dialog-dismiss': { category: 'Interaction', description: 'Auto-dismiss next dialog' },
  // Data extraction
  'download': { category: 'Extraction', description: 'Download URL or media element to disk using browser cookies', usage: 'download <url|@ref> [path] [--base64]' },
  'scrape':   { category: 'Extraction', description: 'Bulk download all media from page. Writes manifest.json', usage: 'scrape <images|videos|media> [--selector sel] [--dir path] [--limit N]' },
  'archive':  { category: 'Extraction', description: 'Save complete page as MHTML via CDP', usage: 'archive [path]' },
  // Visual
  'screenshot': { category: 'Visual', description: 'Save screenshot. --selector targets a specific element (explicit flag form). Positional selectors starting with ./#/@/[ still work.', usage: 'screenshot [--selector <css>] [--viewport] [--clip x,y,w,h] [--base64] [selector|@ref] [path]' },
  'pdf':     { category: 'Visual', description: 'Save as PDF', usage: 'pdf [path]' },
  'responsive': { category: 'Visual', description: 'Screenshots at mobile (375x812), tablet (768x1024), desktop (1280x720). Saves as {prefix}-mobile.png etc.', usage: 'responsive [prefix]' },
  'diff':    { category: 'Visual', description: 'Text diff between pages', usage: 'diff <url1> <url2>' },
  // Tabs
  'tabs':    { category: 'Tabs', description: 'List open tabs' },
  'tab':     { category: 'Tabs', description: 'Switch to tab', usage: 'tab <id>' },
  'newtab':  { category: 'Tabs', description: 'Open new tab', usage: 'newtab [url]' },
  'closetab':{ category: 'Tabs', description: 'Close tab', usage: 'closetab [id]' },
  // Server
  'status':  { category: 'Server', description: 'Health check' },
  'stop':    { category: 'Server', description: 'Shutdown server' },
  'restart': { category: 'Server', description: 'Restart server' },
  // Meta
  'snapshot':{ category: 'Snapshot', description: 'Accessibility tree with @e refs for element selection. Flags: -i interactive only, -c compact, -d N depth limit, -s sel scope, -D diff vs previous, -a annotated screenshot, -o path output, -C cursor-interactive @c refs', usage: 'snapshot [flags]' },
  'chain':   { category: 'Meta', description: 'Run commands from JSON stdin. Format: [["cmd","arg1",...],...]' },
  // Handoff
  'handoff': { category: 'Server', description: 'Open visible Chrome at current page for user takeover', usage: 'handoff [message]' },
  'resume':  { category: 'Server', description: 'Re-snapshot after user takeover, return control to AI', usage: 'resume' },
  // Headed mode
  'connect': { category: 'Server', description: 'Launch headed Chromium with Chrome extension', usage: 'connect' },
  'disconnect': { category: 'Server', description: 'Disconnect headed browser, return to headless mode' },
  'focus':   { category: 'Server', description: 'Bring headed browser window to foreground (macOS)', usage: 'focus [@ref]' },
  // Inbox
  'inbox':   { category: 'Meta', description: 'List messages from sidebar scout inbox', usage: 'inbox [--clear]' },
  // Watch
  'watch':   { category: 'Meta', description: 'Passive observation — periodic snapshots while user browses', usage: 'watch [stop]' },
  // State
  'state':   { category: 'Server', description: 'Save/load browser state (cookies + URLs)', usage: 'state save|load <name>' },
  // Frame
  'frame':   { category: 'Meta', description: 'Switch to iframe context (or main to return)', usage: 'frame <sel|@ref|--name n|--url pattern|main>' },
  // CSS Inspector
  'inspect': { category: 'Inspection', description: 'Deep CSS inspection via CDP — full rule cascade, box model, computed styles', usage: 'inspect [selector] [--all] [--history]' },
  'style':   { category: 'Interaction', description: 'Modify CSS property on element (with undo support)', usage: 'style <sel> <prop> <value> | style --undo [N]' },
  'cleanup': { category: 'Interaction', description: 'Remove page clutter (ads, cookie banners, sticky elements, social widgets)', usage: 'cleanup [--ads] [--cookies] [--sticky] [--social] [--all]' },
  'prettyscreenshot': { category: 'Visual', description: 'Clean screenshot with optional cleanup, scroll positioning, and element hiding', usage: 'prettyscreenshot [--scroll-to sel|text] [--cleanup] [--hide sel...] [--width px] [path]' },
  // UX Audit
  'ux-audit': { category: 'Inspection', description: 'Extract page structure for UX behavioral analysis — site ID, nav, headings, text blocks, interactive elements. Returns JSON for agent interpretation.', usage: 'ux-audit' },
};

// Load-time validation: descriptions must cover exactly the command sets
const allCmds = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);
const descKeys = new Set(Object.keys(COMMAND_DESCRIPTIONS));
for (const cmd of allCmds) {
  if (!descKeys.has(cmd)) throw new Error(`COMMAND_DESCRIPTIONS missing entry for: ${cmd}`);
}
for (const key of descKeys) {
  if (!allCmds.has(key)) throw new Error(`COMMAND_DESCRIPTIONS has unknown command: ${key}`);
}

/**
 * Command aliases — user-friendly names that route to canonical commands.
 *
 * Single source of truth: server.ts dispatch and meta-commands.ts chain prevalidation
 * both import `canonicalizeCommand()`, so aliases resolve identically everywhere.
 *
 * When adding a new alias: keep the alias name guessable (e.g. setcontent → load-html
 * helps agents migrating from Puppeteer's page.setContent()).
 */
export const COMMAND_ALIASES: Record<string, string> = {
  'setcontent': 'load-html',
  'set-content': 'load-html',
  'setContent': 'load-html',
};

/** Resolve an alias to its canonical command name. Non-aliases pass through unchanged. */
export function canonicalizeCommand(cmd: string): string {
  return COMMAND_ALIASES[cmd] ?? cmd;
}

/**
 * Commands added in specific versions — enables future "this command was added in vX"
 * upgrade hints in unknown-command errors. Only helps agents on *newer* browse builds
 * that encounter typos of recently-added commands; does NOT help agents on old builds
 * that type a new command (they don't have this map).
 */
export const NEW_IN_VERSION: Record<string, string> = {
  'load-html': '0.19.0.0',
};

/**
 * Levenshtein distance (dynamic programming).
 * O(a.length * b.length) — fast for command name sizes (<20 chars).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) m.push([i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[a.length][b.length];
}

/**
 * Build an actionable error message for an unknown command.
 *
 * Pure function — takes the full command set + alias map + version map as args so tests
 * can exercise the synthetic "older-version" case without mutating any global state.
 *
 *   1. Always names the input.
 *   2. If Levenshtein distance ≤ 2 AND input.length ≥ 4, suggests the closest match
 *      (alphabetical tiebreak for determinism). Short-input guard prevents noisy
 *      suggestions for typos of 2-letter commands like 'js' or 'is'.
 *   3. If the input appears in newInVersion, appends an upgrade hint. Honesty caveat:
 *      this only fires on builds that have this handler AND the map entry; agents on
 *      older builds hitting a newly-added command won't see it. Net benefit compounds
 *      as more commands land.
 */
export function buildUnknownCommandError(
  command: string,
  commandSet: Set<string>,
  aliasMap: Record<string, string> = COMMAND_ALIASES,
  newInVersion: Record<string, string> = NEW_IN_VERSION,
): string {
  let msg = `Unknown command: '${command}'.`;

  // Suggestion via Levenshtein, gated on input length to avoid noisy short-input matches.
  // Candidates are pre-sorted alphabetically, so strict "d < bestDist" gives us the
  // closest match with alphabetical tiebreak for free — first equal-distance candidate
  // wins because subsequent equal-distance candidates fail the strict-less check.
  if (command.length >= 4) {
    let best: string | undefined;
    let bestDist = 3; // sentinel: distance 3 would be rejected by the <= 2 gate below
    const candidates = [...commandSet, ...Object.keys(aliasMap)].sort();
    for (const cand of candidates) {
      const d = levenshtein(command, cand);
      if (d <= 2 && d < bestDist) {
        best = cand;
        bestDist = d;
      }
    }
    if (best) msg += ` Did you mean '${best}'?`;
  }

  if (newInVersion[command]) {
    msg += ` This command was added in browse v${newInVersion[command]}. Upgrade: cd ~/.claude/skills/gstack && git pull && bun run build.`;
  }

  return msg;
}
