/** One-time input for a cropped native Edit of an already-owned review artifact. */
import * as fs from 'node:fs';
import * as path from 'node:path';
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

function ownedPlan(file: string, context: ArtifactPermissionContext): boolean {
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
function matchesCroppedEdit(viewport: string, file: string, before: string, removed: string, after: string): boolean {
  if (viewport.length > MAX_BYTES) return false;
  const text = viewport.replace(/\r\n?/g, '\n');
  const menu = /^ {0,3}Do you want to make this edit to ([^\n?]+)\? *\n {0,3}❯ *1\. Yes *\n {0,3}2\. Yes, and switch to accept edits \(auto-approve file edits and common file commands\) for this session(?: \(shift\+tab\))? *\n {0,3}3\. No *\n\s*Esc to cancel [·•] Tab to amend\s*$/m.exec(text);
  if (!menu || menu.index + menu[0].length !== text.length || menu[1] !== path.basename(file)) return false;
  const rows = text.slice(0, menu.index).trimEnd().split('\n');
  if (!/^[╌─]{8,}$/.test(rows.pop() ?? '')) return false;
  const chunks: Array<{ kind: string; text: string }> = [];
  for (const row of rows) {
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
  if (seen.has(signature) || !ownedPlan(edit.input.file_path, context)) return null;
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
        !matchesCroppedEdit(viewport, edit.input.file_path, before, edit.input.old_string, edit.input.new_string)) return null;
    return { input: '1\r', signature, file: edit.input.file_path };
  } catch { return null; }
}
