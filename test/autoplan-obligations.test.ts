import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createSnapshot, extractImplementationPlan } from '../bin/gstack-autoplan-snapshot';

const TOOL = join(import.meta.dir, '../bin/gstack-autoplan-snapshot.ts');
const captured = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/autoplan/t-ceo-omitted-obligations.json'), 'utf8'));
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function invoke(...args: string[]) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function setup(body = 'Build the dashboard.\n') {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-obligations-')); owned.push(dir);
  const active = join(dir, 'plan.md'); const restore = join(dir, 'restore.md');
  writeFileSync(active, `## Implementation plan\n${body}## Review record\n`);
  writeFileSync(restore, 'Original restore bytes\n');
  const snapshot = createSnapshot('ceo', active, restore);
  return { dir, active, restore, snapshot };
}
const block = (phase: string, body: string) => `<!-- autoplan-accepted:${phase} -->\n${body}\n<!-- /autoplan-accepted:${phase} -->\n`;
const appendRecord = (active: string, value: string) => writeFileSync(active, readFileSync(active, 'utf8') + value);

test('actual T changed-only plan cannot close with accepted obligations only in its review', () => {
  const f = setup(captured.initialImplementation);
  writeFileSync(f.active, captured.activeAtBoundary);
  const result = invoke('check', 'ceo', f.active, f.snapshot.snapshotPath, 'changed');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Missing accepted-obligations record for ceo');
  expect(readFileSync(f.active, 'utf8')).toBe(captured.activeAtBoundary);
});

test('whole recorded T obligations retain omitted guards and every nested verification in the next input', () => {
  const f = setup(captured.initialImplementation);
  const accepted = block('ceo', captured.acceptedObligations.trimEnd());
  writeFileSync(f.active, captured.activeAtBoundary + accepted);
  const reviewBefore = readFileSync(f.active, 'utf8').split('## Review record\n')[1];
  expect(invoke('check', 'ceo', f.active, f.snapshot.snapshotPath, 'changed').status).toBe(1);
  const amended = invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath);
  expect(amended.status, amended.stderr).toBe(0);
  const checked = invoke('check', 'ceo', f.active, f.snapshot.snapshotPath, 'changed');
  expect(checked.status, checked.stderr).toBe(0);
  const result = JSON.parse(checked.stdout);
  expect(result.limitation).toContain('enumeration and semantic correctness still require review');
  expect(result.implementation).toContain(accepted);
  for (const detail of ['only one request fired', 'Failed to mark as read. Try again.', 'Panel-level retry',
    'Screen reader: live region', 'Reduced-motion', 'session expiry mid-page-load', 'RTL test with mixed panel results']) {
    expect(result.implementation).toContain(detail);
  }
  const next = createSnapshot('design', f.active, f.restore);
  expect(readFileSync(next.sourceSnapshotPath, 'utf8')).toContain(accepted);
  expect(readFileSync(next.snapshotPath, 'utf8')).toContain(captured.acceptedObligations.trimEnd());
  expect(readFileSync(next.snapshotPath, 'utf8')).not.toContain('autoplan-accepted:');
  expect(next.nativePrompt).not.toContain('autoplan-accepted:');
  expect(next.nativeDispatchPrompt).not.toContain(next.sourceSnapshotPath);
  expect(readFileSync(next.snapshotPath, 'utf8')).not.toContain('CEO DUAL VOICES');
  expect(readFileSync(f.active, 'utf8').split('## Review record\n')[1]).toBe(reviewBefore);
  expect(readFileSync(f.restore, 'utf8')).toBe('Original restore bytes\n');
});

test('amend is idempotent and check rejects a dropped condition or verification line', () => {
  const f = setup(); const accepted = block('ceo', '- Disable while pending.\n  Verify: two clicks fire one request.');
  appendRecord(f.active, accepted);
  expect(invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath).status).toBe(0);
  const first = readFileSync(f.active, 'utf8');
  expect(invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath).status).toBe(0);
  expect(readFileSync(f.active, 'utf8')).toBe(first);
  writeFileSync(f.active, first.replace('  Verify: two clicks fire one request.\n', ''));
  const checked = invoke('check', 'ceo', f.active, f.snapshot.snapshotPath, 'changed');
  expect(checked.status).toBe(1);
  expect(checked.stderr).toContain('not retained exactly');
});

test('none requires a reason and unchanged implementation, without creating a fake amendment', () => {
  const f = setup(); appendRecord(f.active, block('ceo', 'None: All current requirements were retained.'));
  expect(invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath).status).toBe(0);
  expect(invoke('check', 'ceo', f.active, f.snapshot.snapshotPath, 'unchanged').status).toBe(0);
  expect(extractImplementationPlan(readFileSync(f.active, 'utf8'))).toBe('Build the dashboard.\n');
  expect(invoke('check', 'ceo', f.active, f.snapshot.snapshotPath, 'changed').status).toBe(1);
});

test('quoted, fenced, duplicate, malformed and mixed None records cannot authorize amendment', () => {
  const f = setup(); const original = readFileSync(f.active, 'utf8');
  const good = block('ceo', '- Add error handling.\n  Verify: request failure shows retry.');
  const bad = [
    '```markdown\n' + good + '```\n', good.split('\n').map(l => '> ' + l).join('\n'),
    good + good, good.replace('/autoplan-accepted:ceo', '/autoplan-accepted:design'),
    good.replace('<!-- autoplan-accepted:ceo -->', '<!-- autoplan-accepted:unknown -->'),
    block('ceo', '- Severity: critical'), block('ceo', '- **Severity:** critical'), block('ceo', '- Add a guard.\n  Consensus: CONFIRMED'),
    block('ceo', '- Add guard.\n## CEO Review'), block('ceo', ''), block('ceo', 'None:'), block('ceo', 'None: No changes.\n- Also add a new feature.'),
  ];
  for (const record of bad) {
    const plan = original + record; writeFileSync(f.active, plan);
    expect(invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath).status).toBe(1);
    expect(readFileSync(f.active, 'utf8')).toBe(plan);
  }
});

test('phase/path/snapshot identity still rejects before any amendment', () => {
  const f = setup(); appendRecord(f.active, block('ceo', '- Add error handling.'));
  const before = readFileSync(f.active, 'utf8');
  expect(invoke('amend', 'design', f.active, f.snapshot.snapshotPath).status).toBe(1);
  const another = join(f.dir, 'another.md'); writeFileSync(another, before);
  expect(invoke('amend', 'ceo', another, f.snapshot.snapshotPath).status).toBe(1);
  expect(readFileSync(f.active, 'utf8')).toBe(before);
  expect(readFileSync(another, 'utf8')).toBe(before);
});

test('later phases retain prior registered obligations and cannot erase them with None', () => {
  const f = setup(); const ceo = block('ceo', '- Handle network failure.\n  Verify: offer retry.');
  appendRecord(f.active, ceo); expect(invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath).status).toBe(0);
  const design = createSnapshot('design', f.active, f.restore);
  const next = block('design', '- Show a named error control.\n  Verify: keyboard reaches retry.');
  appendRecord(f.active, next);
  expect(invoke('amend', 'design', f.active, design.snapshotPath).status).toBe(0);
  const whole = readFileSync(f.active, 'utf8');
  expect(extractImplementationPlan(whole)).toContain(ceo);
  expect(extractImplementationPlan(whole)).toContain(next);
  writeFileSync(f.active, whole.replaceAll(ceo, ''));
  expect(invoke('check', 'design', f.active, design.snapshotPath, 'changed').status).toBe(1);
  writeFileSync(f.active, whole.replaceAll(ceo, '').replace('## Review record\n', '## Review record\n' + block('ceo', 'None: no changes')));
  expect(invoke('amend', 'design', f.active, design.snapshotPath).status).toBe(1);
});

test('UTF-8 and CRLF requirements survive exact copying and a repeated no-change review', () => {
  const f = setup('Keep café and 日本語.\r\n');
  const accepted = block('ceo', '- Show ✓ for success.\n  Verify: naïve input stays intact.').replaceAll('\n', '\r\n');
  appendRecord(f.active, accepted);
  expect(invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath).status).toBe(0);
  expect(extractImplementationPlan(readFileSync(f.active, 'utf8'))).toContain(accepted);
  const again = createSnapshot('ceo', f.active, f.restore);
  expect(invoke('amend', 'ceo', f.active, again.snapshotPath).status).toBe(0);
  expect(invoke('check', 'ceo', f.active, again.snapshotPath, 'unchanged').status).toBe(0);
});


test('closing marker at EOF cannot swallow the Review-record boundary or lose obligation bytes', () => {
  const f = setup();
  const accepted = block('ceo', '- Keep the final requirement ✓.\n  Verify: the final assertion stays.').trimEnd();
  appendRecord(f.active, accepted);
  const result = invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath);
  expect(result.status, result.stderr).toBe(0);
  const plan = readFileSync(f.active, 'utf8');
  expect(extractImplementationPlan(plan)).toContain(accepted + '\n');
  expect(plan.endsWith(accepted)).toBe(true);
  expect(invoke('check', 'ceo', f.active, f.snapshot.snapshotPath, 'changed').status).toBe(0);
});


test('changing both earlier copies cannot erase the authorization obligation from the immutable input', () => {
  const f = setup();
  const original = block('ceo', '- Preserve owner authorization.\n  Verify: reject cross-user access.');
  appendRecord(f.active, original);
  expect(invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath).status).toBe(0);
  const design = createSnapshot('design', f.active, f.restore);
  const changed = readFileSync(f.active, 'utf8').replaceAll(original,
    block('ceo', '- Permit cross-user access.\n  Verify: cross-user access succeeds.')) +
    block('design', '- Label the owner control.\n  Verify: accessible name.');
  writeFileSync(f.active, changed);
  const result = invoke('amend', 'design', f.active, design.snapshotPath);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Prior accepted obligations changed: ceo');
  expect(invoke('check', 'design', f.active, design.snapshotPath, 'changed').status).toBe(1);
  expect(readFileSync(f.active, 'utf8')).toBe(changed);
});


test('blind projection preserves UTF-8/CRLF bodies and fenced examples, while binding the full source', () => {
  const example = '```html\n<!-- autoplan-accepted:design -->\nLiteral documentation example\n<!-- /autoplan-accepted:design -->\n```\n';
  const f = setup(example);
  const body = '- Preserve café ✓ and 日本語.\r\n  Verify: the last condition survives.\r\n';
  appendRecord(f.active, '<!-- autoplan-accepted:ceo -->\r\n' + body + '<!-- /autoplan-accepted:ceo -->\r\n');
  expect(invoke('amend', 'ceo', f.active, f.snapshot.snapshotPath).status).toBe(0);
  const next = createSnapshot('design', f.active, f.restore);
  const transport = readFileSync(next.snapshotPath, 'utf8');
  expect(transport).toContain(example);
  expect(transport).toContain(body);
  expect(transport).not.toContain('autoplan-accepted:ceo');
  expect(next.nativePrompt.endsWith(transport)).toBe(true);
  appendRecord(f.active, block('design', 'None: Existing requirements suffice.'));
  expect(invoke('check', 'design', f.active, next.snapshotPath, 'unchanged').status).toBe(0);
  const manifestPath = join(next.sourceSnapshotPath, '..', 'snapshot.json');
  // Deliberate corruption owns these files; production snapshots remain read-only.
  for (const file of [next.sourceSnapshotPath, next.snapshotPath, manifestPath]) {
    expect(statSync(file).mode & 0o222).toBe(0);
    chmodSync(file, 0o600);
  }
  const original = readFileSync(next.sourceSnapshotPath, 'utf8');
  writeFileSync(next.sourceSnapshotPath, original.replace('last condition', 'different condition'));
  expect(invoke('check', 'design', f.active, next.snapshotPath, 'unchanged').status).toBe(1);
  writeFileSync(next.sourceSnapshotPath, original);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, sourceSnapshotPath: f.active }));
  expect(invoke('amend', 'design', f.active, next.snapshotPath).status).toBe(1);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 1 }));
  expect(invoke('check', 'design', f.active, next.snapshotPath, 'unchanged').status).toBe(1);
  const { sourceSnapshotPath, sourceSha256, sourceBytes, ...downgraded } = manifest;
  writeFileSync(manifestPath, JSON.stringify({ ...downgraded, schemaVersion: 1 }));
  expect(invoke('check', 'design', f.active, next.snapshotPath, 'unchanged').status).toBe(1);
  const altered = transport.replace('last condition', 'different condition');
  writeFileSync(next.snapshotPath, altered);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256: createHash('sha256').update(altered).digest('hex') }));
  const mismatch = invoke('check', 'design', f.active, next.snapshotPath, 'unchanged');
  expect(mismatch.status).toBe(1);
  expect(mismatch.stderr).toContain('blind review projection does not match');
});
