import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildSeedConfig } from './hermetic-env';
import { getProjectEvalDir } from './eval-store';
import type { SkillTestResult } from './session-runner';

export const DOCSYNC_ROOT = path.resolve(import.meta.dir, '../..');
export const DOC_PATH = 'handbook/reference/commands/widget.md.tmpl';
export type DocsScenario = 'updated' | 'current' | 'risky' | 'store' | 'legacy';

export function gitAt(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trimEnd();
}

export function repoSnapshot(repo: string) {
  const files = gitAt(repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  const contents: Record<string, string> = {};
  for (const name of new Set(files)) {
    const file = path.join(repo, name);
    if (!fs.existsSync(file)) continue;
    const resolved = fs.realpathSync(file);
    if (!resolved.startsWith(fs.realpathSync(repo) + path.sep)) throw new Error(`fixture path escaped: ${name}`);
    if (fs.statSync(file).isFile()) contents[name] = fs.readFileSync(file).toString('base64');
  }
  return { head: gitAt(repo, 'rev-parse', 'HEAD'), index: gitAt(repo, 'ls-files', '--stage'), contents };
}

export function changedFiles(before: ReturnType<typeof repoSnapshot>, after: ReturnType<typeof repoSnapshot>): string[] {
  return [...new Set([...Object.keys(before.contents), ...Object.keys(after.contents)])]
    .filter(p => before.contents[p] !== after.contents[p]).sort();
}

export function docsCandidate(repo: string, auditId: string, mode: 'edit' | 'read-only', base: string) {
  const snapshot = repoSnapshot(repo);
  return {
    audit_id: auditId, mode, base_sha: base, head: snapshot.head, branch: gitAt(repo, 'branch', '--show-current'),
    selected_paths: Object.keys(snapshot.contents).filter(p => p !== 'personal-note.txt'),
    docs_roots: ['handbook'], generated_outputs: [], index: snapshot.index,
    content_hashes: Object.fromEntries(Object.entries(snapshot.contents).map(([p, bytes]) =>
      [p, createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex')])),
    pre_existing_dirty: gitAt(repo, 'status', '--porcelain', '-z'),
  };
}

export function fixtureDocs(scenario: DocsScenario, generatedRoot = process.env.DOCSYNC_GENERATED_ROOT || DOCSYNC_ROOT) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
  const repo = path.join(home, 'repo');
  const skills = path.join(home, '.claude/skills/gstack');
  fs.mkdirSync(repo);
  gitAt(repo, 'init', '-b', 'main');
  gitAt(repo, 'config', 'user.email', 'test@test.com');
  gitAt(repo, 'config', 'user.name', 'Test');
  gitAt(repo, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, '.qa-state'));
  fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\n.qa-state/\n');
  const write = (file: string, text: string) => {
    const dest = path.join(repo, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  };
  write('README.md', '# Widget CLI\n\nCommand reference: [widget](handbook/reference/commands/widget.md.tmpl).\n');
  write('AGENTS.md', '# Documentation\n\nAuthored docs live under handbook/. Edit .md.tmpl sources, not generated pages.\n');
  write(DOC_PATH, '# Widget reference\n\nDefault format: text.\n\nUser-maintained note: KEEP THIS EXACTLY.\n');
  write('app.ts', 'export const format = "text";\n');
  write('VERSION', '0.1.0.0\n');
  write('CHANGELOG.md', '# Changelog\n\n## 0.1.0.0\n\n- Original entry: KEEP THIS EXACTLY.\n');
  write('TODOS.md', '# TODOs\n\n- Confirm launch readiness.\n');
  write('package.json', '{"name":"widget-fixture","version":"0.1.0"}\n');
  gitAt(repo, 'add', 'README.md', 'AGENTS.md', DOC_PATH, 'app.ts', 'VERSION', 'CHANGELOG.md', 'TODOS.md', 'package.json');
  gitAt(repo, 'commit', '-m', 'fixture baseline');
  const base = gitAt(repo, 'rev-parse', 'HEAD');
  if (scenario !== 'store') gitAt(repo, 'checkout', '-b', 'feature/docs');
  if (scenario === 'current') {
    write(DOC_PATH, '# Widget reference\n\nDefault format: text.\n\nUser-maintained note: KEEP THIS EXACTLY.\n\nSupports plain text output.\n');
    gitAt(repo, 'add', DOC_PATH);
    gitAt(repo, 'commit', '-m', 'docs: clarify format');
    const remote = path.join(home, 'remote.git');
    fs.mkdirSync(remote);
    gitAt(remote, 'init', '--bare', '-b', 'main');
    gitAt(repo, 'remote', 'add', 'origin', remote);
    gitAt(repo, 'push', '-u', 'origin', 'feature/docs');
  } else {
    write('app.ts', 'export const format = "json";\n');
    gitAt(repo, 'add', 'app.ts');
    write('options.ts', 'export const pretty = true;\n');
    write('README.md', '# Widget CLI\n\nCommand reference: [widget](handbook/reference/commands/widget.md.tmpl).\n\nThe default output format is JSON.\n');
  }
  if (scenario === 'risky') {
    write('SECURITY.md', '# Security Model\n\nAll command output is guaranteed to contain no sensitive data.\n');
    write('options.ts', 'export const pretty = true;\nexport const outputIncludesSensitiveData = true;\n');
  }
  write('personal-note.txt', 'Unrelated user content: KEEP THIS EXACTLY.\n');
  for (const skill of ['document-release', 'ship']) {
    fs.mkdirSync(path.join(skills, skill, 'sections'), { recursive: true });
    for (const relative of skill === 'ship'
      ? ['SKILL.md', 'sections/documentation.md', 'sections/pr-body.md']
      : ['SKILL.md', 'sections/audit-scope.md', 'sections/release-body.md']) {
      const source = path.join(generatedRoot, skill, relative);
      if (!fs.existsSync(source)) throw new Error(`Generate the changed skill before live evaluation: ${source}`);
      fs.copyFileSync(source, path.join(skills, skill, relative));
    }
  }
  fs.cpSync(path.join(DOCSYNC_ROOT, 'bin'), path.join(skills, 'bin'), {
    recursive: true,
    filter: source => !fs.statSync(source).isFile() || fs.statSync(source).size < 5_000_000,
  });
  const state = path.join(home, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\n');
  const config = path.join(home, 'cc');
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify(buildSeedConfig({
    apiKey: process.env.ANTHROPIC_API_KEY, trustedDirs: [repo],
  })), { mode: 0o600 });
  const hook = (name: string) => ({ type: 'command', command: `bun ${path.join(DOCSYNC_ROOT, 'hosts/claude/hooks', name)}`, timeout: 5 });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: '(AskUserQuestion|mcp__.*__AskUserQuestion)', hooks: [hook('question-preference-hook.ts')] }],
    PostToolUse: [{ matcher: '(AskUserQuestion|mcp__.*__AskUserQuestion)', hooks: [hook('auq-error-fallback-hook.ts')] }],
  } }));
  const before = repoSnapshot(repo);
  const auditId = `fixture-${scenario}`;
  const candidate = path.join(home, 'candidate.json');
  fs.writeFileSync(candidate, JSON.stringify({
    audit_id: auditId, mode: scenario === 'store' ? 'read-only' : 'edit', base_sha: base,
    head: before.head, branch: gitAt(repo, 'branch', '--show-current'),
    selected_paths: Object.keys(before.contents).filter(p => p !== 'personal-note.txt'),
    docs_roots: ['handbook'], index: before.index,
    content_hashes: Object.fromEntries(Object.entries(before.contents).map(([p, bytes]) =>
      [p, createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex')])),
    pre_existing_dirty: gitAt(repo, 'status', '--porcelain'),
  }), { mode: 0o600 });
  const invocation = path.join(home, 'ship-invocation.md');

  return {
    home, repo, skills, before, candidate, auditId, invocation,
    env: { HOME: home, GSTACK_HOME: state, CLAUDE_CONFIG_DIR: config, GIT_OPTIONAL_LOCKS: '0',
      CONDUCTOR_WORKSPACE_PATH: home, GSTACK_HEADLESS: '' },
    clean: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

export function preserveDocsEvidence(fixture: ReturnType<typeof fixtureDocs>, result: Pick<SkillTestResult, 'output' | 'toolCalls'>, runId: string, name: string, extra: Record<string, unknown> = {}, projectDir?: string): string {
  if (!runId) throw new Error('EVALS_RUN_ID is required to retain docs evidence');
  const dir = path.join(projectDir ?? path.dirname(getProjectEvalDir()), 'e2e-runs', runId, `${name}-${path.basename(fixture.home)}-fixture`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ before: fixture.before, after: repoSnapshot(fixture.repo),
    output: result.output, calls: result.toolCalls, ...extra }, null, 2), { mode: 0o600 });
  if (!fs.statSync(file).size) throw new Error('docs evidence was not retained');
  return file;
}

export function sawSpawnedMarker(result: SkillTestResult): boolean {
  return result.toolCalls.some(call => call.tool === 'Bash' && /gstack-skill-start|"\$_SS"/.test(call.input?.command ?? '') &&
    /^SESSION_KIND: spawned\r?$/m.test(call.output));
}

/** The dispatched /document-release child's own report of its skill-start echo:
 *  its hand-back, or its completed reply to a parent SendMessage addressed to that
 *  same child (ship's "as echoed in the child output"). Other agents' text and the
 *  parent's own claims never count. */
export function childReportedSpawnedMarker(result: Pick<SkillTestResult, 'transcript'>, dispatch: { input: unknown; output: string }): boolean {
  if (dispatch.output.includes('SESSION_KIND: spawned')) return true;
  const events = result.transcript as any[];
  const uses = events.flatMap(event => event?.type === 'assistant' && Array.isArray(event.message?.content) ? event.message.content : [])
    .filter((block: any) => block?.type === 'tool_use');
  const dispatched = uses.filter((block: any) => ['Agent', 'Task'].includes(block.name) && JSON.stringify(block.input) === JSON.stringify(dispatch.input));
  if (dispatched.length !== 1) return false;
  const started = events.filter(event => event?.type === 'system' && event.subtype === 'task_started' && event.tool_use_id === dispatched[0].id);
  if (started.length !== 1 || typeof started[0].task_id !== 'string') return false;
  const child = started[0].task_id;
  const asks = new Set(uses.filter((block: any) => block.name === 'SendMessage' && block.input?.to === child).map((block: any) => block.id));
  return events.some(event => event?.type === 'system' && event.subtype === 'task_notification' && event.task_id === child &&
    asks.has(event.tool_use_id) && event.status === 'completed' && String(event.summary ?? '').includes('SESSION_KIND: spawned'));
}
