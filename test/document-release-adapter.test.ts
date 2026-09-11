import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as adapters from '../lib/closed-effect-adapters';
import { runtimeAttestation } from './helpers/installed-authority';

let root: string, state: string, base: string;
let prior: NodeJS.ProcessEnv;
const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, timeout: 30_000, env: {
    PATH: process.env.PATH!, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
  } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
const prepare = (taskId = 'ship-task', paths = ['README.md', 'docs/new.md']) =>
  adapters.prepareDocumentRelease(root, { taskId, paths }, state);
const finish = (result: unknown, taskId = 'ship-task') =>
  adapters.finishDocumentRelease(root, { taskId, grantId: (result as any)?.grant_id, result }, state);
function result(grant: any, changed: Record<string, string | null> = {}) {
  return { grant_id: grant.grant_id, task_id: grant.task_id, preimage_sha256: grant.preimage_sha256,
    files_updated: Object.keys(changed).sort(), content_sha256: Object.fromEntries(Object.entries(changed).map(([key, value]) => [key, value === null ? null : sha(value)])),
    commit_sha: null, pushed: false, documentation_section: null, decisions: [] };
}
function leaseFile() {
  const directory = path.join(state, 'document-release');
  return path.join(directory, fs.readdirSync(directory).find(file => file.endsWith('.json'))!);
}

beforeEach(() => {
  prior = { ...process.env };
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-doc-grant-'));
  root = path.join(base, 'repo'); state = path.join(base, 'state');
  fs.mkdirSync(root); fs.mkdirSync(state, { mode: 0o700 }); fs.mkdirSync(path.join(root, 'docs'));
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'README.md'), 'Before\n');
  fs.writeFileSync(path.join(root, 'code.ts'), 'before code\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  const executable = fs.realpathSync(Bun.which('git')!);
  const manifest = path.join(base, 'runtime.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'ecpe.gstack-runtime.v1', tools: {
    git: { ...runtimeAttestation(executable), version: git('--version') },
  } }));
  process.env.ECPE_TESTING = '1'; process.env.ECPE_TEST_RUNTIME_MANIFEST = manifest;
  process.env.ECPE_TEST_STATE_ROOT = state;
  process.env.ECPE_DOCUMENT_RELEASE_AUTHORIZED = '1';
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
  Object.assign(process.env, prior);
  fs.rmSync(base, { recursive: true, force: true });
});

describe('document release issued lease and closed completion', () => {
  test('requires explicit authority before persisting any grant', async () => {
    delete process.env.ECPE_DOCUMENT_RELEASE_AUTHORIZED;
    await expect(prepare()).rejects.toThrow('grant_required');
    expect(fs.existsSync(path.join(state, 'document-release'))).toBe(false);
  });
  test('binds exact paths and preimage, preserves dirty work, and consumes once', async () => {
    fs.writeFileSync(path.join(root, 'code.ts'), 'user work\n'); git('add', 'code.ts');
    const index = fs.readFileSync(path.join(root, '.git/index'));
    const head = git('rev-parse', 'HEAD');
    const grant = await prepare();
    expect(grant).toMatchObject({ task_id: 'ship-task', paths: ['README.md', 'docs/new.md'], preimage: { head_oid: head, index_sha256: sha(index.toString('base64')) } });
    expect(grant.grant_id).toMatch(/^[0-9a-f]{64}$/);
    expect(grant.preimage.files).toEqual({ 'README.md': sha('Before\n'), 'docs/new.md': null });
    fs.writeFileSync(path.join(root, 'README.md'), 'After\n');
    fs.writeFileSync(path.join(root, 'docs/new.md'), 'New doc\n');
    const output = result(grant, { 'README.md': 'After\n', 'docs/new.md': 'New doc\n' });
    expect(await finish(output)).toMatchObject({ status: 'verified', files_updated: ['README.md', 'docs/new.md'] });
    expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(index);
    expect(fs.readFileSync(path.join(root, 'code.ts'), 'utf8')).toBe('user work\n');
    await expect(finish(output)).rejects.toThrow('effect_grant_replayed');
    await expect(prepare()).rejects.toThrow('document_release_task_already_issued');
  });
  test('issues unpredictable task-bound grants even for the same tree and paths', async () => {
    const first = await prepare(); const second = await prepare('other-task');
    expect(first.grant_id).not.toBe(second.grant_id);
    await expect(finish(result(first), 'other-task')).rejects.toThrow('effect_grant_mismatch');
    expect(await finish(result(second), 'other-task')).toMatchObject({ status: 'verified' });
  });
  test.each(['code.ts', '../README.md', 'README.md*', 'README.md.ts', 'CHANGELOG.md', 'docs/package.json', 'docs/CHANGELOG.md'])('rejects non-document or release-owned path %s', async candidate => {
    await expect(prepare('ship-task', [candidate])).rejects.toThrow();
  });
  test('rejects symlink paths and parent traversal through a symlink', async () => {
    fs.symlinkSync(path.join(root, 'code.ts'), path.join(root, 'docs/link.md'));
    await expect(prepare('ship-task', ['docs/link.md'])).rejects.toThrow('document_release_path_unsafe');
    fs.symlinkSync(base, path.join(root, 'docs/outside'));
    await expect(prepare('ship-task', ['docs/outside/new.md'])).rejects.toThrow('document_release_path_unsafe');
  });
  test('rejects ignored documentation paths before issuing a lease', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'docs/private.md\n');
    await expect(prepare('ship-task', ['docs/private.md'])).rejects.toThrow('document_release_ignored_path');
    expect(fs.existsSync(path.join(state, 'document-release'))).toBe(false);
  });
  test.each(['mode', 'new-mode', 'hardlink'])('rejects documentation %s changes', async kind => {
    const grant = await prepare();
    const changes: Record<string, string> = {};
    if (kind === 'mode') { fs.chmodSync(path.join(root, 'README.md'), 0o777); changes['README.md'] = 'Before\n'; }
    if (kind === 'new-mode') { fs.writeFileSync(path.join(root, 'docs/new.md'), 'New\n', { mode: 0o777 }); fs.chmodSync(path.join(root, 'docs/new.md'), 0o777); changes['docs/new.md'] = 'New\n'; }
    if (kind === 'hardlink') fs.linkSync(path.join(root, 'README.md'), path.join(base, 'external-link'));
    await expect(finish(result(grant, changes))).rejects.toThrow();
  });
  test.each(['staged', 'head', 'outside', 'untracked', 'undeclared', 'content', 'binding', 'delivery', 'error', 'malformed'])(
    'rejects %s completion and burns the issued lease', async kind => {
      const grant = await prepare();
      fs.writeFileSync(path.join(root, 'README.md'), 'After\n');
      const output: any = result(grant, { 'README.md': 'After\n' });
      if (kind === 'staged') git('add', 'README.md');
      if (kind === 'head') { git('add', 'README.md'); git('commit', '-qm', 'unexpected helper commit'); }
      if (kind === 'outside') fs.writeFileSync(path.join(root, 'code.ts'), 'helper code\n');
      if (kind === 'untracked') fs.writeFileSync(path.join(root, 'other.txt'), 'helper file\n');
      if (kind === 'undeclared') { output.files_updated = []; output.content_sha256 = {}; }
      if (kind === 'content') output.content_sha256['README.md'] = sha('invented\n');
      if (kind === 'binding') output.preimage_sha256 = 'a'.repeat(64);
      if (kind === 'delivery') output.pushed = true;
      if (kind === 'error') output.error = 'audit unavailable';
      if (kind === 'malformed') output.decisions = null;
      await expect(finish(output)).rejects.toThrow();
      await expect(finish(result(grant, { 'README.md': 'After\n' }))).rejects.toThrow('effect_grant_replayed');
    });
  test('lease files are private and symlink or writable-record replacement fails closed', async () => {
    const grant = await prepare(); const file = leaseFile();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(file, 0o644);
    await expect(finish(result(grant))).rejects.toThrow('durable_write_target_invalid');
    fs.chmodSync(file, 0o600); fs.renameSync(file, `${file}.saved`); fs.symlinkSync(`${file}.saved`, file);
    await expect(finish(result(grant))).rejects.toThrow('durable_write_target_invalid');
  });
  test('expired authority cannot be consumed or reissued by retrying the task', async () => {
    const grant = await prepare(); const now = Date.now;
    Date.now = () => Date.parse(grant.expires_at) + 1;
    try { await expect(finish(result(grant))).rejects.toThrow('document_release_grant_expired'); }
    finally { Date.now = now; }
    await expect(prepare()).rejects.toThrow('document_release_task_already_issued');
  });
  test('simultaneous finish calls cannot both consume the same grant', async () => {
    const grant = await prepare();
    const results = await Promise.allSettled([finish(result(grant)), finish(result(grant))]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
  });
  test('CLI prepare and concurrent finish share the issued lease across separate processes', async () => {
    const cli = path.join(import.meta.dir, '../scripts/authority/effect-scope.ts');
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, 'document-release', ...args], { cwd: root, env: process.env, timeout: 30_000 });
    const issued = run('prepare', '--skill', 'ship', '--task-id', 'cli-task', '--path', 'README.md', '--json');
    expect(issued.exitCode, issued.stderr.toString()).toBe(0);
    const grant = JSON.parse(issued.stdout.toString()).result;
    expect(grant.paths).toEqual(['README.md']);
    fs.writeFileSync(path.join(root, 'README.md'), 'CLI docs\n');
    const reply = path.join(base, 'reply.json'); fs.writeFileSync(reply, JSON.stringify(result(grant, { 'README.md': 'CLI docs\n' })));
    const args = ['finish', '--skill', 'ship', '--task-id', 'cli-task', '--grant-id', grant.grant_id, '--result-file', reply, '--json'];
    const calls = [0, 1].map(() => Bun.spawn([process.execPath, cli, 'document-release', ...args], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' }));
    const completed = await Promise.all(calls.map(async child => ({
      exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(),
    })));
    expect(completed.map(item => item.exitCode).sort()).toEqual([0, 1]);
    expect(JSON.parse(completed.find(item => item.exitCode === 0)!.stdout).result.status).toBe('verified');
    expect(completed.find(item => item.exitCode === 1)!.stderr).toContain('effect_grant_replayed');
    const replayed = run(...args);
    expect(replayed.exitCode).toBe(1); expect(replayed.stderr.toString()).toContain('effect_grant_replayed');
    const unknown = run('prepare', '--skill', 'ship', '--task-id', 'other-task', '--path', 'README.md', '--mystery', 'value', '--json');
    expect(unknown.exitCode).toBe(2); expect(unknown.stderr.toString()).toContain('effect_argument_invalid');
  });
  test('CLI malformed completion consumes the parent-named lease without trusting helper JSON', () => {
    const cli = path.join(import.meta.dir, '../scripts/authority/effect-scope.ts');
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, 'document-release', ...args], { cwd: root, env: process.env, timeout: 30_000 });
    const issued = run('prepare', '--skill', 'ship', '--task-id', 'bad-result', '--path', 'README.md', '--json');
    expect(issued.exitCode, issued.stderr.toString()).toBe(0);
    const grant = JSON.parse(issued.stdout.toString()).result;
    const reply = path.join(base, 'broken.json'); fs.writeFileSync(reply, 'not JSON');
    const args = ['finish', '--skill', 'ship', '--task-id', 'bad-result', '--grant-id', grant.grant_id, '--result-file', reply, '--json'];
    const bad = run(...args);
    expect(bad.exitCode).toBe(1); expect(bad.stderr.toString()).toContain('document_release_result_invalid');
    fs.writeFileSync(reply, JSON.stringify(result(grant)));
    const retry = run(...args);
    expect(retry.exitCode).toBe(1); expect(retry.stderr.toString()).toContain('effect_grant_replayed');
  });
});
