/** One-time input for a cropped native Edit of an already-owned review artifact. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { validAutoplanEditDigest, readAutoplanDigestFile, matchesAutoplanDigestRows, createAutoplanEditDigest, autoplanEditLineHash } from './autoplan-artifact-digest';
import type { PendingAutoplanArtifact } from './autoplan-artifact-recorder';
import type { NativePublicToolEvent } from './plan-count-transcript';

interface ArtifactPermissionContext {
  cwd: string;
  /** Set only by the launcher that created HOME/.gstack, never from ambient env. */
  ownedStateRoot?: string;
  /** Optional native plans root supplied by the same isolated launcher. */
  ownedNativePlansRoot?: string;
  commandStartedAt: number;
  now?: number;
  transcriptStatus: string;
  publicTools: NativePublicToolEvent[];
}

const MAX_BYTES = 1024 * 1024;
const compact = (text: string) => text.replace(/\s/g, '');

/** A completed write distinguishes a new same-looking file confirmation. */
export function autoplanPermissionProgressKey(viewport: string, events: readonly NativePublicToolEvent[]): string | undefined {
  const file = /^ {0,3}Do you want to (?:create|overwrite|edit) ([^\n?]+)\? *$/m.exec(viewport)?.[1];
  if (!file || new Set(events.map(event => event.sessionId)).size !== 1) return;
  const menu = compact(viewport);
  for (let i = events.length - 1; i >= 0; i--) {
    const result = events[i]!;
    if (result.kind !== 'result' || result.isError !== false) continue;
    const uses = events.slice(0, i).filter(event => event.kind === 'use' &&
      event.sessionId === result.sessionId && event.toolUseId === result.toolUseId);
    if (uses.length !== 1) continue;
    const use = uses[0]!, target = use.input?.file_path;
    if (!['Write', 'Edit'].includes(use.name ?? '') || typeof target !== 'string' ||
        !path.isAbsolute(target) || path.basename(target) !== file ||
        !menu.includes(`alwaysallowaccessto${compact(path.dirname(target))}forthissession`) ||
        !Number.isFinite(Date.parse(use.timestamp)) || Date.parse(result.timestamp) < Date.parse(use.timestamp) ||
        !Number.isFinite(Date.parse(result.timestamp))) continue;
    return `${result.sessionId}:${result.toolUseId}`;
  }
}

/** The native header may remain above the diff; both displayed paths must bind. */
function ownedEditDiffRows(rows: string[], file: string, ownedStateRoot?: string): string[] | null {
  const header = rows.findIndex(row => /^[●⏺] Update\(/.test(row));
  if (header > 0 && rows.slice(0,header).some(row => row.trim())) {
    // A completed native tool's diff may remain above the active edit panel.
    // Only its indented diff output is ignored; competing panels or prose are
    // not evidence for the current request and cannot be used as a prefix.
    const prefix = rows.slice(0, header), fullRow = /^ {6}([1-9]\d*) ([+ -])/;
    const first = prefix.map(row => fullRow.exec(row)).find(Boolean);
    if (!first) return null;
    const markerColumn = 6 + first[1]!.length + 1;
    let kind: string | undefined;
    for (const row of prefix) {
      if (!row.trim()) continue;
      const full = fullRow.exec(row);
      if (full) {
        if (!Number.isSafeInteger(Number(full[1])) || 6 + full[1]!.length + 1 !== markerColumn) return null;
        kind = full[2];
      } else {
        const wrappedKind = row[markerColumn];
        if (!row.startsWith(' '.repeat(markerColumn)) || !['+', ' ', '-'].includes(wrappedKind ?? '') ||
            (kind !== undefined && wrappedKind !== kind)) return null;
        kind = wrappedKind;
      }
    }
    rows = rows.slice(header);
  }
  // A redraw can repeat the same native tool title above one current panel.
  // Those homogeneous titles supply no authority: the full panel below must
  // still bind its path, current request, content, and exact one-time menu.
  const repeated: string[] = [];
  let panelAt = 0;
  for (; panelAt < rows.length; panelAt++) {
    if (!rows[panelAt]!.trim()) continue;
    const title = /^[●⏺] Update\(([^\n]+)\)$/.exec(rows[panelAt]!);
    if (!title) break;
    repeated.push(title[1]!);
  }
  if (repeated.length > 1 && ownedStateRoot && /^[─╌]{8,}$/.test(rows[panelAt] ?? '') &&
      rows[panelAt + 1]?.trim() === 'Edit file') {
    const relative = path.relative(ownedStateRoot, file).split(path.sep).join('/');
    const alias = path.basename(ownedStateRoot) === '.gstack' ? `~/.gstack/${relative}` : undefined;
    if (repeated.some(title => title !== repeated[0]) || (repeated[0] !== file && repeated[0] !== alias)) return null;
    rows = rows.slice(panelAt);
  }
  if (rows.filter(row => /^[●⏺] Update\(/.test(row)).length > 1) return null;
  // A viewport can start at the native Edit panel after its tool title has
  // scrolled away. The remaining displayed path must still bind the complete
  // owned project/artifact path; the menu and current request are checked below.
  if (/^[─╌]{8,}$/.test(rows[0] ?? '') && rows[1]?.trim() === 'Edit file') {
    if (!ownedStateRoot || !/^[─╌]{8,}$/.test(rows[3] ?? '')) return null;
    const relative = path.relative(ownedStateRoot, file).split(path.sep).join('/');
    const alias = path.basename(ownedStateRoot) === '.gstack' ? `~/.gstack/${relative}` : undefined;
    const displayed = rows[2]?.trim() ?? '';
    if (displayed !== file && displayed !== alias) {
      const suffix = displayed.startsWith('…') ? displayed.slice(1) : '';
      if ((suffix !== relative && !suffix.endsWith('/' + relative)) || !file.endsWith(suffix)) return null;
    }
    return rows.slice(4);
  }
  const update = /^[●⏺] Update\(([^\n]+)\)$/.exec(rows[0] ?? '');
  if (!update) return rows; // Existing cropped-only row guards still apply.
  if (!ownedStateRoot || rows[1]?.trim() !== '' || !/^[─╌]{8,}$/.test(rows[2] ?? '') ||
      rows[3]?.trim() !== 'Edit file' || !/^[─╌]{8,}$/.test(rows[5] ?? '')) return null;
  const relative = path.relative(ownedStateRoot,file).split(path.sep).join('/');
  const alias = path.basename(ownedStateRoot) === '.gstack' ? `~/.gstack/${relative}` : undefined;
  if (update[1] !== file && update[1] !== alias) return null;
  const displayed = rows[4]?.trim() ?? '';
  if (displayed !== file && displayed !== alias) {
    const suffix = displayed.startsWith('…') ? displayed.slice(1) : '';
    // A truncated prefix must still retain the complete owned project/artifact
    // path. A basename or sibling-project suffix cannot bind this request.
    if ((suffix !== relative && !suffix.endsWith('/'+relative)) || !file.endsWith(suffix)) return null;
  }
  return rows.slice(6);
}

export function ownedAutoplanArtifact(file: string, context: Pick<ArtifactPermissionContext, 'cwd' | 'ownedStateRoot'>): boolean {
  if (!context.ownedStateRoot || !path.isAbsolute(file) || path.resolve(file) !== file) return false;
  const project = path.join(context.ownedStateRoot, 'projects', path.basename(context.cwd));
  const relative = path.relative(project, file).split(path.sep).join('/');
  // Current CEO plan and both explicit Eng test-plan layouts. Design/DX amend
  // ACTIVE_PLAN; they have no separate state-root plan directory. Do not admit
  // restore points, methodology snapshots, task logs, config, or mockups.
  if (!/^ceo-plans\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/.test(relative) &&
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*-test-plan-\d{8}-\d{6}\.md$/.test(relative)) return false;
  try {
    // System temp parents may be aliases (/var -> /private/var on macOS).
    // Canonicalize above the owned root; no symlink at or below it is admitted.
    const expected = path.join(fs.realpathSync(context.ownedStateRoot), path.relative(context.ownedStateRoot, file));
    return fs.lstatSync(context.ownedStateRoot).isDirectory() &&
      fs.realpathSync(file) === expected && fs.lstatSync(file).isFile() && fs.statSync(file).size <= MAX_BYTES;
  } catch { return false; }
}

/** Require the whole current cropped diff, exact menu, and requested edit text. */
function matchesCroppedEdit(viewport: string, file: string, before: string, removed: string, after: string,
  ownedStateRoot?: string): boolean {
  if (viewport.length > MAX_BYTES) return false;
  const text = viewport.replace(/\r\n?/g, '\n');
  const menu = /^ {0,3}Do you want to make this edit to ([^\n?]+)\? *\n {0,3}❯ *1\. Yes *\n {0,3}2\. Yes, and switch to accept edits \(auto-approve file edits and common file commands\) for this session(?: \(shift\+tab\))? *\n {0,3}3\. No *\n\s*Esc to cancel [·•] Tab to amend\s*$/m.exec(text);
  if (!menu || menu.index + menu[0].length !== text.length || menu[1] !== path.basename(file)) return false;
  const rows = text.slice(0, menu.index).trimEnd().split('\n');
  if (!/^[╌─]{8,}$/.test(rows.pop() ?? '')) return false;
  const diffRows = ownedEditDiffRows(rows,file,ownedStateRoot);
  if (!diffRows) return false;
  const chunks: Array<{ kind: string; text: string }> = [];
  let markerColumn: number | undefined;
  for (const row of diffRows) {
    const numbered = /^( {0,3})([1-9]\d*) ([+ -])(.*)$/.exec(row);
    if (numbered) {
      const line = Number(numbered[2]), column = numbered[1]!.length + numbered[2]!.length + 1;
      // Match the digest parser: every row owns one marker column, regardless
      // of line-number width; continuations retain that column and diff kind.
      if (!Number.isSafeInteger(line) || (markerColumn !== undefined && markerColumn !== column)) return false;
      markerColumn = column;
      chunks.push({ kind: numbered[3]!, text: numbered[4]! });
    } else {
      const last = chunks.at(-1);
      if (markerColumn === undefined || !row.startsWith(' '.repeat(markerColumn)) ||
          !last || row[markerColumn] !== last.kind) return false;
      last.text += row.slice(markerColumn + 1);
    }
  }
  // The crop itself cannot contain an example introduction, quote, unrelated
  // prompt, or arbitrary diff: each row must occur in this exact pending edit.
  const originals = before.split('\n').map(compact);
  const deletions = removed.split('\n').map(compact);
  const replacements = after.split('\n').map(compact);
  const changed = chunks.some(chunk => chunk.kind !== ' ' && compact(chunk.text));
  const matches = (oldRows: string[], newRows: string[]) => chunks.every(chunk =>
    (chunk.kind === '+' ? newRows : chunk.kind === '-' ? oldRows : originals).includes(compact(chunk.text)));
  if (changed && matches(deletions, replacements)) return true;
  // Edit arguments can start or end inside a line while the native preview
  // displays the whole line. Reconstruct only those unchanged edge bytes
  // from the unique current old substring; no viewport text supplies them.
  const at = before.indexOf(removed), end = at + removed.length;
  if (!changed || !removed || at < 0 || at !== before.lastIndexOf(removed) || after.length > MAX_BYTES) return false;
  const prefix = before.slice(before.slice(0, at).lastIndexOf('\n') + 1, at);
  const newline = before.indexOf('\n', end);
  const suffix = before.slice(end, newline < 0 ? before.length : newline);
  if (!prefix && !suffix) return false;
  const oldRows = (prefix + removed + suffix).split('\n').map(compact);
  const newRows = (prefix + after + suffix).split('\n').map(compact);
  return matches(oldRows, newRows) && chunks.some(chunk =>
    chunk.kind === '+' ? !oldRows.includes(compact(chunk.text)) :
    chunk.kind === '-' && !newRows.includes(compact(chunk.text)));
}

export function autoplanArtifactPermissionInput(
  viewport: string, context: ArtifactPermissionContext, seen: ReadonlySet<string>,
): { input: '1\r'; signature: string; file: string } | null {
  const now = context.now ?? Date.now();
  if (context.transcriptStatus !== 'ready' || !Number.isFinite(context.commandStartedAt) ||
      context.commandStartedAt > now || context.publicTools.length > 10_000 ||
      context.publicTools.some(event => !Number.isFinite(Date.parse(event.timestamp)))) return null;
  const events = context.publicTools.filter(event => Date.parse(event.timestamp) >= context.commandStartedAt);
  if (!events.length || events.some(event => !event.sessionId || !event.toolUseId ||
      !Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp) > now) ||
      new Set(events.map(event => event.sessionId)).size !== 1) return null;
  // Bind the latest file mutation, which must be the sole unresolved Write/Edit.
  // Claude may publish a queued Bash while its current Edit permission is open;
  // that unrelated request supplies no file permission authority.
  const edit = events.filter(event => event.kind === 'use' &&
    (event.name === 'Write' || event.name === 'Edit')).at(-1);
  if (!edit || edit.kind !== 'use' || edit.name !== 'Edit' || typeof edit.input?.file_path !== 'string' ||
      typeof edit.input.old_string !== 'string' || !edit.input.old_string ||
      typeof edit.input.new_string !== 'string' || edit.input.new_string === edit.input.old_string ||
      (edit.input.replace_all !== undefined && edit.input.replace_all !== false)) return null;
  const signature = `${edit.sessionId}:${edit.toolUseId}`;
  if (seen.has(signature) || !ownedAutoplanArtifact(edit.input.file_path, context)) return null;
  const uses = new Map<string, NativePublicToolEvent>();
  const results = new Map<string, NativePublicToolEvent>();
  let previousTime = context.commandStartedAt;
  for (const event of events) {
    const time = Date.parse(event.timestamp);
    if (time < previousTime) return null;
    previousTime = time;
    const map = event.kind === 'use' ? uses : results;
    if (map.has(event.toolUseId)) return null;
    map.set(event.toolUseId, event);
    if (event.kind === 'result' && !uses.has(event.toolUseId)) return null;
  }
  const writes = [...uses.values()].filter(event => event.name === 'Write' || event.name === 'Edit');
  if (results.has(edit.toolUseId) || writes.filter(event => !results.has(event.toolUseId)).length !== 1) return null;
  if (!writes.some(event => event.toolUseId !== edit.toolUseId &&
      event.input?.file_path === edit.input!.file_path && results.has(event.toolUseId) &&
      results.get(event.toolUseId)!.isError === false)) return null;
  try {
    const before = fs.readFileSync(edit.input.file_path, 'utf8');
    if (!before.includes(edit.input.old_string) ||
        !matchesCroppedEdit(viewport, edit.input.file_path, before, edit.input.old_string, edit.input.new_string,
          context.ownedStateRoot)) return null;
    return { input: '1\r', signature, file: edit.input.file_path };
  } catch { return null; }
}

/** A previously granted viewport cannot establish a newer unpublished request. */
export const autoplanArtifactMenuKey = (viewport: string) =>
  `menu:${createHash('sha256').update(viewport.replace(/\r\n?/g, '\n')).digest('hex')}`;

/** Queued native-plan edits remain unstarted; this never grants their input. */
function ownedQueuedNativePlan(file: unknown, root: string | undefined, pendingTime: number): file is string {
  if (!root || typeof file !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root ||
      !path.isAbsolute(file) || path.resolve(file) !== file || path.dirname(file) !== root ||
      !/^[a-z][a-z0-9-]*\.md$/.test(path.basename(file))) return false;
  try {
    return fs.lstatSync(root).isDirectory() && fs.lstatSync(file).isFile() &&
      fs.realpathSync(file) === path.join(fs.realpathSync(root), path.basename(file)) && fs.statSync(file).size <= MAX_BYTES &&
      Math.floor(fs.statSync(file).mtimeMs) <= pendingTime;
  } catch { return false; }
}

/** Bind completed snapshot output and queued native-plan redraw labels before
 * the full current panel. Arbitrary prose, examples and competing panels stay. */
function queuedPlanViewport(viewport: string, queuedPlans: number, current: NativePublicToolEvent,
  events: NativePublicToolEvent[]): string {
  if (!queuedPlans) return viewport;
  const lines = viewport.replace(/\r\n?/g, '\n').split('\n');
  const title = lines.findIndex(line => /^[●⏺] Update\(/.test(line));
  if (title < 0 || lines.filter(line => /^[●⏺] Update\(/.test(line)).length !== 1) return viewport;
  const panel = lines.findIndex((line, i) => i > title && /^[─╌]{8,}$/.test(line));
  const redraws = lines.slice(title + 1, panel).filter(line => line.trim());
  if (panel < 0 || redraws.length !== queuedPlans || redraws.some(line => !/^[●⏺] Updated plan$/.test(line))) return viewport;
  const prefix = lines.slice(0, title);
  while (prefix.at(-1)?.trim() === '') prefix.pop();
  if (prefix.some(line => line.trim())) {
    const prior = events.slice(0, events.indexOf(current));
    const result = prior.filter(event => event.kind === 'result').at(-1);
    const use = result && prior.find(event => event.kind === 'use' && event.toolUseId === result.toolUseId);
    const command = /^ {8}"([^"\n]+)…\)$/.exec(prefix[0] ?? '');
    const outputEnd = prefix.length - 2;
    if (!command || !use || use.name !== 'Bash' || use.messageId !== current.messageId ||
        use.requestId !== current.requestId || typeof use.input?.command !== 'string' ||
        !use.input.command.includes(command[1]!) || result?.isError !== false || typeof result.content !== 'string' ||
        !/^ {2}⎿[ \u00a0]+\{$/.test(prefix[1] ?? '') ||
        !/^ {5}… \+[1-9]\d* lines \(ctrl\+o to expand\)$/.test(prefix[outputEnd] ?? '') ||
        !/^ {2}⎿[ \u00a0]+Allowed by auto mode classifier$/.test(prefix.at(-1) ?? '') || outputEnd < 3) return viewport;
    const displayed = ['{', ...prefix.slice(2, outputEnd).map(line => /^ {5}( {2}\S.*)$/.exec(line)?.[1])];
    if (displayed.some(line => line === undefined) ||
        result.content.split('\n').slice(0, displayed.length).join('\n') !== displayed.join('\n')) return viewport;
  }
  return [lines[title], '', ...lines.slice(panel)].join('\n');
}

/** Native batch redraws are display-only: bind their titles, waiting command,
 * and one clipped context row to public events before removing the prefix. */
function queuedArtifactViewport(viewport: string, current: NativePublicToolEvent,
  events: NativePublicToolEvent[], queued: ReadonlySet<string>, file: string,
  pendingTime: number, ownedStateRoot?: string): string {
  if (!queued.size || !ownedStateRoot) return viewport;
  const successors = events.filter(e => e.kind === 'use' && queued.has(e.toolUseId));
  if (successors.some(e => e.input?.file_path !== file)) return viewport;
  const lines = viewport.replace(/\r\n?/g, '\n').split('\n');
  const firstTitle = lines.findIndex(line => /^[●⏺] Update\(/.test(line));
  const panel = lines.findIndex((line, i) => i > firstTitle && /^[─╌]{8,}$/.test(line));
  if (firstTitle < 1 || panel < 0) return viewport;
  const prefix = lines.slice(0, firstTitle).filter(line => line.trim());
  const clipped = prefix.length === 1 && /^ {10}(\S.{15,})$/.exec(prefix[0]!);
  if (!clipped) return viewport;
  const relative = path.relative(ownedStateRoot, file).split(path.sep).join('/');
  const alias = path.basename(ownedStateRoot) === '.gstack' ? `~/.gstack/${relative}` : undefined;
  const rows = lines.slice(firstTitle, panel).filter(line => line.trim());
  const titles = rows.slice(0, successors.length + 1);
  if (titles.length !== successors.length + 1 || titles.some(row => {
    const title = /^[●⏺] Update\(([^\n]+)\)$/.exec(row);
    return !title || (title[1] !== file && title[1] !== alias);
  })) return viewport;
  const bash = rows.slice(titles.length);
  if (bash.length < 2 || !/^ {2}⎿[ \u00a0]+Waiting…$/.test(bash.at(-1)!)) return viewport;
  const parts = bash.slice(0, -1).map((row, i) =>
    (i === 0 ? /^[●⏺] Bash\((.+)$/ : /^ {6}(.+)$/).exec(row)?.[1]);
  if (parts.some(part => part === undefined)) return viewport;
  const rendered = parts.join('');
  if (!rendered.endsWith('…)')) return viewport;
  const commandPrefix = compact(rendered.slice(0, -2));
  const waiting = events.filter(e => e.kind === 'use' && e.name === 'Bash' &&
    e.messageId === current.messageId && e.requestId === current.requestId &&
    events.indexOf(e) > Math.max(...successors.map(s => events.indexOf(s))) &&
    !events.some(result => result.kind === 'result' && result.toolUseId === e.toolUseId) &&
    typeof e.input?.command === 'string' && compact(e.input.command).startsWith(commandPrefix));
  if (commandPrefix.length < 32 || waiting.length !== 1) return viewport;
  const completed = events.filter(e => e.kind === 'result' && e.isError === false &&
    Date.parse(e.timestamp) <= pendingTime).map(result => ({result, use:events.find(e =>
      e.kind === 'use' && e.toolUseId === result.toolUseId)})).filter(({use}) =>
        use?.name === 'Edit' && use.input?.file_path === file &&
        use.messageId === current.messageId && use.requestId === current.requestId).at(-1);
  const replacement = completed?.use?.input?.new_string;
  if (typeof replacement !== 'string' || !replacement) return viewport;
  const before = fs.readFileSync(file, 'utf8'), at = before.indexOf(replacement);
  if (at < 0 || before.indexOf(replacement, at + 1) !== -1) return viewport;
  // Native diffs display at most three unchanged context lines after an edit.
  // The cropped row must be a suffix of one of those current, unchanged lines.
  const lineEnd = before.indexOf('\n', at + replacement.length);
  const context = lineEnd < 0 ? [] : before.slice(lineEnd + 1).split('\n').slice(0, 3);
  if (!context.some(line => compact(line).endsWith(compact(clipped[1]!)))) return viewport;
  return lines.slice(panel).join('\n');
}

/** A cropped command caption is display only. Bind the complete wrapped command
 * to one unstarted successor in the current published batch before discarding it. */
function queuedCommandViewport(viewport: string, current: NativePublicToolEvent,
  events: NativePublicToolEvent[], queued: ReadonlySet<string>, hookSeenIds: readonly string[],
  viewportCapturedAt: number): string {
  if (!queued.size) return viewport;
  const text = viewport.replace(/\r\n?/g, '\n');
  const panels = [...text.matchAll(/^[─╌]{8,}\n {0,3}Edit file[ \t]*\n/gm)];
  if (panels.length !== 1 || panels[0]!.index === 0) return viewport;
  const rows = text.slice(0, panels[0]!.index).split('\n');
  while (rows.at(-1)?.trim() === '') rows.pop();
  const parts = rows.map((row, i) =>
    (i === 0 ? /^ {2}⎿[ \u00a0]+\$ (\S.*)$/ : /^ {5}(\S.*)$/).exec(row)?.[1]);
  if (!parts.length || parts.some(part => part === undefined)) return viewport;
  const currentIndex = events.indexOf(current);
  const waiting = events.filter(e => e.kind === 'use' && e.name === 'Bash' &&
    e.messageId === current.messageId && e.requestId === current.requestId && events.indexOf(e) > currentIndex &&
    !events.some(result => result.kind === 'result' && result.toolUseId === e.toolUseId));
  const command = waiting[0], input = command?.input?.command;
  if (waiting.length !== 1 || !command || typeof input !== 'string' || !input || input.length > MAX_BYTES ||
      /[\x00-\x1f\x7f]/.test(input) || hookSeenIds.includes(command.toolUseId) ||
      Date.parse(command.timestamp) > viewportCapturedAt ||
      events.some(e => e.kind === 'use' && queued.has(e.toolUseId) && events.indexOf(e) >= events.indexOf(command))) return viewport;
  // Preserve every displayed character, including spaces inside quoted arguments.
  // Only whitespace omitted at a renderer soft-wrap boundary may be skipped.
  let remaining = input;
  for (let i = 0; i < parts.length; i++) {
    if (!remaining.startsWith(parts[i]!)) return viewport;
    remaining = remaining.slice(parts[i]!.length);
    if (i < parts.length - 1) remaining = remaining.replace(/^[ \t]+/, '');
  }
  return remaining === '' ? text.slice(panels[0]!.index) : viewport;
}

/** A native command description can remain above an unpublished Edit panel.
 * Its text supplies no command identity, completion, or approval authority.
 * Only the digest-bound pending path may discard this one display prefix. */
function pendingCommandDisplayViewport(viewport: string, file: string, ownedStateRoot?: string): string {
  const text = viewport.replace(/\r\n?/g, '\n');
  const panels = [...text.matchAll(/^[─╌]{8,}\n {0,3}Edit file[ \t]*\n/gm)];
  if (panels.length !== 1 || panels[0]!.index === 0) return viewport;
  const prefix = text.slice(0, panels[0]!.index).split('\n').filter(line => line.trim());
  // An unpublished batch can leave the current Update title, plan redraws,
  // and a queued Bash card above the panel. These cards grant no authority:
  // only the one current Edit's owned path and complete digest below do so.
  const update = /^[●⏺] Update\(([^\n]+)\)$/.exec(prefix[0] ?? '');
  if (update && ownedStateRoot) {
    const relative = path.relative(ownedStateRoot, file).split(path.sep).join('/');
    const alias = path.basename(ownedStateRoot) === '.gstack' ? `~/.gstack/${relative}` : undefined;
    const bash = prefix.findIndex(row => /^[●⏺] Bash\(/.test(row));
    const command = prefix.slice(bash, -1);
    if ((update[1] === file || update[1] === alias) && bash > 1 &&
        prefix.slice(1, bash).every(row => /^[●⏺] Updated plan$/.test(row)) &&
        /^ {2}⎿[ \u00a0]+Waiting…$/.test(prefix.at(-1) ?? '') && command.length > 0 &&
        command.every((row, i) => (i === 0 ? /^[●⏺] Bash\(\S.*$/ : /^ {6}\S.*$/).test(row)) &&
        command.at(-1)!.endsWith('…)') &&
        !command.slice(1).some(row => /^ {6}[●⏺❯☐□>]|^ {6}(?:`{3,}|~{3,})/.test(row)) &&
        !/(?:Do you want|Would you like|Bash command[^\n]*permission|requested permissions?|allow all edits|always allow access|Esc to cancel|Edit file)/i.test(command.join('\n'))) {
      return text.slice(panels[0]!.index);
    }
    return viewport;
  }
  const title = /^[●⏺] ([^\n]+)$/.exec(prefix[0] ?? '')?.[1];
  if (!title || /^(?:["'`“‘]|(?:source|example|quoted|history|historical|hypothetical|previous|earlier)\b)/i.test(title) ||
      !/^ {2}⎿[ \u00a0]+\$ \S.*$/.test(prefix[1] ?? '') ||
      prefix.slice(2).some(line => !/^ {5}\S.*$/.test(line)) ||
      prefix.slice(1).some(line => /^[ \t]*[●⏺❯☐□>]|^[ \t]*(?:`{3,}|~{3,})/.test(line)) ||
      /(?:Do you want|Would you like|Bash command[^\n]*permission|requested permissions?|allow all edits|always allow access|Esc to cancel|Edit file)/i.test(prefix.join('\n'))) return viewport;
  return text.slice(panels[0]!.index);
}

/** Same native-history gate for an unpublished pending Edit, independent of its display. */
export function hasPendingAutoplanArtifactHistory(
  context: ArtifactPermissionContext & { pending?: PendingAutoplanArtifact },
): boolean {
  const p = context.pending, now = context.now ?? Date.now();
  if (!p || p.source !== 'pre_tool_use' || p.tool !== 'Edit' || context.transcriptStatus !== 'ready' ||
      !Number.isFinite(now) || !Number.isFinite(context.commandStartedAt) ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(p.sessionId) || !/^[A-Za-z0-9_-]{1,160}$/.test(p.toolUseId) ||
      !ownedAutoplanArtifact(p.file, context) || context.publicTools.length > 10_000) return false;
  const pendingTime = Date.parse(p.timestamp);
  if (!Number.isFinite(pendingTime) || pendingTime < context.commandStartedAt || pendingTime > now) return false;
  const events = context.publicTools.filter(e => Date.parse(e.timestamp) >= context.commandStartedAt);
  if (!events.length || context.publicTools.some(e => !Number.isFinite(Date.parse(e.timestamp)))) return false;
  const uses = new Map<string, NativePublicToolEvent>(), results = new Map<string, NativePublicToolEvent>();
  let last = context.commandStartedAt;
  for (const event of events) {
    const time = Date.parse(event.timestamp);
    if (event.sessionId !== p.sessionId || !event.toolUseId || event.toolUseId === p.toolUseId || time < last || time > now) return false;
    last = time;
    const map = event.kind === 'use' ? uses : results;
    if (map.has(event.toolUseId) || (event.kind === 'result' && !uses.has(event.toolUseId))) return false;
    map.set(event.toolUseId, event);
  }
  const mutations = [...uses.values()].filter(e => e.name === 'Write' || e.name === 'Edit');
  // Hook metadata cannot replace a published request/result or an unresolved
  // mutation. Public successful same-file history remains mandatory.
  if (mutations.some(e => !results.has(e.toolUseId) || Date.parse(e.timestamp) > pendingTime ||
      Date.parse(results.get(e.toolUseId)!.timestamp) > pendingTime) ||
      !mutations.some(e => e.input?.file_path === p.file && results.get(e.toolUseId)?.isError === false &&
        Date.parse(results.get(e.toolUseId)!.timestamp) <= pendingTime)) return false;
  return true;
}

/** Metadata-only fallback. Added rows are display evidence, never request content. */
export function pendingAutoplanArtifactPermissionInput(viewport: string,
  context: ArtifactPermissionContext & { pending?: PendingAutoplanArtifact; viewportCapturedAt: number },
  seen: ReadonlySet<string>,
): { input: '1\r'; signature: string; file: string } | null {
  const p = context.pending, now = context.now ?? Date.now();
  if (p?.editDigest !== undefined && !validAutoplanEditDigest(p.editDigest)) return null;
  if (!p || !Number.isFinite(now) || context.transcriptStatus !== 'ready' || !Number.isFinite(context.commandStartedAt) ||
      !Number.isFinite(context.viewportCapturedAt) || context.viewportCapturedAt > now ||
      context.commandStartedAt > context.viewportCapturedAt || viewport.length > MAX_BYTES ||
      p.source !== 'pre_tool_use' || p.tool !== 'Edit' || typeof p.file !== 'string' ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(p.sessionId) || !/^[A-Za-z0-9_-]{1,160}$/.test(p.toolUseId) ||
      !ownedAutoplanArtifact(p.file, context)) return null;
  const pendingTime = Date.parse(p.timestamp), signature = `${p.sessionId}:${p.toolUseId}`;
  if (!Number.isFinite(pendingTime) || pendingTime < context.commandStartedAt || pendingTime > context.viewportCapturedAt ||
      seen.has(signature) || seen.has(autoplanArtifactMenuKey(viewport)) || context.publicTools.length > 10_000) return null;
  if (!hasPendingAutoplanArtifactHistory(context)) return null;
  try {
    const currentViewport = p.editDigest ? pendingCommandDisplayViewport(viewport, p.file, context.ownedStateRoot) : viewport;
    const text = currentViewport.replace(/\r\n?/g, '\n');
    const menu = /^ {0,3}Do you want to make this edit to ([^\n?]+)\? *\n {0,3}❯ *1\. Yes *\n {0,3}2\. Yes, and switch to accept edits \(auto-approve file edits and common file commands\) for this session(?: \(shift\+tab\))? *\n {0,3}3\. No *\n\s*Esc to cancel [·•] Tab to amend\s*$/m.exec(text);
    if (!menu || menu.index + menu[0].length !== text.length || menu[1] !== path.basename(p.file)) return null;
    const rows = text.slice(0, menu.index).trimEnd().split('\n');
    if (!/^[╌─]{8,}$/.test(rows.pop() ?? '')) return null;
    const diffRows = ownedEditDiffRows(rows,p.file,context.ownedStateRoot);
    if (!diffRows) return null;
    if (Math.floor(fs.statSync(p.file).mtimeMs) > pendingTime) return null;
    if (p.editDigest) {
      const before = readAutoplanDigestFile(p.file);
      if (!before || createHash('sha256').update(before).digest('hex') !== p.editDigest.beforeSHA256) return null;
      if (matchesAutoplanDigestRows(diffRows,before,p.editDigest,currentViewport !== viewport)) return {input:'1\r', signature, file:p.file};
      if (currentViewport !== viewport) return null; // The new prefix path requires the exact digest, including additions.
      // Legacy deletion crops below must still honor the recorded request digest.
    }
    const originals = fs.readFileSync(p.file, 'utf8').split('\n').map(compact);
    const chunks: Array<{kind:string; text:string; partial?:boolean}> = [];
    const fullRow = /^( {0,3})([1-9]\d*) ([+ -])(.*)$/;
    const first = diffRows.map(row => fullRow.exec(row)).find(Boolean);
    if (!first) return null;
    const markerColumn = first[1]!.length + first[2]!.length + 1;
    let numbered = 0;
    for (const row of diffRows) {
      const full = fullRow.exec(row);
      if (full) {
        if (!Number.isSafeInteger(Number(full[2])) || full[1]!.length + full[2]!.length + 1 !== markerColumn) return null;
        numbered++; chunks.push({kind:full[3]!, text:full[4]!});
      } else {
        const kind = row[markerColumn], text = row.slice(markerColumn + 1);
        if (!row.startsWith(' '.repeat(markerColumn)) || !['+', ' ', '-'].includes(kind ?? '')) return null;
        if (!chunks.length) chunks.push({kind:kind!, text, partial:true});
        else {
          const previous = chunks.at(-1)!;
          if (previous.kind !== kind) return null;
          previous.text += text;
        }
      }
    }
    // A leading cropped deletion/context fragment must be an actual suffix.
    // Complete removed/context rows must occur in the current owned file.
    if (numbered < 2 || !chunks.some(c => c.kind === '-' && compact(c.text)) ||
        chunks.some(c => c.kind !== '+' && !originals.some(line => c.partial
          ? line.endsWith(compact(c.text)) : line === compact(c.text)))) return null;
    const digest = p.editDigest;
    if (digest && chunks.some(chunk => {
      const hash = autoplanEditLineHash(chunk.text);
      if (chunk.kind === '+') return chunk.partial || !digest.newLineHashes.includes(hash);
      if (chunk.kind !== '-') return false; // Current-file context was checked above.
      return chunk.partial
        ? !originals.some(line => line.endsWith(compact(chunk.text)) && digest.oldLineHashes.includes(autoplanEditLineHash(line)))
        : !digest.oldLineHashes.includes(hash);
    })) return null;
    return {input:'1\r', signature, file:p.file};
  } catch { return null; }
}

/** A native hook identifies the executing request within a published tool batch. */
export function publishedAutoplanArtifactPermissionInput(viewport: string,
  context: ArtifactPermissionContext & { pending?: PendingAutoplanArtifact; viewportCapturedAt: number },
  seen: ReadonlySet<string>,
): { input: '1\r'; signature: string; file: string } | null {
  const p=context.pending, now=context.now??Date.now();
  if (!p || p.source!=='pre_tool_use' || p.tool!=='Edit' || !validAutoplanEditDigest(p.editDigest) ||
      context.transcriptStatus!=='ready' || !Number.isFinite(now) || !Number.isFinite(context.commandStartedAt) ||
      !Number.isFinite(context.viewportCapturedAt) || context.commandStartedAt>context.viewportCapturedAt ||
      context.viewportCapturedAt>now || context.publicTools.length>10_000 || viewport.length>MAX_BYTES ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(p.sessionId) || !/^[A-Za-z0-9_-]{1,160}$/.test(p.toolUseId) ||
      !Array.isArray(p.hookSeenIds) || !p.hookSeenIds.length || p.hookSeenIds.length>128 ||
      p.hookSeenIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id)) ||
      new Set(p.hookSeenIds).size!==p.hookSeenIds.length || !p.hookSeenIds.includes(p.toolUseId) ||
      seen.has(`${p.sessionId}:${p.toolUseId}`) || seen.has(autoplanArtifactMenuKey(viewport)) ||
      !ownedAutoplanArtifact(p.file,context)) return null;
  const pendingTime=Date.parse(p.timestamp);
  if (!Number.isFinite(pendingTime) || pendingTime<context.commandStartedAt || pendingTime>context.viewportCapturedAt ||
      context.publicTools.some(e=>!Number.isFinite(Date.parse(e.timestamp)))) return null;
  const events=context.publicTools.filter(e=>Date.parse(e.timestamp)>=context.commandStartedAt);
  const uses=new Map<string,NativePublicToolEvent>(), results=new Map<string,NativePublicToolEvent>();
  let last=context.commandStartedAt;
  for (const event of events) {
    const time=Date.parse(event.timestamp), map=event.kind==='use'?uses:results;
    if (event.sessionId!==p.sessionId || !event.toolUseId || time<last || time>now || map.has(event.toolUseId) ||
        (event.kind==='result'&&!uses.has(event.toolUseId))) return null;
    last=time;map.set(event.toolUseId,event);
  }
  const current=uses.get(p.toolUseId), input=current?.input;
  if (!current || current.name!=='Edit' || results.has(p.toolUseId) || Date.parse(current.timestamp)>pendingTime ||
      !/^msg_[A-Za-z0-9_-]{1,160}$/.test(current.messageId??'') || !/^req_[A-Za-z0-9_-]{1,160}$/.test(current.requestId??'') ||
      input?.file_path!==p.file || typeof input.old_string!=='string' || !input.old_string ||
      typeof input.new_string!=='string' || input.new_string===input.old_string ||
      (input.replace_all!==undefined&&input.replace_all!==false)) return null;
  const queued=new Set<string>();
  let queuedPlans = 0;
  for (const mutation of [...uses.values()].filter(e=>e.name==='Edit'||e.name==='Write')) {
    const result=results.get(mutation.toolUseId);
    if (result && (Date.parse(mutation.timestamp)>pendingTime || Date.parse(result.timestamp)>pendingTime)) return null;
    if (mutation.toolUseId===p.toolUseId || result) continue;
    // Later publications are queued only when this exact batch owns them and
    // the recorder has not started them. They never supply current authority.
    const nativePlan = mutation.input?.file_path !== p.file &&
      ownedQueuedNativePlan(mutation.input?.file_path, context.ownedNativePlansRoot, pendingTime);
    if (mutation.name!=='Edit' || (mutation.input?.file_path!==p.file && !nativePlan) ||
        typeof mutation.input.old_string!=='string' || !mutation.input.old_string ||
        typeof mutation.input.new_string!=='string' || mutation.input.old_string===mutation.input.new_string ||
        (mutation.input.replace_all!==undefined && mutation.input.replace_all!==false) ||
        mutation.messageId!==current.messageId || mutation.requestId!==current.requestId ||
        Date.parse(mutation.timestamp)>context.viewportCapturedAt ||
        events.indexOf(mutation)<=events.indexOf(current) || p.hookSeenIds.includes(mutation.toolUseId)) return null;
    if (nativePlan) {
      if (![...uses.values()].some(previous => (previous.name === 'Write' || previous.name === 'Edit') &&
          previous.input?.file_path === mutation.input!.file_path &&
          results.get(previous.toolUseId)?.isError === false &&
          Date.parse(results.get(previous.toolUseId)!.timestamp) <= pendingTime)) return null;
      queuedPlans++;
    }
    queued.add(mutation.toolUseId);
  }
  try {
    if (Math.floor(fs.statSync(p.file).mtimeMs)>pendingTime) return null;
    const actual=createAutoplanEditDigest(p.file,input.old_string,input.new_string), expected=p.editDigest!;
    if (!actual || actual.beforeSHA256!==expected.beforeSHA256 || actual.requestSHA256!==expected.requestSHA256 ||
        JSON.stringify(actual.oldLineHashes)!==JSON.stringify(expected.oldLineHashes) ||
        JSON.stringify(actual.newLineHashes)!==JSON.stringify(expected.newLineHashes)) return null;
    const commandViewport = queuedCommandViewport(viewport,current,events,queued,p.hookSeenIds,context.viewportCapturedAt);
    const rendered = queuedArtifactViewport(commandViewport,current,events,queued,p.file,pendingTime,context.ownedStateRoot);
    return autoplanArtifactPermissionInput(queuedPlanViewport(rendered,queuedPlans,current,events),{...context,
      publicTools:events.filter(e=>!queued.has(e.toolUseId))},seen);
  } catch { return null; }
}
