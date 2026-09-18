import { expect, test } from 'bun:test';
import captured from './fixtures/plan-count-long-edit-0bcd.json';
import { createPlanCountPermissionGuard, isPermissionDialogVisible } from './helpers/claude-pty-runner';

// Actual 80-row native viewport from the blocked 0bcd DX floor attempt.
// The complete permission pane is visible; only the guard's byte window cropped it.
const screen = captured.screen;
const native = { pendingId: 'session:edit', completedId: null };

test('a complete long native Edit pane retains its heading and one-time permission identity', () => {
  expect(screen.length).toBeGreaterThan(4096);
  expect(screen.slice(-4096)).not.toContain('Edit file');
  expect(isPermissionDialogVisible(screen)).toBe(true);
  const guard = createPlanCountPermissionGuard();
  expect(guard(screen, '', native)).toBe('grant');
  expect(guard(screen, '', native)).toBe('handled');
  expect(guard(screen, '', { ...native, pendingId: 'session:next' })).toBe('handled');
  expect(guard(screen, '', { pendingId: 'session:next', completedId: native.pendingId })).toBe('grant');
});

test('native line endings and pane length do not discard the complete heading', () => {
  const panel = screen.slice(screen.indexOf('Edit file'));
  for (const current of [screen, screen.replaceAll('\n', '\r\n'), panel,
    screen.replace('  74  ', '  74  ' + 'long source line '.repeat(400))]) {
    expect(isPermissionDialogVisible(current)).toBe(true);
    expect(createPlanCountPermissionGuard()(current, '', native)).toBe('grant');
  }
});

test('long diff text cannot substitute for missing, altered, quoted, or foreign permission identity', () => {
  for (const invalid of [
    screen.slice(-4096),
    screen.replace('Edit file\n gstack-test-plan-devex-floor.md', 'Edit file\n foreign.md'),
    screen.replace('❯ 1. Yes', '❯ 1. Yes, approve every edit'),
    screen.replace('Esc to cancel · Tab to amend', ''),
    '```text\n' + screen,
    screen.split('\n').map(row => '> ' + row).join('\n'),
    '☐ Review question\n' + screen,
  ]) expect(createPlanCountPermissionGuard()(invalid, '', native)).not.toBe('grant');
  // A valid display never overrides the owning fixture's rejected path/epoch.
  expect(createPlanCountPermissionGuard()(screen, '', null)).toBe('handled');
  expect(createPlanCountPermissionGuard()('No current pane', screen, native)).toBeNull();
});
