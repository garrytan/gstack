import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');
const TOOL = join(ROOT, 'bin/gstack-autoplan-snapshot.ts');
const original = readFileSync(join(ROOT, 'test/fixtures/plans/autoplan-dashboard.md'));
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const owned: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-autoplan-init-')); owned.push(dir);
  const source = join(dir, 'source plan.md');
  const active = join(dir, 'assigned plan.md');
  const restore = join(dir, 'restore point.md');
  writeFileSync(source, original);
  return { dir, source, active, restore };
}
function cli(...args: string[]) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
}
function invoke(...args: string[]) {
  const result = cli(...args);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('actual raw R input initializes before scope and reaches a complete CEO dispatch payload', () => {
  const f = fixture();
  expect(original.length).toBe(4607);
  expect(hash(original)).toBe('2fdf0ece590925869fe25ae941301894f8f4505da6674302df25d5c4546fddbc');
  const missing = cli('scope', f.source);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('Expected one Implementation plan section');
  const initialized = invoke('init', f.source, f.source, f.restore);
  expect(initialized.activePlan).toBe(f.source);
  expect(initialized.originalBytes).toBe(4607);
  expect(initialized.originalSha256).toBe(hash(original));
  expect(readFileSync(f.restore)).toEqual(original);
  expect(initialized.scope.sha256).toBe(hash(original));
  expect(initialized.scope.matchCount).toBe(21);
  expect(initialized.scope.dxRequired).toBe(true);
  expect(invoke('scope', f.source)).toEqual(initialized.scope);
  const ceo = invoke('create', 'ceo', f.source, f.restore);
  expect(readFileSync(ceo.snapshotPath)).toEqual(original);
  expect(ceo.nativePrompt.endsWith(original.toString())).toBe(true);
  expect(ceo.nativePrompt).toContain('Mutations already require CSRF tokens');
  expect(ceo.sha256).toBe(initialized.scope.sha256);
  expect(invoke('check', 'ceo', f.source, ceo.snapshotPath, 'unchanged').changed).toBe(false);
});

test('assigned active path preserves the separate original source and exact restore', () => {
  for (const emptyAssigned of [false, true]) {
    const f = fixture();
    if (emptyAssigned) writeFileSync(f.active, '');
    const sourceMtime = statSync(f.source).mtimeMs;
    const initialized = invoke('init', f.source, f.active, f.restore);
    expect(initialized.activePlan).toBe(f.active);
    expect(initialized.restorePath).toBe(f.restore);
    expect(readFileSync(f.source)).toEqual(original);
    expect(statSync(f.source).mtimeMs).toBe(sourceMtime);
    expect(readFileSync(f.restore)).toEqual(original);
    expect(readFileSync(f.active, 'utf8')).toContain('## Implementation plan\n' + original.toString());
    expect(readdirSync(f.dir).sort()).toEqual(['assigned plan.md', 'restore point.md', 'source plan.md']);
  }
});

test('the observed missing harness plans directory is initialized without a separate mkdir step', () => {
  const f = fixture();
  const active = join(f.dir, 'harness', 'plans', 'assigned.md');
  const restore = join(f.dir, 'state', 'project', 'restore.md');
  const initialized = invoke('init', f.source, active, restore);
  expect(initialized.activePlan).toBe(active);
  expect(initialized.restorePath).toBe(restore);
  expect(initialized.scope.dxRequired).toBe(true);
  expect(readFileSync(f.source)).toEqual(original);
  expect(readFileSync(restore)).toEqual(original);
  expect(invoke('init', f.source, active, restore).reused).toBe(true);
});

test('same initialization is idempotent but later amendments never get reset', () => {
  for (const separate of [false, true]) {
    const f = fixture(); const active = separate ? f.active : f.source;
    invoke('init', f.source, active, f.restore);
    const bytes = readFileSync(active); const backup = readFileSync(f.restore);
    const stamp = statSync(active).mtimeMs; const backupStamp = statSync(f.restore).mtimeMs;
    expect(invoke('init', f.source, active, f.restore).reused).toBe(true);
    expect(readFileSync(active)).toEqual(bytes);
    expect(statSync(active).mtimeMs).toBe(stamp);
    expect(statSync(f.restore).mtimeMs).toBe(backupStamp);
    writeFileSync(active, bytes.toString() + 'Accepted review decision.\n');
    const changed = readFileSync(active);
    const retry = cli('init', f.source, active, f.restore);
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain('Existing restore does not match');
    expect(readFileSync(active)).toEqual(changed);
    expect(readFileSync(f.restore)).toEqual(backup);
  }
});

test('already structured input keeps the review record separate from blind inputs', () => {
  const f = fixture();
  const body = 'API and endpoint.\n> ## Review record\n```text\n## Review record\n```\n';
  const source = `# Earlier plan\n## Implementation plan\n${body}## Review record\nPrivate earlier review\n`;
  writeFileSync(f.source, source);
  const initialized = invoke('init', f.source, f.active, f.restore);
  expect(readFileSync(f.source, 'utf8')).toBe(source);
  expect(readFileSync(f.restore, 'utf8')).toBe(source);
  expect(readFileSync(f.active, 'utf8')).toContain('## Review record\nPrivate earlier review');
  expect(initialized.scope.sha256).toBe(hash(body));
  const ceo = invoke('create', 'ceo', f.active, f.restore);
  expect(readFileSync(ceo.snapshotPath, 'utf8')).toBe(body);
  expect(ceo.nativePrompt).not.toContain('Private earlier review');
});

test('invalid or ambiguous input fails without publishing any backup or active plan', () => {
  for (const source of [Buffer.from(''), Buffer.from([0xff, 0xfe]),
    Buffer.from('## Implementation plan\nMissing review boundary\n'),
    Buffer.from('## Review record\nPrivate audit\n'),
    Buffer.from('```text\nUnclosed fence\n'),
    Buffer.from('## Implementation plan\nAPI\n## Review record\nAudit\n## Review record\nAgain\n')]) {
    const f = fixture(); writeFileSync(f.source, source);
    const result = cli('init', f.source, f.active, f.restore);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(readFileSync(f.source)).toEqual(source);
    expect(readdirSync(f.dir)).toEqual(['source plan.md']);
  }
});

test('existing foreign destinations, symlinks and path aliases cannot be overwritten', () => {
  for (const kind of ['active-content', 'restore-content', 'active-link', 'restore-link', 'hardlink', 'restore-is-source', 'same-destinations', 'relative']) {
    const f = fixture(); let active = f.active; let restore = f.restore;
    if (kind === 'active-content') writeFileSync(active, 'Other assigned work');
    if (kind === 'restore-content') writeFileSync(restore, 'Existing history');
    if (kind === 'active-link') symlinkSync('missing', active);
    if (kind === 'restore-link') symlinkSync('missing', restore);
    if (kind === 'hardlink') linkSync(f.source, active);
    if (kind === 'restore-is-source') restore = f.source;
    if (kind === 'same-destinations') restore = active;
    if (kind === 'relative') active = 'relative.md';
    const entries = readdirSync(f.dir).sort();
    const result = cli('init', f.source, active, restore);
    expect(result.status, kind).toBe(1);
    expect(result.stdout).toBe('');
    expect(readdirSync(f.dir).sort()).toEqual(entries);
    expect(readFileSync(f.source)).toEqual(original);
    if (kind === 'active-content') expect(readFileSync(active, 'utf8')).toBe('Other assigned work');
    if (kind === 'restore-content') expect(readFileSync(restore, 'utf8')).toBe('Existing history');
  }
});

test('line endings and Unicode survive normalization; only a missing final separator LF is added', () => {
  for (const text of ['最後の API 要件 🧪\r\nREST must remain.\r\n', 'API and endpoint without final newline']) {
    const f = fixture(); const restore = join(f.dir, 'restore -- quoted "名前".md');
    writeFileSync(f.source, text);
    invoke('init', f.source, f.active, restore);
    expect(readFileSync(restore, 'utf8')).toBe(text);
    const ceo = invoke('create', 'ceo', f.active, restore);
    expect(readFileSync(ceo.snapshotPath, 'utf8')).toBe(text + (text.endsWith('\n') ? '' : '\n'));
    expect(invoke('init', f.source, f.active, restore).reused).toBe(true);
  }
});

test('staging failure cleans owned temporary files without changing source or active bytes', () => {
  const f = fixture();
  const active = join(f.dir, 'harness', 'plans', 'assigned.md');
  const restore = join(f.dir, 'state', 'project', 'restore.md');
  const worker = join(f.dir, 'fail-stage.ts');
  writeFileSync(worker, `import { mock } from 'bun:test';
const real = { ...await import('node:fs') };
mock.module('node:fs', () => ({ ...real, mkdtempSync(prefix, options) {
  if (String(prefix).includes('.gstack-autoplan-restore-')) throw new Error('Injected restore staging failure');
  return real.mkdtempSync(prefix, options);
} }));
const { initializePlan } = await import(${JSON.stringify(TOOL)});
try { initializePlan(...process.argv.slice(2)); process.exitCode = 5; }
catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  const result = spawnSync(process.execPath, [worker, f.source, active, restore], {
    encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Injected restore staging failure');
  expect(readFileSync(f.source)).toEqual(original);
  expect(readdirSync(f.dir).sort()).toEqual(['fail-stage.ts', 'source plan.md']);
  expect(existsSync(active)).toBe(false);
  expect(existsSync(restore)).toBe(false);
});
