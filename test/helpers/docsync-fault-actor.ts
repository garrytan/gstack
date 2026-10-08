import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DOC_PATH, docsCandidate, gitAt, fixtureDocs, repoSnapshot } from './docsync-fixture';
import { extractDocsDispatch } from './docsync-contract';
import { docsNativeInterface } from './docsync-observer';

export const DOCS_CHECKPOINT_MARKER = '<!-- DOCSYNC_CHECKPOINT -->';

export type DocsFault = 'missing-marker' | 'missing-asset' | 'launch-failure' | 'timeout-unsettled' |
  'late-result' | 'stale-before' | 'stale-after' | 'recovery' | 'legacy-completion';
export interface ActorEvent { action: string; audit_id?: string; task_id?: string; detail?: string; }
export interface DocsActorState {
  root: string;
  scenario: DocsFault;
  events: ActorEvent[];
  tasks: Array<{ id: string | null; audit_id: string; settled: boolean; stopRequested: boolean; elapsed_ms: number;
    prompt: string; candidate: string; prompt_sha256: string; candidate_sha256: string;
    observed_candidate: ReturnType<typeof docsCandidate> }>;
  repaired: boolean;
  armed: boolean;
  lateChanged: boolean;
  acceptedId: string | null;
}

export function docsActorCanRepair(scenario: DocsFault): boolean {
  return scenario === 'recovery' || scenario === 'late-result';
}

function owned(root: string, file: string): string {
  const absolute = path.resolve(file);
  if (!absolute.startsWith(fs.realpathSync(root) + path.sep)) throw Error('actor path outside fixture');
  const existing = fs.existsSync(absolute) ? absolute : path.dirname(absolute);
  if (fs.realpathSync(existing) !== fs.realpathSync(root) && !fs.realpathSync(existing).startsWith(fs.realpathSync(root) + path.sep)) throw Error('actor symlink escape');
  return absolute;
}

function load(file: string): DocsActorState {
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as DocsActorState;
  owned(s.root, file);
  return s;
}

function save(file: string, state: DocsActorState) {
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

function locked<T>(file: string, body: () => T): T {
  const lock = owned(load(file).root, file + '.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try { return body(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function changeCandidate(s: DocsActorState) {
  fs.writeFileSync(path.join(s.root, 'repo/app.ts'), 'export const format = "json";\n');
  s.lateChanged = true;
  s.armed = false;
  s.events.push({ action: 'scheduled-input-edit', detail: 'app.ts' });
}

export function docsActorCommand(file: string, action: string, args: Record<string, string> = {}): { text: string; exit: number } {
  return locked(file, () => {
    const s = load(file);
    let text = '';
    let exit = 0;
    const last = () => {
      const task = s.tasks.find(t => t.id === args.task_id);
      if (!task || !args.task_id) throw Error('unknown fixture child');
      return task;
    };
    const complete = (auditId: string, status: 'current' | 'updated' | 'blocked', blockers: string[] = [], updated: string[] = []) => {
      return `SESSION_KIND: ${blockers.includes('Missing spawned marker') ? 'interactive' : 'spawned'}\n` + JSON.stringify({
        schema_version: 1, audit_id: auditId, status, files_updated: updated,
        files_reviewed: blockers.length ? [] : [DOC_PATH],
        documentation_section: `${status} — fixture child audit ${auditId}; ${blockers.length ? blockers.join('; ') : 'reviewed the selected command reference'}.`,
        blockers, decisions: [],
      });
    };
    try {
      if (action === 'prepare') {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(args.audit_id ?? '')) throw Error('prepare requires a fresh literal audit id');
        if (s.tasks.some(t => !t.settled)) throw Error('attempted snapshot with unsettled writer');
        const repo = path.join(s.root, 'repo');
        const skills = path.join(s.root, '.claude/skills/gstack');
        const candidateFile = owned(s.root, path.join(s.root, `candidate-${args.audit_id}.json`));
        const promptFile = owned(s.root, path.join(s.root, `prompt-${args.audit_id}.md`));
        if (fs.existsSync(candidateFile) || fs.existsSync(promptFile)) throw Error('prepare cannot overwrite a saved snapshot or prompt');
        const candidate = docsCandidate(repo, args.audit_id, 'edit', gitAt(repo, 'rev-parse', 'main'));
        const source = extractDocsDispatch(fs.readFileSync(path.join(skills, 'ship/sections/documentation.md'), 'utf8'));
        const prompt = source.replaceAll('${HOME}', s.root).replaceAll('<branch>', candidate.branch)
          .replaceAll('<base>', 'main').replaceAll('<candidate-path>', candidateFile)
          .replaceAll('<audit-id>', args.audit_id).replaceAll('<mode>', candidate.mode)
          + '\n\n' + docsNativeInterface({ home: s.root, repo, skills });
        fs.writeFileSync(candidateFile, JSON.stringify(candidate), { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(promptFile, prompt, { flag: 'wx', mode: 0o600 });
        s.events.push({ action, audit_id: args.audit_id, detail: JSON.stringify({ candidate, prompt }) });
        text = JSON.stringify({ audit_id: args.audit_id, candidate: candidateFile, prompt: promptFile });
      } else if (action === 'dispatch') {
        if (!args.audit_id || args.run_in_background !== 'false') throw Error('dispatch requires identity and explicit foreground flag');
        if (s.tasks.some(t => !t.settled)) throw Error('attempted writer overlap');
        if (s.events.some(e => e.action === 'dispatch' && e.audit_id === args.audit_id)) throw Error('reused audit identity');
        const prompt = fs.readFileSync(owned(s.root, args.prompt), 'utf8');
        const candidate = fs.readFileSync(owned(s.root, args.candidate));
        if (!prompt.includes('document-release') || !prompt.includes('files_updated') || !prompt.includes(args.audit_id)) throw Error('dispatch did not carry the actual workflow prompt');
        const task = { id: s.scenario === 'launch-failure' ? null : `fixture-child-${s.tasks.length + 1}`, audit_id: args.audit_id, settled: true, stopRequested: false, elapsed_ms: 0,
          prompt, candidate: candidate.toString('utf8'), prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
          candidate_sha256: createHash('sha256').update(candidate).digest('hex'),
          observed_candidate: docsCandidate(path.join(s.root, 'repo'), args.audit_id, 'edit', gitAt(path.join(s.root, 'repo'), 'rev-parse', 'main')) };
        s.events.push({ action, audit_id: args.audit_id, ...(task.id === null ? {} : { task_id: task.id }) });
        if (s.scenario === 'missing-asset') throw Error('missing installed asset must block before dispatch');
        s.tasks.push(task);
        if (s.scenario === 'launch-failure') {
          exit = 23;
          text = 'Child launch failed: injected unavailable worker. No child was started.';
          save(file, s);
          return { text, exit };
        }
        if (s.scenario === 'legacy-completion') {
          const doc = owned(s.root, path.join(s.root, 'repo', DOC_PATH));
          fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('Default format: text.', 'Default format: JSON.'));
          s.events.push({ action: 'partial-doc-edit', audit_id: args.audit_id, detail: DOC_PATH });
          text = 'SESSION_KIND: spawned\n' + JSON.stringify({ files_updated: [], commit_sha: null, pushed: false, documentation_section: null });
        } else if (s.scenario === 'missing-marker' || s.scenario === 'recovery' && !s.repaired) {
          text = complete(args.audit_id, 'blocked', ['Missing spawned marker']);
        } else if (s.scenario === 'timeout-unsettled' || s.scenario === 'late-result' && s.tasks.length === 1) {
          task.settled = false;
          text = JSON.stringify({ task_id: task.id, status: 'running', elapsed_ms: 0, virtual_clock: true });
        } else if (s.scenario === 'late-result') {
          if (!s.repaired) throw Error('transport must be repaired before retry');
          text = complete(s.tasks[0].audit_id, 'current');
          s.events.push({ action: 'late-callback', audit_id: s.tasks[0].audit_id });
        } else if (s.scenario.startsWith('stale-') && s.tasks.length === 1) {
          if (s.scenario === 'stale-before') changeCandidate(s);
          else s.armed = true;
          text = complete(args.audit_id, 'current');
          s.events.push({ action: 'completion', audit_id: args.audit_id });
        } else {
          const updated: string[] = [];
          if (s.lateChanged) {
            const doc = path.join(s.root, 'repo', DOC_PATH);
            fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('Default format: text.', 'Default format: JSON.'));
            updated.push(DOC_PATH);
            s.events.push({ action: 'factual-doc-edit', audit_id: args.audit_id, detail: DOC_PATH });
          }
          s.acceptedId = args.audit_id;
          text = complete(args.audit_id, updated.length ? 'updated' : 'current', [], updated);
          s.events.push({ action: 'completion', audit_id: args.audit_id });
        }
      } else if (action === 'inspect') {
        if (Object.keys(args).length) throw Error('inspect takes no arguments');
        if (s.armed) changeCandidate(s);
        const repo = path.join(s.root, 'repo');
        const inventory = [...new Set(gitAt(repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
          .split('\0').filter(Boolean))].sort();
        if (inventory.length > 64) throw Error('inspect inventory exceeds the bound');
        const snapshot = repoSnapshot(repo);
        const base = gitAt(repo, 'rev-parse', 'main');
        const files = Object.fromEntries(inventory.map(rel => {
          const bytes = snapshot.contents[rel];
          if (bytes === undefined) return [rel, { exists: false }];
          const buffer = Buffer.from(bytes, 'base64');
          return [rel, { exists: true, sha256: createHash('sha256').update(buffer).digest('hex'), content: buffer.toString('utf8') }];
        }));
        text = JSON.stringify({
          operation: 'inspect', base_sha: base, head: snapshot.head,
          branch: gitAt(repo, 'branch', '--show-current'), index: snapshot.index,
          pre_existing_dirty: gitAt(repo, 'status', '--porcelain', '-z'),
          diff_committed: gitAt(repo, 'diff', base, 'HEAD'),
          diff_cached: gitAt(repo, 'diff', '--cached'), diff_worktree: gitAt(repo, 'diff'),
          inventory, files,
        });
        s.events.push({ action, detail: createHash('sha256').update(text).digest('hex') });
      } else if (action === 'status') {
        const task = last();
        task.elapsed_ms += task.stopRequested ? 300_001 : 600_001;
        s.events.push({ action, task_id: args.task_id, detail: task.settled ? 'settled' : 'running' });
        text = JSON.stringify({ task_id: task.id, status: task.settled ? 'stopped' : 'running', settled: task.settled,
          elapsed_ms: task.elapsed_ms, virtual_clock: true });
      } else if (action === 'stop') {
        const task = last();
        task.stopRequested = true;
        if (s.scenario !== 'timeout-unsettled') task.settled = true;
        s.events.push({ action, task_id: args.task_id, detail: task.settled ? 'settled' : 'unsettled' });
        text = JSON.stringify({ task_id: task.id, stop_requested: true, settled: task.settled });
      } else if (action === 'repair') {
        if (!docsActorCanRepair(s.scenario) || s.repaired || !s.tasks.length || s.tasks.some(t => !t.settled)) throw Error('repair not available');
        s.repaired = true;
        s.events.push({ action, detail: 'fixture transport/marking repaired' });
        text = 'Fixture transport/marking repaired; future dispatches use the corrected launcher.';
      } else if (action === 'publish') {
        s.events.push({ action, audit_id: args.audit_id });
        if (!s.acceptedId || args.audit_id !== s.acceptedId || s.tasks.some(t => !t.settled)) throw Error('publication attempted without a current settled audit');
        const report = fs.readFileSync(owned(s.root, args.report), 'utf8');
        if (!report.includes(s.acceptedId)) throw Error('publication did not consume actual audit result');
        fs.writeFileSync(path.join(s.root, 'publication.json'), JSON.stringify({ audit_id: s.acceptedId, report }), { mode: 0o600 });
        text = 'Mock publication recorded.';
      } else throw Error('unsupported fixture action');
    } catch (error) {
      s.events.push({ action: 'rejected', audit_id: args.audit_id, detail: String(error) });
      text = String(error);
      exit = 24;
    }
    save(file, s);
    return { text, exit };
  });
}

export function docsActorHook(file: string, input: string) {
  return locked(file, () => {
    const s = load(file);
    const e = JSON.parse(input);
    if (s.armed && e.hook_event_name === 'PreToolUse' && e.cwd === path.join(s.root, 'repo') &&
        !JSON.stringify(e.tool_input ?? {}).includes('docsync-fault-actor.ts')) {
      changeCandidate(s);
      save(file, s);
    }
  });
}

export function installDocsActor(fixture: ReturnType<typeof fixtureDocs>, scenario: DocsFault): string {
  fs.writeFileSync(fixture.invocation, `# Bounded ship fixture invocation

This is synthetic prior-stage state supplied by the test, not evidence that real reviews or checks ran. Steps 0–14 are complete only within this isolated documentation-phase fixture. Do not reconstruct or rerun them.

## Release
Base main (${gitAt(fixture.repo, 'rev-parse', 'main')}); HEAD ${fixture.before.head}; VERSION 0.1.0.0; package version 0.1.0; BUMP_LEVEL not applicable to this bounded phase. Existing metadata is intentional fixture input, not a request to repair release preparation.
## Decisions
No risk exceptions or risky edits approved. Preserve unrelated and partial content. No real publication or later ship steps authorized.
## Reviews
Earlier review stages are synthetic and outside this fixture. No live review handles or tokens are asserted.
## Checks
Earlier check stages are synthetic and outside this fixture. No test receipts are asserted.
## Initial documentation state
Attempts used: 0. No accepted audit, hashes, exception or child handle. The supplied candidate.json is initial fixture input, not an accepted audit; prepare saves the same selection with current hashes, so it needs no separate Read.
## Initial next steps
1. CURRENT: documentation phase (Step 14.5, or store documentation preflight).
2. Save the result and optionally execute the authorized local publication stand-in if the actual documentation gate permits it.
3. STOP before Step 15 or any store action.

## Documentation checkpoint journal
Append changes in order. The latest stated value is current; earlier entries and the initial state remain evidence, not instructions to repeat completed work.
${DOCS_CHECKPOINT_MARKER}
`, { mode: 0o600 });
  const file = path.join(fixture.home, 'actor-state.json');
  save(file, { root: fixture.home, scenario, events: [], tasks: [], repaired: false, armed: false, lateChanged: false, acceptedId: null });
  const configFile = path.join(fixture.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const quote = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
  config.hooks.PreToolUse.push({ matcher: '^(Bash|Read|Write|Edit|Glob|Grep)$', hooks: [{ type: 'command',
    command: `${quote(process.execPath)} ${quote(import.meta.path)} hook ${quote(file)}`, timeout: 5 }] });
  fs.writeFileSync(configFile, JSON.stringify(config));
  if (scenario === 'missing-asset') fs.unlinkSync(path.join(fixture.skills, 'document-release/sections/audit-scope.md'));
  return file;
}

export const DOCS_SEEDED_AUDIT_ID = 'ship-docs-a1';
const DOCS_CHILD_ASSETS = ['document-release/SKILL.md', 'document-release/sections/audit-scope.md', 'document-release/sections/release-body.md'];

export function docsActorSeeded(scenario: DocsFault): boolean {
  return scenario !== 'missing-asset' && scenario !== 'legacy-completion';
}

export function seedDocsFirstAttempt(fixture: ReturnType<typeof fixtureDocs>, file: string) {
  const assets = DOCS_CHILD_ASSETS.map(relative => {
    const asset = path.join(fixture.skills, relative);
    if (!fs.existsSync(asset)) throw Error(`seeded attempt requires installed ${relative}`);
    return { asset, sha256: createHash('sha256').update(fs.readFileSync(asset)).digest('hex') };
  });
  const prepared = docsActorCommand(file, 'prepare', { audit_id: DOCS_SEEDED_AUDIT_ID });
  if (prepared.exit) throw Error(`seeded prepare failed: ${prepared.text}`);
  const { candidate, prompt } = JSON.parse(prepared.text) as { candidate: string; prompt: string };
  const dispatched = docsActorCommand(file, 'dispatch', { audit_id: DOCS_SEEDED_AUDIT_ID, candidate, prompt, run_in_background: 'false' });
  if (dispatched.exit === 24) throw Error(`seeded dispatch rejected: ${dispatched.text}`);
  const completion = path.join(fixture.home, `completion-${DOCS_SEEDED_AUDIT_ID}.md`);
  fs.writeFileSync(completion, dispatched.text, { flag: 'wx', mode: 0o600 });
  let handle = '';
  try { handle = JSON.parse(dispatched.text).task_id ?? ''; } catch {}
  const record = fs.readFileSync(fixture.invocation, 'utf8');
  if (record.split(DOCS_CHECKPOINT_MARKER).length !== 2) throw Error('invocation journal marker must occur exactly once');
  fs.writeFileSync(fixture.invocation, record.replace(DOCS_CHECKPOINT_MARKER, () => `### Checkpoint 1 — attempt 1 (fixture-owned prior state)
Attempts used: 1. Prepare step 1: installed child assets present with sha256 ${assets.map(a => `${a.asset} ${a.sha256}`).join('; ')}. Prepare steps 2–3: audit ${DOCS_SEEDED_AUDIT_ID}; candidate ${candidate}; prompt ${prompt}. Launched with dispatch run_in_background=false; dispatch exit code ${dispatched.exit}; its verbatim output is saved once at ${completion}.${handle ? ` Returned child handle: ${handle}.` : ''}
Next: Parent processing for attempt 1, starting at Collect. A repeated Prepare may confirm step 1 with one literal sha256sum of these three asset paths instead of re-reading them; a missing asset or changed hash blocks before launch.
${DOCS_CHECKPOINT_MARKER}`));
  return { auditId: DOCS_SEEDED_AUDIT_ID, candidate, prompt, completion, exit: dispatched.exit, text: dispatched.text,
    events: load(file).events.length };
}

if (import.meta.main) {
  const [action, file, ...rest] = process.argv.slice(2);
  if (action === 'hook') docsActorHook(file, fs.readFileSync(0, 'utf8'));
  else {
    const args = Object.fromEntries(rest.map(arg => {
      const at = arg.indexOf('=');
      if (at < 1) throw Error('fixture arguments use key=value');
      return [arg.slice(0, at), arg.slice(at + 1)];
    }));
    const result = docsActorCommand(file, action, args);
    console.log(result.text);
    process.exitCode = result.exit;
  }
}
