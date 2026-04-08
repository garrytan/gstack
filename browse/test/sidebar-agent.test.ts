/**
 * Tests for sidebar agent queue parsing and inbox writing.
 *
 * sidebar-agent.ts functions are not exported (it's an entry-point script),
 * so we test the same logic inline: JSONL parsing, writeToInbox filesystem
 * behavior, and edge cases.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Helpers: replicate sidebar-agent logic for unit testing ──────

/** Parse a single JSONL line — same logic as sidebar-agent poll() */
function parseQueueLine(line: string): any | null {
  if (!line.trim()) return null;
  try {
    const entry = JSON.parse(line);
    if (!entry.message && !entry.prompt) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Read all valid entries from a JSONL string — same as countLines + readLine loop */
function parseQueueFile(content: string): any[] {
  const entries: any[] = [];
  const lines = content.split('\n').filter(Boolean);
  for (const line of lines) {
    const entry = parseQueueLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Write to inbox — extracted logic from sidebar-agent.ts writeToInbox() */
function writeToInbox(
  gitRoot: string,
  message: string,
  pageUrl?: string,
  sessionId?: string,
): string | null {
  if (!gitRoot) return null;

  const inboxDir = path.join(gitRoot, '.context', 'sidebar-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-');
  const filename = `${timestamp}-observation.json`;
  const tmpFile = path.join(inboxDir, `.${filename}.tmp`);
  const finalFile = path.join(inboxDir, filename);

  const inboxMessage = {
    type: 'observation',
    timestamp: now.toISOString(),
    page: { url: pageUrl || 'unknown', title: '' },
    userMessage: message,
    sidebarSessionId: sessionId || 'unknown',
  };

  fs.writeFileSync(tmpFile, JSON.stringify(inboxMessage, null, 2));
  fs.renameSync(tmpFile, finalFile);
  return finalFile;
}

/** Shorten paths — same logic as sidebar-agent.ts shorten() */
function shorten(str: string): string {
  return str
    .replace(/\/Users\/[^/]+/g, '~')
    .replace(/\/conductor\/workspaces\/[^/]+\/[^/]+/g, '')
    .replace(/\.claude\/skills\/gstack\//g, '')
    .replace(/browse\/dist\/browse/g, '$B');
}

/** describeToolCall — replicated from sidebar-agent.ts for unit testing */
function describeToolCall(tool: string, input: any): string {
  if (!input) return '';

  if (tool === 'Bash' && input.command) {
    const cmd = input.command;
    const browseMatch = cmd.match(/\$B\s+(\w+)|browse[^\s]*\s+(\w+)/);
    if (browseMatch) {
      const browseCmd = browseMatch[1] || browseMatch[2];
      const args = cmd.split(/\s+/).slice(2).join(' ');
      switch (browseCmd) {
        case 'goto': return `Opening ${args.replace(/['"]/g, '')}`;
        case 'snapshot': return args.includes('-i') ? 'Scanning for interactive elements' : args.includes('-D') ? 'Checking what changed' : 'Taking a snapshot of the page';
        case 'screenshot': return `Saving screenshot${args ? ` to ${shorten(args)}` : ''}`;
        case 'click': return `Clicking ${args}`;
        case 'fill': { const parts = args.split(/\s+/); return `Typing "${parts.slice(1).join(' ')}" into ${parts[0]}`; }
        case 'text': return 'Reading page text';
        case 'html': return args ? `Reading HTML of ${args}` : 'Reading full page HTML';
        case 'links': return 'Finding all links on the page';
        case 'forms': return 'Looking for forms';
        case 'console': return 'Checking browser console for errors';
        case 'network': return 'Checking network requests';
        case 'url': return 'Checking current URL';
        case 'back': return 'Going back';
        case 'forward': return 'Going forward';
        case 'reload': return 'Reloading the page';
        case 'scroll': return args ? `Scrolling to ${args}` : 'Scrolling down';
        case 'wait': return `Waiting for ${args}`;
        case 'inspect': return args ? `Inspecting CSS of ${args}` : 'Getting CSS for last picked element';
        case 'style': return `Changing CSS: ${args}`;
        case 'cleanup': return 'Removing page clutter (ads, popups, banners)';
        case 'prettyscreenshot': return 'Taking a clean screenshot';
        case 'css': return `Checking CSS property: ${args}`;
        case 'is': return `Checking if element is ${args}`;
        case 'diff': return `Comparing ${args}`;
        case 'responsive': return 'Taking screenshots at mobile, tablet, and desktop sizes';
        case 'status': return 'Checking browser status';
        case 'tabs': return 'Listing open tabs';
        case 'focus': return 'Bringing browser to front';
        case 'select': return `Selecting option in ${args}`;
        case 'hover': return `Hovering over ${args}`;
        case 'viewport': return `Setting viewport to ${args}`;
        case 'upload': return `Uploading file to ${args.split(/\s+/)[0]}`;
        default: return `Running browse ${browseCmd} ${args}`.trim();
      }
    }
    if (cmd.includes('git ')) return `Running: ${shorten(cmd)}`;
    let short = shorten(cmd);
    return short.length > 100 ? short.slice(0, 100) + '…' : short;
  }

  if (tool === 'Read' && input.file_path) return `Reading ${shorten(input.file_path)}`;
  if (tool === 'Edit' && input.file_path) return `Editing ${shorten(input.file_path)}`;
  if (tool === 'Write' && input.file_path) return `Writing ${shorten(input.file_path)}`;
  if (tool === 'Grep' && input.pattern) return `Searching for "${input.pattern}"`;
  if (tool === 'Glob' && input.pattern) return `Finding files matching ${input.pattern}`;
  try { return shorten(JSON.stringify(input)).slice(0, 80); } catch { return ''; }
}

// ─── Test setup ──────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-agent-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Queue File Parsing ─────────────────────────────────────────

describe('queue file parsing', () => {
  test('valid JSONL line parsed correctly', () => {
    const line = JSON.stringify({ message: 'hello', prompt: 'check this', pageUrl: 'https://example.com' });
    const entry = parseQueueLine(line);
    expect(entry).not.toBeNull();
    expect(entry.message).toBe('hello');
    expect(entry.prompt).toBe('check this');
    expect(entry.pageUrl).toBe('https://example.com');
  });

  test('malformed JSON line skipped without crash', () => {
    const entry = parseQueueLine('this is not json {{{');
    expect(entry).toBeNull();
  });

  test('valid JSON without message or prompt is skipped', () => {
    const line = JSON.stringify({ foo: 'bar' });
    const entry = parseQueueLine(line);
    expect(entry).toBeNull();
  });

  test('empty file returns no entries', () => {
    const entries = parseQueueFile('');
    expect(entries).toEqual([]);
  });

  test('file with blank lines returns no entries', () => {
    const entries = parseQueueFile('\n\n\n');
    expect(entries).toEqual([]);
  });

  test('mixed valid and invalid lines', () => {
    const content = [
      JSON.stringify({ message: 'first' }),
      'not json',
      JSON.stringify({ unrelated: true }),
      JSON.stringify({ message: 'second', prompt: 'do stuff' }),
    ].join('\n');

    const entries = parseQueueFile(content);
    expect(entries.length).toBe(2);
    expect(entries[0].message).toBe('first');
    expect(entries[1].message).toBe('second');
  });
});

// ─── writeToInbox ────────────────────────────────────────────────

describe('writeToInbox', () => {
  test('creates .context/sidebar-inbox/ directory', () => {
    writeToInbox(tmpDir, 'test message');
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    expect(fs.existsSync(inboxDir)).toBe(true);
    expect(fs.statSync(inboxDir).isDirectory()).toBe(true);
  });

  test('writes valid JSON file', () => {
    const filePath = writeToInbox(tmpDir, 'test message', 'https://example.com', 'session-123');
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(filePath!)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath!, 'utf-8'));
    expect(data.type).toBe('observation');
    expect(data.userMessage).toBe('test message');
    expect(data.page.url).toBe('https://example.com');
    expect(data.sidebarSessionId).toBe('session-123');
    expect(data.timestamp).toBeTruthy();
  });

  test('atomic write — final file exists, no .tmp left', () => {
    const filePath = writeToInbox(tmpDir, 'atomic test');
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(filePath!)).toBe(true);

    // Check no .tmp files remain in the inbox directory
    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    const files = fs.readdirSync(inboxDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles.length).toBe(0);

    // Final file should end with -observation.json
    const jsonFiles = files.filter(f => f.endsWith('-observation.json') && !f.startsWith('.'));
    expect(jsonFiles.length).toBe(1);
  });

  test('handles missing git root gracefully', () => {
    const result = writeToInbox('', 'test');
    expect(result).toBeNull();
  });

  test('defaults pageUrl to unknown when not provided', () => {
    const filePath = writeToInbox(tmpDir, 'no url provided');
    expect(filePath).not.toBeNull();
    const data = JSON.parse(fs.readFileSync(filePath!, 'utf-8'));
    expect(data.page.url).toBe('unknown');
  });

  test('defaults sessionId to unknown when not provided', () => {
    const filePath = writeToInbox(tmpDir, 'no session');
    expect(filePath).not.toBeNull();
    const data = JSON.parse(fs.readFileSync(filePath!, 'utf-8'));
    expect(data.sidebarSessionId).toBe('unknown');
  });

  test('multiple writes create separate files', () => {
    writeToInbox(tmpDir, 'message 1');
    // Tiny delay to ensure different timestamps
    const t = Date.now();
    while (Date.now() === t) {} // spin until next ms
    writeToInbox(tmpDir, 'message 2');

    const inboxDir = path.join(tmpDir, '.context', 'sidebar-inbox');
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    expect(files.length).toBe(2);
  });
});

// ─── describeToolCall (verbose narration) ────────────────────────

describe('describeToolCall', () => {
  // Browse navigation commands
  test('goto → plain English with URL', () => {
    const result = describeToolCall('Bash', { command: '$B goto https://example.com' });
    expect(result).toBe('Opening https://example.com');
  });

  test('goto strips quotes from URL', () => {
    const result = describeToolCall('Bash', { command: '$B goto "https://example.com"' });
    expect(result).toBe('Opening https://example.com');
  });

  test('url → checking current URL', () => {
    expect(describeToolCall('Bash', { command: '$B url' })).toBe('Checking current URL');
  });

  test('back/forward/reload → plain English', () => {
    expect(describeToolCall('Bash', { command: '$B back' })).toBe('Going back');
    expect(describeToolCall('Bash', { command: '$B forward' })).toBe('Going forward');
    expect(describeToolCall('Bash', { command: '$B reload' })).toBe('Reloading the page');
  });

  // Snapshot variants
  test('snapshot -i → scanning for interactive elements', () => {
    expect(describeToolCall('Bash', { command: '$B snapshot -i' })).toBe('Scanning for interactive elements');
  });

  test('snapshot -D → checking what changed', () => {
    expect(describeToolCall('Bash', { command: '$B snapshot -D' })).toBe('Checking what changed');
  });

  test('snapshot (plain) → taking a snapshot', () => {
    expect(describeToolCall('Bash', { command: '$B snapshot' })).toBe('Taking a snapshot of the page');
  });

  // Interaction commands
  test('click → clicking element', () => {
    expect(describeToolCall('Bash', { command: '$B click @e3' })).toBe('Clicking @e3');
  });

  test('fill → typing into element', () => {
    expect(describeToolCall('Bash', { command: '$B fill @e4 "hello world"' })).toBe('Typing ""hello world"" into @e4');
  });

  test('scroll with selector → scrolling to element', () => {
    expect(describeToolCall('Bash', { command: '$B scroll .footer' })).toBe('Scrolling to .footer');
  });

  test('scroll without args → scrolling down', () => {
    expect(describeToolCall('Bash', { command: '$B scroll' })).toBe('Scrolling down');
  });

  // Reading commands
  test('text → reading page text', () => {
    expect(describeToolCall('Bash', { command: '$B text' })).toBe('Reading page text');
  });

  test('html with selector → reading HTML of element', () => {
    expect(describeToolCall('Bash', { command: '$B html .header' })).toBe('Reading HTML of .header');
  });

  test('html without selector → reading full page HTML', () => {
    expect(describeToolCall('Bash', { command: '$B html' })).toBe('Reading full page HTML');
  });

  test('links → finding all links', () => {
    expect(describeToolCall('Bash', { command: '$B links' })).toBe('Finding all links on the page');
  });

  test('console → checking console', () => {
    expect(describeToolCall('Bash', { command: '$B console' })).toBe('Checking browser console for errors');
  });

  // Inspector commands
  test('inspect with selector → inspecting CSS', () => {
    expect(describeToolCall('Bash', { command: '$B inspect .header' })).toBe('Inspecting CSS of .header');
  });

  test('inspect without args → getting last picked element', () => {
    expect(describeToolCall('Bash', { command: '$B inspect' })).toBe('Getting CSS for last picked element');
  });

  test('style → changing CSS', () => {
    expect(describeToolCall('Bash', { command: '$B style .header color red' })).toBe('Changing CSS: .header color red');
  });

  test('cleanup → removing page clutter', () => {
    expect(describeToolCall('Bash', { command: '$B cleanup --all' })).toBe('Removing page clutter (ads, popups, banners)');
  });

  // Visual commands
  test('screenshot → saving screenshot', () => {
    expect(describeToolCall('Bash', { command: '$B screenshot /tmp/shot.png' })).toBe('Saving screenshot to /tmp/shot.png');
  });

  test('screenshot without path', () => {
    expect(describeToolCall('Bash', { command: '$B screenshot' })).toBe('Saving screenshot');
  });

  test('responsive → multi-size screenshots', () => {
    expect(describeToolCall('Bash', { command: '$B responsive' })).toBe('Taking screenshots at mobile, tablet, and desktop sizes');
  });

  // Non-browse tools
  test('Read tool → reading file', () => {
    expect(describeToolCall('Read', { file_path: '/Users/foo/project/src/app.ts' })).toBe('Reading ~/project/src/app.ts');
  });

  test('Grep tool → searching for pattern', () => {
    expect(describeToolCall('Grep', { pattern: 'handleClick' })).toBe('Searching for "handleClick"');
  });

  test('Glob tool → finding files', () => {
    expect(describeToolCall('Glob', { pattern: '**/*.tsx' })).toBe('Finding files matching **/*.tsx');
  });

  test('Edit tool → editing file', () => {
    expect(describeToolCall('Edit', { file_path: '/Users/foo/src/main.ts' })).toBe('Editing ~/src/main.ts');
  });

  // Edge cases
  test('null input → empty string', () => {
    expect(describeToolCall('Bash', null)).toBe('');
  });

  test('unknown browse command → generic description', () => {
    expect(describeToolCall('Bash', { command: '$B newtab https://foo.com' })).toContain('newtab');
  });

  test('non-browse bash → shortened command', () => {
    expect(describeToolCall('Bash', { command: 'echo hello' })).toBe('echo hello');
  });

  test('full browse binary path recognized', () => {
    const result = describeToolCall('Bash', { command: '/Users/garrytan/.claude/skills/gstack/browse/dist/browse goto https://example.com' });
    expect(result).toBe('Opening https://example.com');
  });

  test('tab command → switching tab', () => {
    expect(describeToolCall('Bash', { command: '$B tab 2' })).toContain('tab');
  });
});

// ─── Per-tab agent concurrency (source code validation) ──────────

describe('per-tab agent concurrency', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.ts'), 'utf-8');
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebar-agent.ts'), 'utf-8');

  test('server has per-tab agent state map', () => {
    expect(serverSrc).toContain('tabAgents');
    expect(serverSrc).toContain('TabAgentState');
    expect(serverSrc).toContain('getTabAgent');
  });

  test('server returns per-tab agent status in /sidebar-chat', () => {
    expect(serverSrc).toContain('getTabAgentStatus');
    expect(serverSrc).toContain('tabAgentStatus');
  });

  test('spawnClaude accepts forTabId parameter', () => {
    const spawnFn = serverSrc.slice(
      serverSrc.indexOf('function spawnClaude('),
      serverSrc.indexOf('\nfunction ', serverSrc.indexOf('function spawnClaude(') + 1),
    );
    expect(spawnFn).toContain('forTabId');
    expect(spawnFn).toContain('tabState.status');
  });

  test('sidebar-command endpoint uses per-tab agent state', () => {
    expect(serverSrc).toContain('msgTabId');
    expect(serverSrc).toContain('tabState.status');
    expect(serverSrc).toContain('tabState.queue');
  });

  test('agent event handler resets per-tab state', () => {
    expect(serverSrc).toContain('eventTabId');
    expect(serverSrc).toContain('tabState.status = \'idle\'');
  });

  test('agent event handler processes per-tab queue', () => {
    // After agent_done, should process next message from THIS tab's queue
    expect(serverSrc).toContain('tabState.queue.length > 0');
    expect(serverSrc).toContain('tabState.queue.shift');
  });

  test('sidebar-agent uses per-tab processing set', () => {
    expect(agentSrc).toContain('processingTabs');
    expect(agentSrc).not.toContain('isProcessing');
  });

  test('sidebar-agent sends tabId with all events', () => {
    // sendEvent should accept tabId parameter
    expect(agentSrc).toContain('async function sendEvent(event: Record<string, any>, tabId?: number)');
    // askClaude should extract tabId from queue entry
    expect(agentSrc).toContain('const { prompt, args, stateFile, cwd, tabId }');
  });

  test('sidebar-agent allows concurrent agents across tabs', () => {
    // poll() should not block globally — it should check per-tab
    expect(agentSrc).toContain('processingTabs.has(tid)');
    // askClaude should be fire-and-forget (no await blocking the loop)
    expect(agentSrc).toContain('askClaude(entry).catch');
  });

  test('queue entries include tabId', () => {
    const spawnFn = serverSrc.slice(
      serverSrc.indexOf('function spawnClaude('),
      serverSrc.indexOf('\nfunction ', serverSrc.indexOf('function spawnClaude(') + 1),
    );
    expect(spawnFn).toContain('tabId: agentTabId');
  });

  test('health check monitors all per-tab agents', () => {
    expect(serverSrc).toContain('for (const [tid, state] of tabAgents)');
  });
});

describe('BROWSE_TAB tab pinning (cross-tab isolation)', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.ts'), 'utf-8');
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebar-agent.ts'), 'utf-8');
  const cliSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf-8');

  test('sidebar-agent passes BROWSE_TAB env var to claude process', () => {
    // The env block should include BROWSE_TAB set to the tab ID
    expect(agentSrc).toContain('BROWSE_TAB');
    expect(agentSrc).toContain('String(tid)');
  });

  test('CLI reads BROWSE_TAB and sends tabId in command body', () => {
    expect(cliSrc).toContain('process.env.BROWSE_TAB');
    expect(cliSrc).toContain('tabId: parseInt(browseTab');
  });

  test('handleCommandInternal accepts tabId from request body', () => {
    const handleFn = serverSrc.slice(
      serverSrc.indexOf('async function handleCommandInternal('),
      serverSrc.indexOf('\n/** HTTP wrapper', serverSrc.indexOf('async function handleCommandInternal(') + 1) > 0
        ? serverSrc.indexOf('\n/** HTTP wrapper', serverSrc.indexOf('async function handleCommandInternal(') + 1)
        : serverSrc.indexOf('\nasync function ', serverSrc.indexOf('async function handleCommandInternal(') + 200),
    );
    // Should destructure tabId from body
    expect(handleFn).toContain('tabId');
    // Should save and restore the active tab
    expect(handleFn).toContain('savedTabId');
    expect(handleFn).toContain('switchTab(tabId');
  });

  test('handleCommandInternal restores active tab after command (success path)', () => {
    // On success, should restore savedTabId without stealing focus
    const handleFn = serverSrc.slice(
      serverSrc.indexOf('async function handleCommandInternal('),
      serverSrc.length,
    );
    // Count restore calls — should appear in both success and error paths
    const restoreCount = (handleFn.match(/switchTab\(savedTabId/g) || []).length;
    expect(restoreCount).toBeGreaterThanOrEqual(2); // success + error paths
  });

  test('handleCommandInternal restores active tab on error path', () => {
    // The catch block should also restore
    const catchBlock = serverSrc.slice(
      serverSrc.indexOf('} catch (err: any) {', serverSrc.indexOf('async function handleCommandInternal(')),
    );
    expect(catchBlock).toContain('switchTab(savedTabId');
  });

  test('tab pinning only activates when tabId is provided', () => {
    const handleFn = serverSrc.slice(
      serverSrc.indexOf('async function handleCommandInternal('),
      serverSrc.indexOf('try {', serverSrc.indexOf('async function handleCommandInternal(') + 1),
    );
    // Should check tabId is not undefined/null before switching
    expect(handleFn).toContain('tabId !== undefined');
    expect(handleFn).toContain('tabId !== null');
  });

  test('CLI only sends tabId when BROWSE_TAB is set', () => {
    // Should conditionally include tabId in the body
    expect(cliSrc).toContain('browseTab ? { tabId:');
  });
});
