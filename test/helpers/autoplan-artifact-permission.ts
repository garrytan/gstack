/** One-time input for a cropped native Edit of an already-owned review artifact. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { validAutoplanEditDigest, readAutoplanDigestFile, matchesAutoplanDigestRows, createAutoplanEditDigest } from './autoplan-artifact-digest';
import type { PendingAutoplanArtifact } from './autoplan-artifact-recorder';
import type { NativePublicToolEvent } from './plan-count-transcript';

interface ArtifactPermissionContext {
  cwd: string;
  /** Set only by the launcher that created HOME/.gstack, never from ambient env. */
  ownedStateRoot?: string;
  commandStartedAt: number;
  now?: number;
  transcriptStatus: string;
  publicTools: NativePublicToolEvent[];
}

const MAX_BYTES = 1024 * 1024;
const compact = (text: string) => text.replace(/\s/g, '');

/** The native header may remain above the diff; both displayed paths must bind. */
function ownedEditDiffRows(rows: string[], file: string, ownedStateRoot?: string): string[] | null {
  const header = rows.findIndex(row => /^[●⏺] Update\(/.test(row));
  if (header > 0 && rows.slice(0,header).some(row => row.trim())) {
    // A completed native tool's diff may remain above the active edit panel.
    // Only its indented diff output is ignored; competing panels or prose are
    // not evidence for the current request and cannot be used as a prefix.
    let kind: string | undefined;
    let numbered = 0;
    for (const row of rows.slice(0, header)) {
      if (!row.trim()) continue;
      const full = /^ {6}(\d+) ([+ -])/.exec(row);
      if (full) {
        if (!Number.isSafeInteger(Number(full[1])) || Number(full[1]) < 1) return null;
        numbered++; kind = full[2];
      } else {
        const wrap = /^ {9}([+ -])/.exec(row);
        if (!wrap || (kind !== undefined && wrap[1] !== kind)) return null;
        kind = wrap[1];
      }
    }
    if (!numbered) return null;
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
  for (const row of diffRows) {
    const numbered = /^ {0,3}(\d+) ([+ -])(.*)$/.exec(row);
    if (numbered) {
      const line = Number(numbered[1]);
      if (!Number.isSafeInteger(line) || line < 1) return false;
      chunks.push({ kind: numbered[2]!, text: numbered[3]! });
    } else {
      const wrapped = /^ {4}([+ -])(.*)$/.exec(row);
      const last = chunks.at(-1);
      if (!wrapped || !last || wrapped[1] !== last.kind) return false;
      last.text += wrapped[2]!;
    }
  }
  // The crop itself cannot contain an example introduction, quote, unrelated
  // prompt, or arbitrary diff: each row must occur in this exact pending edit.
  const originals = before.split('\n').map(compact);
  const deletions = removed.split('\n').map(compact);
  const replacements = after.split('\n').map(compact);
  return chunks.some(chunk => chunk.kind !== ' ' && compact(chunk.text)) &&
    chunks.every(chunk => (chunk.kind === '+' ? replacements :
      chunk.kind === '-' ? deletions : originals).includes(compact(chunk.text)));
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
  const events = context.publicTools.filter(e => Date.parse(e.timestamp) >= context.commandStartedAt);
  if (!events.length || context.publicTools.some(e => !Number.isFinite(Date.parse(e.timestamp)))) return null;
  const uses = new Map<string, NativePublicToolEvent>(), results = new Map<string, NativePublicToolEvent>();
  let last = context.commandStartedAt;
  for (const event of events) {
    const time = Date.parse(event.timestamp);
    if (event.sessionId !== p.sessionId || !event.toolUseId || event.toolUseId === p.toolUseId || time < last || time > now) return null;
    last = time;
    const map = event.kind === 'use' ? uses : results;
    if (map.has(event.toolUseId) || (event.kind === 'result' && !uses.has(event.toolUseId))) return null;
    map.set(event.toolUseId, event);
  }
  const mutations = [...uses.values()].filter(e => e.name === 'Write' || e.name === 'Edit');
  // Hook metadata cannot replace a published request/result or an unresolved
  // mutation. Public successful same-file history remains mandatory.
  if (mutations.some(e => !results.has(e.toolUseId) || Date.parse(e.timestamp) > pendingTime ||
      Date.parse(results.get(e.toolUseId)!.timestamp) > pendingTime) ||
      !mutations.some(e => e.input?.file_path === p.file && results.get(e.toolUseId)?.isError === false &&
        Date.parse(results.get(e.toolUseId)!.timestamp) <= pendingTime)) return null;
  try {
    const text = viewport.replace(/\r\n?/g, '\n');
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
      if (matchesAutoplanDigestRows(diffRows,before,p.editDigest)) return {input:'1\r', signature, file:p.file};
      // Digest authority adds insertion-only crops; existing anchored deletion
      // authority remains available after the current-file binding succeeds.
    }
    const originals = fs.readFileSync(p.file, 'utf8').split('\n').map(compact);
    const chunks: Array<{kind:string; text:string; partial?:boolean}> = [];
    let numbered = 0;
    for (const row of diffRows) {
      const full = /^ {0,3}(\d+) ([+ -])(.*)$/.exec(row);
      if (full) {
        if (!Number.isSafeInteger(Number(full[1])) || Number(full[1]) < 1) return null;
        numbered++; chunks.push({kind:full[2]!, text:full[3]!});
      } else {
        const wrap = /^ {4}([+ -])(.*)$/.exec(row);
        if (!wrap) return null;
        if (!chunks.length) chunks.push({kind:wrap[1]!, text:wrap[2]!, partial:true});
        else {
          const previous = chunks.at(-1)!;
          if (previous.kind !== wrap[1]) return null;
          previous.text += wrap[2]!;
        }
      }
    }
    // A leading cropped deletion/context fragment must be an actual suffix.
    // Complete removed/context rows must occur in the current owned file.
    if (numbered < 2 || !chunks.some(c => c.kind === '-' && compact(c.text)) ||
        chunks.some(c => c.kind !== '+' && !originals.some(line => c.partial
          ? line.endsWith(compact(c.text)) : line === compact(c.text)))) return null;
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
  for (const mutation of [...uses.values()].filter(e=>e.name==='Edit'||e.name==='Write')) {
    const result=results.get(mutation.toolUseId);
    if (Date.parse(mutation.timestamp)>pendingTime || (result&&Date.parse(result.timestamp)>pendingTime)) return null;
    if (mutation.toolUseId===p.toolUseId || result) continue;
    // Later publications are queued only when this exact batch owns them and
    // the recorder has not started them. They never supply current authority.
    if (mutation.name!=='Edit' || mutation.input?.file_path!==p.file ||
        typeof mutation.input.old_string!=='string' || !mutation.input.old_string ||
        typeof mutation.input.new_string!=='string' || mutation.input.old_string===mutation.input.new_string ||
        (mutation.input.replace_all!==undefined && mutation.input.replace_all!==false) ||
        mutation.messageId!==current.messageId || mutation.requestId!==current.requestId ||
        events.indexOf(mutation)<=events.indexOf(current) || p.hookSeenIds.includes(mutation.toolUseId)) return null;
    queued.add(mutation.toolUseId);
  }
  try {
    if (Math.floor(fs.statSync(p.file).mtimeMs)>pendingTime) return null;
    const actual=createAutoplanEditDigest(p.file,input.old_string,input.new_string), expected=p.editDigest!;
    if (!actual || actual.beforeSHA256!==expected.beforeSHA256 || actual.requestSHA256!==expected.requestSHA256 ||
        JSON.stringify(actual.oldLineHashes)!==JSON.stringify(expected.oldLineHashes) ||
        JSON.stringify(actual.newLineHashes)!==JSON.stringify(expected.newLineHashes)) return null;
    return autoplanArtifactPermissionInput(viewport,{...context,
      publicTools:events.filter(e=>!queued.has(e.toolUseId))},seen);
  } catch { return null; }
}
