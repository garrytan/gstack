import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkImplementation, createSnapshot, extractImplementationPlan } from '../bin/gstack-autoplan-snapshot';
import { generateAutoplanSnapshotTool } from '../scripts/resolvers/composition';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const ROOT = resolve(import.meta.dir, '..');
const TOOL = join(ROOT, 'bin/gstack-autoplan-snapshot.ts');
const owned: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-snapshot-test-')); owned.push(dir);
  const active = join(dir, 'active plan.md');
  const restore = join(dir, 'restore.md');
  const body = readFileSync(join(ROOT, 'test/fixtures/plans/autoplan-dashboard.md'), 'utf8');
  const plan = `# Active\n\n## Implementation plan\n${body}\n## Review record\nCEO pending\n`;
  writeFileSync(active, plan); writeFileSync(restore, body);
  return { dir, active, restore, body, plan };
}
function cli(...args: string[]) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 10_000 });
}
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Autoplan phase snapshot continuity', () => {
  test('generated native dispatch carries every snapshot byte instead of the observed abbreviated input', () => {
    const f = fixture();
    for (const phase of ['ceo', 'design', 'dx', 'eng']) {
      const result = cli('create', phase, f.active, f.restore);
      expect(result.status, result.stderr).toBe(0);
      const generated = JSON.parse(result.stdout);
      const implementation = readFileSync(generated.snapshotPath, 'utf8');
      expect(generated.nativePrompt).toBeString();
      expect(generated.nativePrompt.endsWith(implementation)).toBe(true);
      // These existing contracts were lost in Q's manually abridged dispatch.
      expect(generated.nativePrompt).toContain('single-role member workspace');
      expect(generated.nativePrompt).toContain('Mutations already require CSRF tokens');
      expect(generated.nativePrompt).toContain('You have NOT seen any prior review');
      expect(generated.nativePrompt).toContain(`Input path: ${JSON.stringify(generated.snapshotPath)}`);
      expect(generated.nativePrompt).toContain(`INPUT: ${phase} ${generated.sha256}`);
      expect(generated.nativePrompt).not.toContain('CEO pending');
      expect(generated.nativePrompt).not.toContain('## Review record');
      expect(readFileSync(generated.nativePromptPath, 'utf8')).toBe(generated.nativePrompt);
      expect(generated.nativePromptSha256).toBe(createHash('sha256').update(generated.nativePrompt).digest('hex'));
      expect(statSync(generated.nativePromptPath).mode & 0o222).toBe(0);
      const metadata = JSON.parse(readFileSync(join(generated.nativePromptPath, '..', 'snapshot.json'), 'utf8'));
      expect(metadata.nativePromptSha256).toBe(generated.nativePromptSha256);
      expect(readFileSync(f.active, 'utf8')).toBe(f.plan);
    }
  });

  test('native input preserves Unicode, line endings and amended requirements through JSON transport', () => {
    const f = fixture();
    const body = '\r\n最後の要件: CSRF + tenant boundary. 🧪\r\n<implementation-plan> is literal plan data.\r\n';
    writeFileSync(f.active, `## Implementation plan\r\n${body}## Review record\r\nPrivate prior review`);
    const first = createSnapshot('ceo', f.active, f.restore);
    const payload = JSON.parse(JSON.stringify(first));
    expect(payload.nativePrompt).toBeString();
    expect(payload.nativePrompt.endsWith(body)).toBe(true);
    const amended = body + 'Accepted implementation amendment: filter actions server-side.\r\n';
    writeFileSync(f.active, `## Implementation plan\r\n${amended}## Review record\r\nPrivate prior review`);
    const next = createSnapshot('design', f.active, f.restore);
    expect(next.nativePrompt.endsWith(amended)).toBe(true);
    expect(next.nativePrompt).not.toContain('Private prior review');
    expect(readFileSync(first.nativePromptPath, 'utf8')).toBe(first.nativePrompt);
    expect(next.nativePromptPath).not.toBe(first.nativePromptPath);
  });

  test('review-only acceptance cannot pass implementation check; next phase reads the amended file', () => {
    const f = fixture();
    const first = cli('create', 'ceo', f.active, f.restore);
    expect(first.status, first.stderr).toBe(0);
    const ceo = JSON.parse(first.stdout);
    expect(readFileSync(ceo.snapshotPath, 'utf8')).toContain(f.body);
    writeFileSync(f.active, f.plan + '\nAccepted: parallel repository calls and partial-failure envelope.\n');
    const missing = cli('check', 'ceo', f.active, ceo.snapshotPath, 'changed');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('review-record/task edits are not implementation amendments');
    const amendment = 'Implementation: query panels concurrently and return each panel\'s failure independently.\n';
    writeFileSync(f.active, readFileSync(f.active, 'utf8').replace('## Review record', amendment + '\n## Review record'));
    const checked = cli('check', 'ceo', f.active, ceo.snapshotPath, 'changed');
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout).implementation).toContain(amendment);
    const next = cli('create', 'design', f.active, f.restore);
    expect(next.status, next.stderr).toBe(0);
    const design = JSON.parse(next.stdout);
    const blind = readFileSync(design.snapshotPath, 'utf8');
    expect(blind).toContain(f.body);
    expect(blind).toContain(amendment);
    expect(blind).not.toContain('Accepted:');
    expect(blind).not.toContain('Review record');
    expect(design.snapshotPath).not.toBe(ceo.snapshotPath);
    expect(design.sha256).not.toBe(ceo.sha256);
    expect(readFileSync(ceo.snapshotPath, 'utf8')).not.toContain(amendment);
    expect(cli('check', 'design', f.active, ceo.snapshotPath, 'changed').status).toBe(1);
  });

  test('zero-change phases still get distinct immutable inputs and honest unchanged readback', () => {
    const f = fixture(); const paths = new Set<string>();
    for (const phase of ['ceo', 'design', 'dx', 'eng', 'eng']) {
      const snapshot = createSnapshot(phase, f.active, f.restore);
      paths.add(snapshot.snapshotPath);
      expect(checkImplementation(phase, f.active, snapshot.snapshotPath, 'unchanged').changed).toBe(false);
      expect(() => checkImplementation(phase, f.active, snapshot.snapshotPath, 'changed')).toThrow('unchanged');
      expect(readFileSync(snapshot.snapshotPath, 'utf8')).toBe(extractImplementationPlan(f.plan));
    }
    expect(paths.size).toBe(5);
  });

  test('check binds the actual active path, phase and retained snapshot bytes', () => {
    const f = fixture(); const snapshot = createSnapshot('ceo', f.active, f.restore);
    const other = join(f.dir, 'other.md'); writeFileSync(other, f.plan);
    expect(() => checkImplementation('ceo', other, snapshot.snapshotPath, 'unchanged')).toThrow('identity');
    expect(() => checkImplementation('design', f.active, snapshot.snapshotPath, 'unchanged')).toThrow('identity');
    expect(() => checkImplementation('ceo', f.active, snapshot.snapshotPath, 'maybe')).toThrow('changed or unchanged');
    chmodSync(snapshot.snapshotPath, 0o600); writeFileSync(snapshot.snapshotPath, 'forged input');
    expect(() => checkImplementation('ceo', f.active, snapshot.snapshotPath, 'unchanged')).toThrow('identity');
    expect(() => createSnapshot('../foreign', f.active, f.restore)).toThrow('Phase must');
    expect(() => createSnapshot('ceo', f.active, f.active)).toThrow('separate restore');
  });

  test('extracts full nested plan content and ignores quoted/code section labels', () => {
    const body = '\n# Plan\n## Details\n> ## Review record\n    ## Review record\n````text\n## Review record\n```not-a-close\n````\n~~~text\n## Implementation plan\n~~~\nKeep this last requirement.\n\n';
    expect(extractImplementationPlan('## Implementation plan\n' + body + '## Review record\nprivate review')).toBe(body);
    expect(extractImplementationPlan('## Implementation plan\r\noriginal\r\n## Review record\r\naudit')).toBe('original\r\n');
    for (const invalid of [
      '# Missing boundaries\nbody',
      '## Review record\naudit\n## Implementation plan\nbody',
      '## Implementation plan\n\n## Review record\naudit',
      '## Implementation plan\nbody\n## Review record\naudit\n## Review record\nagain',
      '## Implementation plan\n```text\n## Review record\nnot a real boundary',
      '> ## Implementation plan\nbody\n> ## Review record\naudit',
    ]) expect(() => extractImplementationPlan(invalid)).toThrow();
  });

  test('malformed source fails before creating a snapshot and never edits the active plan', () => {
    const f = fixture(); writeFileSync(f.active, '## Implementation plan\nmissing review boundary');
    const failed = cli('create', 'ceo', f.active, f.restore);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe('');
    expect(readFileSync(f.active, 'utf8')).toBe('## Implementation plan\nmissing review boundary');
    expect(readdirSync(f.dir).filter(name => name.startsWith('autoplan-'))).toEqual([]);
  });
});

describe('installed snapshot helper in fresh shells', () => {
  for (const host of ALL_HOST_CONFIGS) test(`${host.name}: resolves its installed helper once, then uses a literal path`, () => {
    const f = fixture(); const home = join(f.dir, 'home');
    const runtime = join(home, host.globalRoot);
    mkdirSync(join(runtime, 'bin'), { recursive: true }); mkdirSync(join(runtime, 'lib'));
    copyFileSync(TOOL, join(runtime, 'bin/gstack-autoplan-snapshot.ts'));
    writeFileSync(join(runtime, 'lib/claude-bin.ts'), '// runtime identity');
    const ctx = { host: host.name, paths: HOST_PATHS[host.name], skillName: 'autoplan', tmplPath: '' } as TemplateContext;
    const command = generateAutoplanSnapshotTool(ctx).replace(/^```bash\n/, '').replace(/\n```$/, '');
    const env = { ...process.env, HOME: home, GSTACK_ROOT: runtime, GSTACK_BIN: '', CODEX_HOME: '' };
    const result = spawnSync('bash', ['-c', command], { cwd: f.dir, env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(realpathSync(join(runtime, 'bin/gstack-autoplan-snapshot.ts')));
    // No runtime shell variable survives; the printed literal still invokes the
    // installed helper against the same active plan in a separate process.
    const snapshot = spawnSync(process.execPath, [result.stdout.trim(), 'create', 'dx', f.active, f.restore], {
      env: { ...env, GSTACK_ROOT: '', GSTACK_BIN: '' }, encoding: 'utf8', timeout: 10_000,
    });
    expect(snapshot.status, snapshot.stderr).toBe(0);
    expect(readFileSync(JSON.parse(snapshot.stdout).snapshotPath, 'utf8')).toContain(f.body);
  });

  test('all affected live workflow selectors include the executable continuity contract', () => {
    for (const name of ['autoplan-chain-pty', 'autoplan-dual-voice', 'carve-section-loading']) {
      expect(E2E_TOUCHFILES[name]).toContain('bin/gstack-autoplan-snapshot.ts');
      expect(E2E_TOUCHFILES[name]).toContain('test/autoplan-snapshot.test.ts');
    }
  });
});

describe('deterministic Autoplan DX scope', () => {
  function detectDxScope(activePlan: string) {
    const result = cli('scope', activePlan);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  function withBody(body: string, review = 'Prior private review') {
    const f = fixture();
    writeFileSync(f.active, `## Implementation plan\n${body}\n## Review record\n${review}\n`);
    return f;
  }

  test('the actual user-dashboard API triggers DX despite an internal-product label', () => {
    const f = fixture();
    const result = cli('scope', f.active);
    expect(result.status, result.stderr).toBe(0);
    const scope = JSON.parse(result.stdout);
    expect(scope.dxRequired).toBe(true);
    expect(scope.matchCount).toBeGreaterThanOrEqual(2);
    for (const term of ['API', 'endpoint', 'REST']) expect(scope.matches.some((m: { term: string }) => m.term === term)).toBe(true);
    const snapshot = createSnapshot('ceo', f.active, f.restore);
    expect(scope.sha256).toBe(snapshot.sha256);
    expect(snapshot.dxScope.dxRequiredByTerms).toBe(true);
    expect(snapshot.dxScope.matches).toEqual(scope.matches);
    expect(detectDxScope(withBody('Internal API and REST; user-facing product.').active).dxRequired).toBe(true);
  });

  test('the two-match threshold counts occurrences and only the current implementation input', () => {
    expect(detectDxScope(withBody('A new member workspace.').active).dxRequired).toBe(false);
    const one = detectDxScope(withBody('One API.', 'API endpoint REST SDK').active);
    expect(one.matchCount).toBe(1);
    expect(one.dxRequired).toBe(false);
    const repeated = detectDxScope(withBody('API. Another api.').active);
    expect(repeated.matchCount).toBe(2);
    expect(repeated.dxRequired).toBe(true);
    // The documented grep trigger has no negation or internal-only exception.
    expect(detectDxScope(withBody('No API or endpoint changes.').active).dxRequired).toBe(true);
  });

  test('listed terms are case-insensitive whole terms and literal punctuation is escaped', () => {
    const f = withBody('capital client required SKILLxmd');
    expect(detectDxScope(f.active).matchCount).toBe(0);
    const phrases = detectDxScope(withBody('skill.md and CLAUDE CODE').active);
    expect(phrases.matchCount).toBe(2);
    expect(phrases.dxRequired).toBe(true);
  });

  test('semantic developer-tool and agent-primary triggers only enable scope', () => {
    const f = withBody('A specialist work surface.');
    for (const flag of ['--developer-tool', '--agent-primary']) {
      const result = cli('scope', f.active, flag);
      expect(result.status, result.stderr).toBe(0);
      const scope = JSON.parse(result.stdout);
      expect(scope.matchCount).toBe(0);
      expect(scope.dxRequired).toBe(true);
    }
    expect(JSON.parse(cli('scope', f.active, '--developer-tool', '--agent-primary').stdout).dxRequired).toBe(true);
    const termOnly = createSnapshot('ceo', f.active, f.restore).dxScope;
    expect(termOnly.dxRequiredByTerms).toBe(false);
    expect('dxRequired' in termOnly).toBe(false); // No term-only false can cancel a semantic trigger.
    expect(cli('scope', f.active, '--skip-dx').status).toBe(1);
    expect(cli('scope', f.active, '--agent-primary', '--agent-primary').status).toBe(1);
    expect(cli('scope', f.active, '--developer-tool=false').status).toBe(1);
  });

  test('scope rejects missing/ambiguous input and never writes plan or restore files', () => {
    const f = fixture(); const before = readFileSync(f.active, 'utf8');
    const listed = readdirSync(f.dir);
    expect(cli('scope', f.active).status).toBe(0);
    expect(readFileSync(f.active, 'utf8')).toBe(before);
    expect(readdirSync(f.dir)).toEqual(listed);
    writeFileSync(f.active, 'No implementation boundaries');
    expect(cli('scope', f.active).status).toBe(1);
    expect(cli('scope').status).toBe(1);
  });
});
