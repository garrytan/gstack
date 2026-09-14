import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkImplementation, createSnapshot, prepareMethodology, extractImplementationPlan } from '../bin/gstack-autoplan-snapshot';
import { generateAutoplanSnapshotTool } from '../scripts/resolvers/composition';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { ALL_HOST_CONFIGS } from '../hosts';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const ROOT = resolve(import.meta.dir, '..');
const TOOL = join(ROOT, 'bin/gstack-autoplan-snapshot.ts');
function methodology(phase: string, restore: string) {
  return prepareMethodology(phase, join(import.meta.dir, '..', `plan-${phase === 'dx' ? 'devex' : phase}-review`, 'SKILL.md'), restore).methodologyPath;
}
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
  if (args[0] === 'create' && args.length === 4) args.push(methodology(args[1]!, args[3]!));
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 10_000 });
}
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });


describe('methodology preparation is a required snapshot input', () => {
  test('all phases return an exact contiguous schedule through the final partial chunk', () => {
    const f = fixture();
    for (const phase of ['ceo', 'design', 'dx', 'eng']) {
      const skill = join(ROOT, `plan-${phase === 'dx' ? 'devex' : phase}-review`, 'SKILL.md');
      const method = prepareMethodology(phase, skill, f.restore);
      const lines = readFileSync(method.methodologyPath, 'utf8').split('\n');
      expect(method.readRanges.length).toBeGreaterThan(1);
      let next = 1;
      const delivered: string[] = [];
      for (const range of method.readRanges) {
        expect(range.offset).toBe(next);
        expect(range.limit).toBeGreaterThan(0);
        expect(range.limit).toBeLessThanOrEqual(600);
        expect(range.endLine).toBe(range.offset + range.limit - 1);
        delivered.push(...lines.slice(range.offset - 1, range.endLine));
        next = range.endLine + 1;
      }
      expect(next).toBe(method.lines + 1);
      expect(delivered.join('\n')).toBe(readFileSync(method.methodologyPath, 'utf8'));
      expect(method.readRanges.at(-1)!.limit).toBe((method.lines - 1) % 600 + 1);
    }
  });

  test('actual Y three-argument create cannot return a native dispatch for any phase', () => {
    const f = fixture();
    const before = readdirSync(f.dir).sort();
    for (const phase of ['ceo', 'design', 'dx', 'eng']) {
      const result = spawnSync(process.execPath, [TOOL, 'create', phase, f.active, f.restore], {
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status, phase).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('METHODOLOGY_PATH');
      expect(() => createSnapshot(phase, f.active, f.restore, undefined as unknown as string)).toThrow('METHODOLOGY_PATH');
    }
    expect(readdirSync(f.dir).sort()).toEqual(before);
    expect(readFileSync(f.active, 'utf8')).toBe(f.plan);
    expect(readFileSync(f.restore, 'utf8')).toBe(f.body);
  });

  test('main-only, foreign-phase and foreign-restore artifacts fail before publication', () => {
    const f = fixture();
    const otherRestore = join(f.dir, 'other-restore.md'); writeFileSync(otherRestore, f.body);
    const candidates = [join(ROOT, 'plan-ceo-review/SKILL.md'), methodology('design', f.restore), methodology('ceo', otherRestore)];
    for (const candidate of candidates) {
      const before = readdirSync(f.dir).sort();
      expect(() => createSnapshot('ceo', f.active, f.restore, candidate)).toThrow();
      expect(readdirSync(f.dir).sort()).toEqual(before);
    }
    expect(readFileSync(f.active, 'utf8')).toBe(f.plan);
  });

  test('altered manifest identities and bundle bytes cannot authorize snapshot publication', () => {
    for (const kind of ['phase', 'restore', 'hash', 'lines', 'read-ranges', 'source-offset', 'source-hash', 'bundle']) {
      const f = fixture(); const method = methodology('ceo', f.restore);
      const manifestPath = join(method, '..', 'methodology.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (kind === 'bundle') {
        chmodSync(method, 0o600); writeFileSync(method, readFileSync(method, 'utf8') + '\n'); chmodSync(method, 0o444);
      } else {
        if (kind === 'phase') manifest.phase = 'eng';
        if (kind === 'restore') manifest.restoreSha256 = '0'.repeat(64);
        if (kind === 'hash') manifest.sha256 = '0'.repeat(64);
        if (kind === 'lines') manifest.lines--;
        if (kind === 'read-ranges') manifest.readRanges.pop();
        if (kind === 'source-offset') manifest.sources[0].startByte++;
        if (kind === 'source-hash') manifest.sources[0].sha256 = '0'.repeat(64);
        chmodSync(manifestPath, 0o600); writeFileSync(manifestPath, JSON.stringify(manifest)); chmodSync(manifestPath, 0o444);
      }
      const before = readdirSync(f.dir).sort();
      expect(() => createSnapshot('ceo', f.active, f.restore, method), kind).toThrow();
      expect(readdirSync(f.dir).sort()).toEqual(before);
      expect(readFileSync(f.active, 'utf8')).toBe(f.plan);
      expect(readFileSync(f.restore, 'utf8')).toBe(f.body);
    }
  });

  test('source changes after preparation require a new bundle', () => {
    const f = fixture(); const installed = join(f.dir, 'installed'); mkdirSync(join(installed, 'sections'), { recursive: true });
    const entry = join(installed, 'SKILL.md'); const section = join(installed, 'sections/review-sections.md');
    copyFileSync(join(ROOT, 'plan-ceo-review/SKILL.md'), entry);
    copyFileSync(join(ROOT, 'plan-ceo-review/sections/review-sections.md'), section);
    const method = prepareMethodology('ceo', entry, f.restore).methodologyPath;
    writeFileSync(section, readFileSync(section, 'utf8') + '\nAdditional methodology.\n');
    const before = readdirSync(f.dir).sort();
    expect(() => createSnapshot('ceo', f.active, f.restore, method)).toThrow('changed');
    expect(readdirSync(f.dir).sort()).toEqual(before);
    const fresh = prepareMethodology('ceo', entry, f.restore);
    const result = createSnapshot('ceo', f.active, f.restore, fresh.methodologyPath);
    expect(result.methodology.sha256).toBe(fresh.sha256);
    expect(readFileSync(method, 'utf8')).not.toContain('Additional methodology.');
  });

  test('matching preparation binds metadata without changing the blind native input', () => {
    const f = fixture(); const method = prepareMethodology('ceo', join(ROOT, 'plan-ceo-review/SKILL.md'), f.restore);
    const first = createSnapshot('ceo', f.active, f.restore, method.methodologyPath);
    const next = createSnapshot('ceo', f.active, f.restore, method.methodologyPath);
    expect(first.snapshotPath).not.toBe(next.snapshotPath);
    expect(first.methodology.methodologyPath).toBe(method.methodologyPath);
    expect(first.methodology.sha256).toBe(method.sha256);
    expect(first.methodology.bytes).toBe(method.bytes);
    expect(first.methodology.lines).toBe(method.lines);
    expect(readFileSync(first.snapshotPath, 'utf8')).toBe(extractImplementationPlan(f.plan));
    expect(first.nativePrompt.endsWith(extractImplementationPlan(f.plan))).toBe(true);
    expect(first.nativePrompt).not.toContain(method.methodologyPath);
    expect(first.nativePrompt).not.toContain('CEO pending');
  });

  test('native prompt range reaches Claude Read EOF, including the final empty line', () => {
    const f = fixture();
    // The actual Y child obeyed the old supplied limit and lost only the final LF.
    // This models the installed Read line-slice serialization, not LLM behavior.
    for (const tail of ['Last requirement.\n', 'Last requirement.']) {
      writeFileSync(f.active, `## Implementation plan\n${tail}\n## Review record\n`);
      const result = createSnapshot('ceo', f.active, f.restore, methodology('ceo', f.restore));
      const lines = result.nativePrompt.split('\n');
      const loaded = lines.slice(0, result.nativePromptLines).join('\n');
      expect(loaded).toBe(result.nativePrompt);
      expect(Buffer.byteLength(loaded)).toBe(result.nativePromptBytes);
      expect(lines.slice(0, result.nativePromptLines - 1).join('\n')).not.toBe(result.nativePrompt);
    }
  });
});

describe('Autoplan phase snapshot continuity', () => {
  test('short native dispatch binds the complete immutable file for each phase', () => {
    const f = fixture();
    for (const phase of ['ceo', 'design', 'dx', 'eng']) {
      const result = cli('create', phase, f.active, f.restore);
      expect(result.status, result.stderr).toBe(0);
      const generated = JSON.parse(result.stdout);
      expect(generated.nativeDispatchPrompt).toBeString();
      expect(generated.nativeDispatchPrompt).toContain(`Read file: ${JSON.stringify(generated.nativePromptPath)}`);
      expect(generated.nativeDispatchPrompt).toContain('FIRST tool action');
      expect(generated.nativeDispatchPrompt).toContain('line 1 through EOF');
      expect(generated.nativeDispatchPrompt).toContain('Continue successful ranges until every line is loaded');
      expect(generated.nativeDispatchPrompt).toContain('Execute every criterion');
      expect(generated.nativeDispatchPrompt).toContain(`INPUT: ${phase} ${generated.sha256}`);
      expect(generated.nativeDispatchPrompt).toContain('report the read failure instead of a completed review');
      expect(generated.nativeDispatchPrompt).toContain(generated.nativePromptSha256);
      expect(generated.nativeDispatchPrompt).toContain(`${generated.nativePromptBytes} UTF-8 bytes`);
      expect(generated.nativePromptBytes).toBe(Buffer.byteLength(generated.nativePrompt));
      // Match Claude Read's totalLines, including the empty split after a final LF.
      expect(generated.nativePromptLines).toBe(generated.nativePrompt.split('\n').length);
      expect(generated.nativeDispatchPrompt).not.toContain('Mutations already require CSRF tokens');
      expect(Buffer.byteLength(generated.nativeDispatchPrompt)).toBeLessThan(1600);
      const manifest = JSON.parse(readFileSync(join(generated.nativePromptPath, '..', 'snapshot.json'), 'utf8'));
      expect(manifest.nativeDispatchPrompt).toBe(generated.nativeDispatchPrompt);
      expect(manifest.nativePromptLines).toBe(generated.nativePromptLines);
      expect(manifest.nativePromptBytes).toBe(generated.nativePromptBytes);
    }
  });

  test('a standalone file reader can recover all criteria and late plan bytes from only the dispatch', () => {
    // This is transport evidence with a deterministic child, not evidence that
    // a model followed the instruction. Paid validation must inspect its own child.
    const f = fixture();
    const location = join(f.dir, process.platform === 'win32' ? '資料 with spaces' : '資料 "quoted" with spaces');
    mkdirSync(location);
    const restore = join(location, 'original.md'); writeFileSync(restore, f.body);
    const body = f.body + '\n' + Array.from({ length: 2200 }, (_, i) => `Contract ${i}: preserve the entire input.\r\n`).join('') + 'LAST REQUIREMENT: tenant isolation + CSRF. 🧪\n';
    writeFileSync(f.active, `## Implementation plan\n${body}## Review record\nPRIVATE PRIOR REVIEW\n`);
    const created = cli('create', 'ceo', f.active, restore);
    expect(created.status, created.stderr).toBe(0);
    const generated = JSON.parse(created.stdout);
    expect(generated.nativeDispatchPrompt).toBeString();
    const child = spawnSync(process.execPath, ['-e', `
      const dispatch = await Bun.stdin.text();
      const matched = /^Read file: (.+)$/m.exec(dispatch);
      if (!matched) throw new Error('Dispatch has no complete file path');
      const content = require('node:fs').readFileSync(JSON.parse(matched[1]), 'utf8');
      process.stdout.write(JSON.stringify({ content, bytes: Buffer.byteLength(content),
        sha256: require('node:crypto').createHash('sha256').update(content).digest('hex') }));
    `], { input: generated.nativeDispatchPrompt, encoding: 'utf8', timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    const read = JSON.parse(child.stdout);
    expect(read.content).toBe(generated.nativePrompt);
    expect(read.bytes).toBe(generated.nativePromptBytes);
    expect(read.sha256).toBe(generated.nativePromptSha256);
    expect(read.content.endsWith(body)).toBe(true);
    expect(read.content).toContain('What alternatives were dismissed without sufficient analysis?');
    expect(read.content).toContain('LAST REQUIREMENT: tenant isolation + CSRF. 🧪');
    expect(read.content).not.toContain('PRIVATE PRIOR REVIEW');
    expect(generated.nativePromptLines).toBeGreaterThan(2200);
    expect(generated.nativeDispatchPrompt).toContain(`${generated.nativePromptLines} lines`);
    expect(Buffer.byteLength(generated.nativeDispatchPrompt)).toBeLessThan(1600);
  });

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
    const first = createSnapshot('ceo', f.active, f.restore, methodology('ceo', f.restore));
    const payload = JSON.parse(JSON.stringify(first));
    expect(payload.nativePrompt).toBeString();
    expect(payload.nativePrompt.endsWith(body)).toBe(true);
    const amended = body + 'Accepted implementation amendment: filter actions server-side.\r\n';
    writeFileSync(f.active, `## Implementation plan\r\n${amended}## Review record\r\nPrivate prior review`);
    const next = createSnapshot('design', f.active, f.restore, methodology('design', f.restore));
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
    writeFileSync(f.active, readFileSync(f.active, 'utf8') + '<!-- autoplan-accepted:ceo -->\n- ' + amendment + '<!-- /autoplan-accepted:ceo -->\n');
    const applied = cli('amend', 'ceo', f.active, ceo.snapshotPath);
    expect(applied.status, applied.stderr).toBe(0);
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
      const snapshot = createSnapshot(phase, f.active, f.restore, methodology(phase, f.restore));
      paths.add(snapshot.snapshotPath);
      expect(checkImplementation(phase, f.active, snapshot.snapshotPath, 'unchanged').changed).toBe(false);
      expect(() => checkImplementation(phase, f.active, snapshot.snapshotPath, 'changed')).toThrow('unchanged');
      expect(readFileSync(snapshot.snapshotPath, 'utf8')).toBe(extractImplementationPlan(f.plan));
    }
    expect(paths.size).toBe(5);
  });

  test('check binds the actual active path, phase and retained snapshot bytes', () => {
    const f = fixture(); const snapshot = createSnapshot('ceo', f.active, f.restore, methodology('ceo', f.restore));
    const other = join(f.dir, 'other.md'); writeFileSync(other, f.plan);
    expect(() => checkImplementation('ceo', other, snapshot.snapshotPath, 'unchanged')).toThrow('identity');
    expect(() => checkImplementation('design', f.active, snapshot.snapshotPath, 'unchanged')).toThrow('identity');
    expect(() => checkImplementation('ceo', f.active, snapshot.snapshotPath, 'maybe')).toThrow('changed or unchanged');
    chmodSync(snapshot.snapshotPath, 0o600); writeFileSync(snapshot.snapshotPath, 'forged input');
    expect(() => checkImplementation('ceo', f.active, snapshot.snapshotPath, 'unchanged')).toThrow('identity');
    expect(() => createSnapshot('../foreign', f.active, f.restore, methodology('../foreign', f.restore))).toThrow('Phase must');
    expect(() => createSnapshot('ceo', f.active, f.active, methodology('ceo', f.active))).toThrow('separate restore');
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
    expect(readdirSync(f.dir).filter(name => name.startsWith('autoplan-') && !name.includes('-methodology-'))).toEqual([]);
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
    const snapshot = spawnSync(process.execPath, [result.stdout.trim(), 'create', 'dx', f.active, f.restore, methodology('dx', f.restore)], {
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
    const snapshot = createSnapshot('ceo', f.active, f.restore, methodology('ceo', f.restore));
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
    const termOnly = createSnapshot('ceo', f.active, f.restore, methodology('ceo', f.restore)).dxScope;
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
