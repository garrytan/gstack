/**
 * Command registry for agent-browser — single source of truth.
 *
 * Replaces browse/src/commands.ts for the agent-browser CLI.
 * Same export shape so the validation pipeline works unchanged.
 *
 * Dependency graph:
 *   agent-browser-commands.ts ──▶ gen-skill-docs.ts (doc generation)
 *                              ──▶ skill-parser.ts (validation)
 *                              ──▶ skill-check.ts (health reporting)
 *
 * Zero side effects. Safe to import from build scripts and tests.
 */

export const READ_COMMANDS = new Set([
  'get text', 'get html', 'get value', 'get attr', 'get title',
  'get url', 'get count', 'get box', 'get styles',
  'is visible', 'is enabled', 'is checked',
  'cookies get', 'storage local get', 'storage session get',
  'network requests',
  'eval',
]);

export const WRITE_COMMANDS = new Set([
  'open', 'click', 'dblclick', 'fill', 'type', 'press',
  'hover', 'select', 'check', 'uncheck',
  'scroll', 'scrollintoview',
  'focus', 'drag',
  'wait',
  'set viewport', 'set device', 'set geo', 'set offline',
  'set headers', 'set credentials', 'set media',
  'cookies set', 'cookies clear',
  'storage local set', 'storage session set',
  'storage local clear', 'storage session clear',
  'network route', 'network unroute',
  'dialog accept', 'dialog dismiss',
  'upload',
]);

export const META_COMMANDS = new Set([
  'snapshot',
  'screenshot', 'pdf',
  'diff snapshot', 'diff screenshot', 'diff url',
  'tab', 'tab new', 'tab switch', 'tab close',
  'window new',
  'frame', 'frame main',
  'find role', 'find text', 'find label',
  'find placeholder', 'find alt', 'find title', 'find testid',
  'close', 'connect',
]);

export const ALL_COMMANDS = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);

export const COMMAND_DESCRIPTIONS: Record<string, { category: string; description: string; usage?: string }> = {
  // Navigation
  'open':      { category: 'Navigation', description: 'Navigate to URL', usage: 'open <url>' },
  'click':     { category: 'Navigation', description: 'Click element', usage: 'click <sel>' },
  'dblclick':  { category: 'Navigation', description: 'Double-click element', usage: 'dblclick <sel>' },
  'focus':     { category: 'Navigation', description: 'Focus element', usage: 'focus <sel>' },
  'drag':      { category: 'Navigation', description: 'Drag element to target', usage: 'drag <from> <to>' },
  // Reading
  'get text':   { category: 'Reading', description: 'Get text content of page or element', usage: 'get text [sel]' },
  'get html':   { category: 'Reading', description: 'Get innerHTML of element or full page HTML', usage: 'get html [sel]' },
  'get value':  { category: 'Reading', description: 'Get value of input element', usage: 'get value <sel>' },
  'get attr':   { category: 'Reading', description: 'Get attribute value of element', usage: 'get attr <sel> <attr>' },
  'get title':  { category: 'Reading', description: 'Get page title' },
  'get url':    { category: 'Reading', description: 'Get current page URL' },
  'get count':  { category: 'Reading', description: 'Count matching elements', usage: 'get count <sel>' },
  'get box':    { category: 'Reading', description: 'Get bounding box of element', usage: 'get box <sel>' },
  'get styles': { category: 'Reading', description: 'Get computed CSS styles of element', usage: 'get styles <sel>' },
  // Interaction
  'fill':    { category: 'Interaction', description: 'Clear and fill input', usage: 'fill <sel> <val>' },
  'type':    { category: 'Interaction', description: 'Type text into focused element (appends)', usage: 'type <sel> <text>' },
  'press':   { category: 'Interaction', description: 'Press keyboard key. Valid keys: Enter, Tab, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete, Home, End, PageUp, PageDown, Space, F1-F12. Supports modifiers: Control+a, Shift+Enter, Meta+c', usage: 'press <key>' },
  'hover':   { category: 'Interaction', description: 'Hover over element', usage: 'hover <sel>' },
  'select':  { category: 'Interaction', description: 'Select dropdown option', usage: 'select <sel> <val>' },
  'check':   { category: 'Interaction', description: 'Check a checkbox', usage: 'check <sel>' },
  'uncheck': { category: 'Interaction', description: 'Uncheck a checkbox', usage: 'uncheck <sel>' },
  'scroll':  { category: 'Interaction', description: 'Scroll page. Direction: up, down, left, right. Amount: pixels (default 300). Examples: `scroll down 500`, `scroll up`', usage: 'scroll [direction] [amount]' },
  'scrollintoview': { category: 'Interaction', description: 'Scroll element into view', usage: 'scrollintoview <sel>' },
  'upload':  { category: 'Interaction', description: 'Upload file to file input', usage: 'upload <sel> <file>' },
  'wait':    { category: 'Interaction', description: 'Wait for condition (max 10s). Modes: `wait <sel>` element exists, `wait <ms>` timeout, `wait --text <text>` page contains text, `wait --url <pattern>` URL matches, `wait --load` page load complete, `wait --fn <expr>` JS expression truthy, `wait --state <state>` element state (visible/hidden/enabled/disabled)', usage: 'wait <sel|ms> [--text <text>|--url <pat>|--load|--fn <expr>|--state <state>]' },
  // Inspection
  'is visible': { category: 'Inspection', description: 'Check if element is visible', usage: 'is visible <sel>' },
  'is enabled': { category: 'Inspection', description: 'Check if element is enabled', usage: 'is enabled <sel>' },
  'is checked': { category: 'Inspection', description: 'Check if checkbox/radio is checked', usage: 'is checked <sel>' },
  'eval':       { category: 'Inspection', description: 'Run JavaScript expression and return result', usage: 'eval <expr>' },
  // Cookies & Storage
  'cookies get':            { category: 'Storage', description: 'Get all cookies as JSON' },
  'cookies set':            { category: 'Storage', description: 'Set a cookie. Domain defaults to current page domain', usage: 'cookies set <name>=<value> [domain]' },
  'cookies clear':          { category: 'Storage', description: 'Clear all cookies' },
  'storage local get':      { category: 'Storage', description: 'Get localStorage value', usage: 'storage local get [key]' },
  'storage session get':    { category: 'Storage', description: 'Get sessionStorage value', usage: 'storage session get [key]' },
  'storage local set':      { category: 'Storage', description: 'Set localStorage value', usage: 'storage local set <key> <value>' },
  'storage session set':    { category: 'Storage', description: 'Set sessionStorage value', usage: 'storage session set <key> <value>' },
  'storage local clear':    { category: 'Storage', description: 'Clear localStorage' },
  'storage session clear':  { category: 'Storage', description: 'Clear sessionStorage' },
  // Network
  'network requests': { category: 'Network', description: 'List captured network requests' },
  'network route':    { category: 'Network', description: 'Intercept and mock network requests. Pattern is a URL glob (e.g., `**/api/users`). Response is JSON: `{"status":200,"body":"...","headers":{}}`', usage: 'network route <pattern> [response-json]' },
  'network unroute':  { category: 'Network', description: 'Remove network interception', usage: 'network unroute <pattern>' },
  // Browser config
  'set viewport':    { category: 'Config', description: 'Set viewport size', usage: 'set viewport <width> <height>' },
  'set device':      { category: 'Config', description: 'Emulate device (e.g., iPhone 14)', usage: 'set device <name>' },
  'set geo':         { category: 'Config', description: 'Set geolocation', usage: 'set geo <lat> <lng>' },
  'set offline':     { category: 'Config', description: 'Toggle offline mode', usage: 'set offline [true|false]' },
  'set headers':     { category: 'Config', description: 'Set custom request headers', usage: 'set headers <name>:<value>' },
  'set credentials': { category: 'Config', description: 'Set HTTP auth credentials', usage: 'set credentials <user> <pass>' },
  'set media':       { category: 'Config', description: 'Set CSS media feature. Features: prefers-color-scheme (light/dark), prefers-reduced-motion (reduce/no-preference), forced-colors (active/none)', usage: 'set media <feature> <value>' },
  // Dialogs
  'dialog accept':  { category: 'Dialog', description: 'Accept next alert/confirm/prompt', usage: 'dialog accept [text]' },
  'dialog dismiss': { category: 'Dialog', description: 'Dismiss next dialog' },
  // Visual
  'screenshot':      { category: 'Visual', description: 'Save screenshot. --annotate overlays ref labels on interactive elements. --full captures entire scrollable page. Provide sel/@ref to crop to one element. Path defaults to /tmp/screenshot.png', usage: 'screenshot [--annotate] [--full] [sel] [path]' },
  'pdf':             { category: 'Visual', description: 'Save page as PDF', usage: 'pdf [path]' },
  'diff snapshot':   { category: 'Visual', description: 'Unified diff of current accessibility tree vs previous snapshot. Shows added/removed/changed elements. Run snapshot first, then act, then diff snapshot' },
  'diff screenshot': { category: 'Visual', description: 'Visual pixel diff between current screenshot and previous. Highlights changed regions' },
  'diff url':        { category: 'Visual', description: 'Diff text content between two URLs', usage: 'diff url <url1> <url2>' },
  // Snapshot
  'snapshot': { category: 'Snapshot', description: 'Full accessibility tree with @e refs for element selection. Without flags: returns complete DOM tree. Flags: -i (interactive elements only — buttons, links, inputs), -c (compact — omit empty structural nodes), -s <sel> (scope to CSS selector or @ref)', usage: 'snapshot [-i] [-c] [-s <sel>]' },
  // Tabs
  'tab':        { category: 'Tabs', description: 'List open tabs' },
  'tab new':    { category: 'Tabs', description: 'Open new tab', usage: 'tab new [url]' },
  'tab switch': { category: 'Tabs', description: 'Switch to tab', usage: 'tab switch <id>' },
  'tab close':  { category: 'Tabs', description: 'Close tab', usage: 'tab close [id]' },
  'window new': { category: 'Tabs', description: 'Open new browser window' },
  // Frames
  'frame':      { category: 'Frames', description: 'Switch to iframe', usage: 'frame <sel>' },
  'frame main': { category: 'Frames', description: 'Switch back to main frame' },
  // Semantic find
  'find role':        { category: 'Find', description: 'Find element by ARIA role (e.g., button, link, textbox, heading). Action: click, fill, hover, or omit to just locate', usage: 'find role <role> [action]' },
  'find text':        { category: 'Find', description: 'Find element by visible text content. Action: click, fill, hover, or omit to locate', usage: 'find text <text> [action]' },
  'find label':       { category: 'Find', description: 'Find element by associated label text. Action: click, fill, hover, or omit to locate', usage: 'find label <label> [action]' },
  'find placeholder': { category: 'Find', description: 'Find element by placeholder text. Action: click, fill, hover, or omit to locate', usage: 'find placeholder <text> [action]' },
  'find alt':         { category: 'Find', description: 'Find element by alt text. Action: click, fill, hover, or omit to locate', usage: 'find alt <text> [action]' },
  'find title':       { category: 'Find', description: 'Find element by title attribute. Action: click, fill, hover, or omit to locate', usage: 'find title <text> [action]' },
  'find testid':      { category: 'Find', description: 'Find element by data-testid. Action: click, fill, hover, or omit to locate', usage: 'find testid <id> [action]' },
  // Lifecycle
  'close':   { category: 'Lifecycle', description: 'Close browser session' },
  'connect': { category: 'Lifecycle', description: 'Connect to remote browser', usage: 'connect <url>' },
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
