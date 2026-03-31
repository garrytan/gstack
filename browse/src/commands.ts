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
]);

export const WRITE_COMMANDS = new Set([
  'goto', 'back', 'forward', 'reload',
  'click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait',
  'viewport', 'cookie', 'cookie-import', 'cookie-import-browser', 'header', 'useragent',
  'upload', 'dialog-accept', 'dialog-dismiss',
  'style', 'cleanup', 'prettyscreenshot',
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
]);

export const ALL_COMMANDS = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);

/** Commands that return untrusted third-party page content */
export const PAGE_CONTENT_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility',
  'console', 'dialog',
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
  'goto':    { category: 'Navigation', description: 'Navigate to URL', usage: 'goto <url>' },
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
  'viewport':{ category: 'Interaction', description: 'Set viewport size', usage: 'viewport <WxH>' },
  'cookie':  { category: 'Interaction', description: 'Set cookie on current page domain', usage: 'cookie <name>=<value>' },
  'cookie-import': { category: 'Interaction', description: 'Import cookies from JSON file', usage: 'cookie-import <json>' },
  'cookie-import-browser': { category: 'Interaction', description: 'Import cookies from installed Chromium browsers (opens picker, or use --domain for direct import)', usage: 'cookie-import-browser [browser] [--domain d]' },
  'header':  { category: 'Interaction', description: 'Set custom request header (colon-separated, sensitive values auto-redacted)', usage: 'header <name>:<value>' },
  'useragent': { category: 'Interaction', description: 'Set user agent', usage: 'useragent <string>' },
  'dialog-accept': { category: 'Interaction', description: 'Auto-accept next alert/confirm/prompt. Optional text is sent as the prompt response', usage: 'dialog-accept [text]' },
  'dialog-dismiss': { category: 'Interaction', description: 'Auto-dismiss next dialog' },
  // Visual
  'screenshot': { category: 'Visual', description: 'Save screenshot (supports element crop via CSS/@ref, --clip region, --viewport)', usage: 'screenshot [--viewport] [--clip x,y,w,h] [selector|@ref] [path]' },
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
