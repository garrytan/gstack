import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

describe('/desktop-qa safety and verification contract', () => {
  const template = read('desktop-qa/SKILL.md.tmpl');

  test('is report-only and binds one already-running window', () => {
    expect(template).toContain('already-running native or Electron');
    expect(template).toContain('Bind one exact window');
    expect(template).toContain('Stay report-only');
    expect(template).toContain('Never edit source code or fix the bugs you find');
    expect(template).toContain('`pid` and `window_id`');
  });

  test('uses the minimum Cua Driver window tool surface', () => {
    for (const tool of [
      'start_session',
      'list_windows',
      'get_window_state',
      'click',
      'type_text',
      'press_key',
      'scroll',
      'end_session',
    ]) {
      expect(template).toContain(tool);
    }
    expect(template).toContain('capture_scope:\"window\"');
    expect(template).toContain('screenshot_out_file');
    expect(template).toContain('delivery_mode:\"background\"');
  });

  test('requires fresh before/after verification and honest limitations', () => {
    expect(template).toContain('Snapshot immediately before acting');
    expect(template).toContain('Snapshot immediately after acting');
    expect(template).toContain('An action result that says success is not proof');
    expect(template).toContain('record the flow as unverified; do not retry in foreground');
    expect(template).toContain('Whether the run passes, fails, or stops early, end only the session');
  });

  test('does not widen permissions, capture, lifecycle, or recording scope', () => {
    const prohibited = [
      '--dangerously-bypass-approvals',
      'permissions grant',
      'update --apply',
      'launch_app',
      'kill_app',
      'bring_to_front',
      'escalate_session',
      'get_desktop_state',
      'capture_scope:\"desktop\"',
      'capture_scope:\"auto\"',
      'delivery_mode:\"foreground\"',
      'start_recording',
      'record_video',
    ];

    for (const value of prohibited) {
      expect(template).not.toContain(value);
    }
  });

  test('routes desktop QA separately from browser QA', () => {
    const router = read('SKILL.md.tmpl');
    const routingInjection = read('scripts/resolvers/preamble/generate-routing-injection.ts');

    expect(router).toContain('already-running native or Electron desktop app → invoke `/desktop-qa`');
    expect(router).toContain('browser, website QA');
    expect(routingInjection).toContain('native or Electron desktop app → invoke /desktop-qa');
  });

  test('generated skill preserves the contract', () => {
    const generated = read('desktop-qa/SKILL.md');

    expect(generated).toContain('AUTO-GENERATED from SKILL.md.tmpl');
    expect(generated).toContain('capture_scope:\"window\"');
    expect(generated).toContain('Snapshot immediately before acting');
    expect(generated).toContain('Snapshot immediately after acting');
    expect(generated).toContain('cua-driver call end_session');
  });
});
