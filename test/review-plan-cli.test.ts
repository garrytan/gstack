import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BIN = path.join(import.meta.dir, '..', 'bin', 'gstack-review-plan');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repo(files: Record<string, string>): { dir: string; state: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-state-'));
  dirs.push(dir, state);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
  git('add', '.'); git('commit', '-qm', 'feat');
  return { dir, state };
}
const run = (r: { dir: string; state: string }, args: string[]) => spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', ...args], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });

describe('gstack-review-plan', () => {
  test('a docs-only diff plans no dispatch and says why', () => {
    const r = run(repo({ 'docs/howto.md': '# How to\nStep one.\n' }), []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REVIEW_PLAN: class=docs pass=1 next=full dispatches=0 numbers=no');
    expect(r.stdout).toContain('SKIP: outside-voice (docs class, no numeric claims)');
  });
  // Value: protects=a stale local main does not stand in for the base: a docs-only branch that merged a newer origin/main
  //   plans as docs, not as the gate change origin/main already has (GST-462: #3597 was labeled gate code at full depth
  //   until --base origin/main); fails_when=gstack-gate-diff or gstack-diff-scope diff against the local branch;
  //   seam=a tracking ref moved with update-ref, as a fetch would; no_claim=nothing about a local main ahead of origin/main.
  test('a stale local main yields to origin/main: a docs-only branch that merged the newer origin/main plans as docs', () => {
    const r = repo({ 'docs/howto.md': '# How to\nStep one.\n' });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    const testFile = (skip: boolean) => `import { test, expect } from 'bun:test';\ntest${skip ? '.skip' : ''}('adds', () => {\n  expect(1 + 1).toBe(2);\n});\n`;
    git('checkout', '-q', 'main');
    fs.mkdirSync(path.join(r.dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'test', 'add.test.ts'), testFile(false));
    git('add', '.'); git('commit', '-qm', 'tests');
    git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'main'); git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.dir, 'test', 'add.test.ts'), testFile(true));
    git('commit', '-qam', 'upstream skip');
    git('remote', 'add', 'origin', 'https://example.invalid/x.git');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('reset', '-q', '--hard', 'HEAD~1');
    git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'origin/main');
    const plan = spawnSync(BIN, ['--base', 'main'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(plan.status).toBe(0);
    expect(plan.stdout).toContain('REVIEW_PLAN: class=docs pass=1 next=full dispatches=0 numbers=no');
  });
  // Value: protects=R51's one reviewer on a tests-only diff at the CLI /ship runs; fails_when=it prints dispatches=0 or any reader but the batched Testing one;
  //   why_new=HARN-1 (harness-evals#425, GST-2547): a test getting a scripted clock planned zero readers; seam=gstack-review-plan on a real repo; no_claim=what the reader finds
  test('a tests-only diff plans one batched Testing reader (R51)', () => {
    const r = run(repo({ 'test/clock.test.ts': "import { test, expect, setSystemTime } from 'bun:test';\ntest('clock', () => { setSystemTime(new Date(0)); expect(Date.now()).toBe(0); setSystemTime(); });\n" }), []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REVIEW_PLAN: class=tests pass=1 next=full dispatches=1 numbers=no');
    expect(r.stdout.split('\n').filter(l => l.startsWith('DISPATCH: '))).toEqual(['DISPATCH: specialist batched effort=medium checklists=testing']);
  });
  // Value: protects=an iOS UI change plans by risk instead of failing closed to the full panel, while Apple permissions still plan
  //   full; fails_when=gstack-diff-scope prints SCOPE_ERROR=unmatched for .swift, or Info.plist reads as plain UI; why_new=GST-3041:
  //   ghome#32, a 55-line SwiftUI copy change, got 5 readers and a coverage audit; seam=gstack-review-plan on a real repo;
  //   no_claim=what the readers find
  test('a SwiftUI change plans light, not the fail-closed panel; an Info.plist edit plans gate (GST-3041)', () => {
    const view = 'import SwiftUI\nstruct ReviewView: View {\n  var body: some View { Text("Saved") }\n}\n';
    const ui = { 'App/Review/ReviewView.swift': view, 'App/Home/SettingsView.swift': view, 'App/AppModel.swift': 'final class AppModel {}\n', 'Tests/GHomeTests/HealthSyncTests.swift': 'import XCTest\n' };
    const light = run(repo(ui), []);
    expect(light.stdout).not.toContain('DEPTH_ERROR');
    expect(light.stdout).toMatch(/^REVIEW_DEPTH: light /m);
    expect(light.stdout).toMatch(/^REVIEW_PLAN: class=code /m);
    const plist = run(repo({ ...ui, 'App/Info.plist': '<plist><dict><key>NSAllowsArbitraryLoads</key><true/></dict></plist>\n' }), []);
    expect(plist.stdout).toMatch(/^REVIEW_CLASS: gate .*auth paths/m);
    expect(plist.stdout).toMatch(/^REVIEW_DEPTH: full /m);
    const client = run(repo({ ...ui, 'App/Client.swift': 'final class Client {\n  func load(_ r: URLRequest) async throws -> Data { try await URLSession.shared.data(for: r).0 }\n}\n' }), []);
    expect(client.stdout).toMatch(/^REVIEW_DEPTH: full .*risk:security/m);
  });
  // Value: protects=an iOS PR that writes or deletes users' files on the device, or reads their calendars, plans full even when it
  //   also touches Markdown and tests, while a SwiftUI view that reads a UserDefaults setting stays light; fails_when=the Swift
  //   user-data rules stop reaching gstack-review-plan; why_new=GST-3052: ghome#10 (spill files written and deleted) and ghome#31
  //   (calendar choices, read through EventKit) planned light (GSTA-601); seam=gstack-review-plan on a real repo; no_claim=what the readers find
  test('a Swift diff that writes and deletes spill files, or reads calendars, plans full; a SwiftUI settings view stays light (GST-3052)', () => {
    const view = 'import SwiftUI\nstruct SettingsView: View {\n  @AppStorage("speaksAnswers") private var speaksAnswers = true\n  var body: some View { Toggle("Speak answers", isOn: $speaksAnswers) }\n}\n';
    const shared = { 'DESIGN.md': '# Design\n', 'App/Home/SettingsView.swift': view, 'Tests/AppTests/SettingsTests.swift': 'import XCTest\n' };
    const control = run(repo({ ...shared, 'App/Home/PickerModel.swift': 'final class PickerModel {\n  let defaults: UserDefaults\n  init(defaults: UserDefaults = .standard) { self.defaults = defaults }\n  var chosen: Data? { defaults.data(forKey: "picker.chosen") }\n  func save(_ blob: Data) { defaults.set(blob, forKey: "picker.chosen") }\n}\n' }), []);
    expect(control.stdout).toMatch(/^REVIEW_DEPTH: light /m);
    const spill = 'import Foundation\npublic struct DraftSpill {\n  public let file: URL\n  public func reserve(_ size: Int) throws {\n    guard FileManager.default.createFile(atPath: file.path, contents: Data(count: size)) else { throw CocoaError(.fileWriteUnknown) }\n  }\n  public func discard() { try? FileManager.default.removeItem(at: file) }\n}\n';
    expect(run(repo({ ...shared, 'Packages/Core/Sources/Core/Capture/DraftSpill.swift': spill }), []).stdout).toMatch(/^REVIEW_DEPTH: full .*risk:data/m);
    const agenda = 'import EventKit\nfinal class AgendaSource {\n  private let events = EKEventStore()\n  func calendarNames() -> [String] { events.calendars(for: .event).map(\\.title) }\n}\n';
    expect(run(repo({ ...shared, 'App/Meeting/AgendaSource.swift': agenda }), []).stdout).toMatch(/^REVIEW_DEPTH: full .*risk:data/m);
  });
  test('a docs diff that publishes numbers keeps the outside voice', () => {
    const r = run(repo({ 'docs/bench.md': 'Median latency fell 42% to 180 ms.\n' }), []);
    expect(r.stdout).toContain('DISPATCH: outside-voice outside-voice effort=host');
  });
  test('--json carries the class, the next step, every dispatch with its effort and the audit effort; --no-tiers renders specialists and audits at host effort', () => {
    const r = repo({ 'src/a.ts': Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n' });
    const plan = JSON.parse(run(r, ['--json', '--depth-floor', 'standard']).stdout);
    expect(plan).toMatchObject({ class: 'code', next: { step: 'full' }, pass: 0 });
    expect(plan.dispatches.filter((d: any) => d.role === 'specialist').map((d: any) => d.effort)).toEqual(expect.arrayContaining(['medium']));
    expect(plan.dispatches.filter((d: any) => d.role === 'specialist').every((d: any) => d.effort === 'medium')).toBe(true);
    expect(plan.dispatches.find((d: any) => d.role === 'adversarial-native').effort).toBe('full');
    expect(plan.audit_effort).toBe('light');
    expect(run(r, ['--depth-floor', 'standard']).stdout).toContain('DISPATCH: specialist batched effort=medium checklists=testing,security,state-machines');
    const host = JSON.parse(run(r, ['--json', '--no-tiers', '--depth-floor', 'standard']).stdout);
    expect(host.audit_effort).toBe('host');
    expect(host.dispatches.filter((d: any) => d.role === 'specialist').every((d: any) => d.effort === 'host')).toBe(true);
    expect(host.dispatches.find((d: any) => d.role === 'adversarial-native').effort).toBe('full');
    expect(run(r, ['--no-tiers', '--depth-floor', 'standard']).stdout).toContain('DISPATCH: specialist batched effort=host checklists=testing,security,state-machines');
  });
  test('a below-floor fix after pass 1 plans the full pass on the range as round 2, never a fix-check (GST-3562 A)', () => {
    const r = run(repo({ 'src/a.ts': 'export const a = 1;\n' }), ['--pass', '1', '--last', 'full', '--fixed-below']);
    expect(r.stdout).toMatch(/^REVIEW_PLAN: class=code pass=2 next=full dispatches=2 .*reason="below-floor fixes changed code after round 1: round 2 is a full pass on the range, never a fix-check \(R51, GST-3562 A\)"$/m);
    expect(r.stdout).toContain('DISPATCH: specialist batched effort=full checklists=testing,security,state-machines,red-team');
    expect(r.stdout).toContain('DISPATCH: adversarial-native adversarial effort=full');
    expect(r.stdout).not.toContain('DISPATCH: fix-check');
  });
  test('untracked files count, a version-only package.json bump stays docs, and review_effort_tiers off renders audits at host effort', () => {
    const r = repo({ 'docs/a.md': '# a\n' });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.dir, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.0"\n}\n');
    git('add', '.'); git('commit', '-qm', 'package');
    git('checkout', '-q', 'feat'); git('reset', '-q', '--hard', 'main');
    fs.writeFileSync(path.join(r.dir, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.1"\n}\n');
    git('commit', '-qam', 'stamp');
    const stamp = JSON.parse(run(r, ['--json']).stdout);
    expect(stamp.stamp_only).toContain('package.json');
    expect(stamp.class).toBe('docs');
    fs.mkdirSync(path.join(r.dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'lib', 'new.ts'), 'export const a = 1;\n');
    const withUntracked = JSON.parse(run(r, ['--json']).stdout);
    expect(withUntracked.paths).toContain('lib/new.ts');
    expect(withUntracked.class).toBe('code');
    const cfg = spawnSync(path.join(import.meta.dir, '..', 'bin', 'gstack-config'), ['set', 'review_effort_tiers', 'off'], { cwd: r.dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(cfg.status).toBe(0);
    expect(JSON.parse(run(r, ['--json']).stdout).audit_effort).toBe('host');
    const bad = spawnSync(path.join(import.meta.dir, '..', 'bin', 'gstack-config'), ['set', 'review_effort_tiers', 'maybe'], { cwd: r.dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("review_effort_tiers 'maybe' not recognized");
  });
  test('without --gate-tagged the plan runs the gate scan itself', () => {
    const r = repo({ 'lib/a.ts': 'export const a = 1;\n' });
    const res = spawnSync(BIN, ['--base', 'main', '--json'], { cwd: r.dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(res.status, res.stderr).toBe(0);
    expect(typeof JSON.parse(res.stdout).gate_tagged).toBe('number');
  });
  test('usage errors exit 2', () => {
    expect(spawnSync(BIN, [], { encoding: 'utf8', timeout: 10_000 }).status).toBe(2);
    expect(run(repo({ 'a.md': 'x' }), ['--last', 'later']).status).toBe(2);
  });
  test('scratch under .gstack/tmp/ is ignored, a subdirectory run plans the whole repository, and --adversarial-ran drops the repeat adversarial pass', () => {
    const r = repo({ 'docs/a.md': '# a\n' });
    fs.mkdirSync(path.join(r.dir, '.gstack', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, '.gstack', 'tmp', 'fix-check-list.ts'), 'export const x = 1;\n');
    const plan = JSON.parse(run(r, ['--json']).stdout);
    expect(plan.class).toBe('docs');
    expect(plan.paths).toEqual(['docs/a.md']);
    const sub = spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', '--json'], { cwd: path.join(r.dir, 'docs'), encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(JSON.parse(sub.stdout).paths).toEqual(['docs/a.md']);
    const code = repo({ 'src/a.ts': Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n' });
    const repeat = ['--pass', '1', '--last', 'full', '--fixed-blocking'];
    expect(run(code, repeat).stdout).toContain('DISPATCH: adversarial-native adversarial effort=full');
    const ran = run(code, [...repeat, '--adversarial-ran']).stdout;
    expect(ran).not.toContain('DISPATCH: adversarial-native');
    expect(ran).toContain('SKIP: adversarial-native and outside-voice (run once per invocation)');
  });
});

describe('gstack-review-plan: review depth', () => {
  const code = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  test('prints REVIEW_DEPTH with runtime lines and the rules hash, and GATE_SCAN bound to the head', () => {
    const r = repo({ 'src/a.ts': code(10), 'test/a.test.ts': code(200) });
    const out = run(r, []).stdout;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    expect(out).toMatch(/^REVIEW_DEPTH: light runtime_lines=10 rules=[0-9a-f]{16} reasons=runtime=10 codes=none$/m);
    expect(out).toContain(`GATE_SCAN: tagged=0 head=${head}`);
    expect(out).toContain('DISPATCH: specialist batched effort=full checklists=testing,security,state-machines,red-team');
    expect(out).toContain('DISPATCH: adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)');
  });
  test('DIFF_CMD is shell-quoted per dispatch and excludes what the reviewer does not read; DIFF_EXCLUDE: none when empty', () => {
    const r = repo({ 'src/a.ts': code(80), 'docs/my notes*.md': '# n\n', 'test/a.test.ts': code(3) });
    const out = run(r, []).stdout;
    expect(out).toContain("DIFF_CMD: batched git diff <diff-base> -- . ':(exclude,literal)docs/my notes*.md'\n");
    expect(out).toContain('SKIP: maintainability, performance, simplification (lean ensemble: read only when forced)');
    expect(out).toContain('DIFF_CMD: adversarial git diff <diff-base>\nDIFF_EXCLUDE: adversarial none');
    const cmd = /^DIFF_CMD: batched (.*)$/m.exec(out)![1]!.replace('<diff-base>', 'main');
    const diff = spawnSync('bash', ['-c', cmd.replace('git diff main', 'git diff --name-only main')], { cwd: r.dir, encoding: 'utf8' });
    expect(diff.stdout.trim().split('\n')).toEqual(['src/a.ts', 'test/a.test.ts']);
  });
  test('--json carries depth, runtime_lines, rules, errors, gate_scan and every dispatch\'s exclude array', () => {
    const r = repo({ 'src/a.ts': code(80), 'README.md': '# y\n' });
    const plan = JSON.parse(run(r, ['--json', '--depth-floor', 'standard']).stdout);
    expect(plan).toMatchObject({ depth: 'standard', step_depth: 'standard', runtime_lines: 80, errors: [], codes: [], gate_scan: { tagged: 0 } });
    expect(plan.rules).toMatch(/^[0-9a-f]{16}$/);
    expect(plan.dispatches.find((d: any) => d.name === 'batched').exclude).toEqual([':(exclude)README.md']);
    expect(plan.dispatches.find((d: any) => d.role === 'outside-voice').exclude).toEqual([]);
  });
  test('--depth-floor full raises a light diff, never lowers a full one, and an invalid floor is a usage error', () => {
    const r = repo({ 'src/a.ts': code(5) });
    expect(run(r, ['--depth-floor', 'full']).stdout).toMatch(/^REVIEW_DEPTH: full runtime_lines=5 .*reasons=runtime=5,floor:full /m);
    const gate = repo({ 'src/a.ts': code(5), '.github/workflows/ci.yml': 'on: push\n' });
    expect(run(gate, ['--depth-floor', 'standard']).stdout).toMatch(/^REVIEW_DEPTH: full /m);
    expect(run(r, ['--depth-floor', 'light']).status).toBe(2);
  });
  test('a conservative full plan exits 0 with its errors; a plan that cannot be built exits 1', () => {
    const r = repo({ 'lib/x.wasm': '\u0000asm\u0000' });
    const res = run(r, ['--json']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ depth: 'full', errors: expect.arrayContaining([expect.objectContaining({ code: 'binary_code_path', input: 'lib/x.wasm' })]) });
    expect(run(r, []).stdout).toContain('DEPTH_ERROR: binary_code_path input=lib/x.wasm');
    const none = spawnSync(BIN, ['--base', 'no-such-branch', '--gate-tagged', '0'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(none.status).toBe(1);
  });
});

describe('gstack-review-plan: the full round 2 on a small fix range (GSTA-152 D6, GST-3562 part 3)', () => {
  const code = (n: number, tag = 'v') => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
  function fixed(lines: number): { r: { dir: string; state: string }; rangeBase: string } {
    const r = repo({ 'src/a.ts': code(80) });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    const rangeBase = git('rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(r.dir, 'src', 'fix.ts'), code(lines, 'f'));
    git('add', '.'); git('commit', '-qm', 'fix: pre-landing review fixes');
    return { r, rangeBase };
  }
  const pass2 = ['--pass', '1', '--last', 'full', '--fixed-blocking', '--adversarial-ran', '--pass1-depth', 'standard'];
  const full1 = ['--pass', '1', '--last', 'full', '--fixed-blocking', '--adversarial-ran', '--pass1-depth', 'full'];
  test('--range-base with a small fix range plans a full pass 2 with the batched specialist, the Red Team and the native adversarial, and no fix-check', () => {
    const { r, rangeBase } = fixed(24);
    const out = run(r, [...pass2, '--range-base', rangeBase]).stdout;
    expect(out).toMatch(/^REVIEW_PLAN: class=code pass=2 next=full dispatches=3 /m);
    expect(out).toContain(`FIX_RANGE: runtime_lines=24 base=${rangeBase}`);
    expect(out).toMatch(/^NEXT: full \(a blocking finding was fixed on a light diff with 24 runtime lines in the fix range: full pass on the range, never a scoped pass, so every reader is in the pass record \(GST-3562\)\)$/m);
    expect(out).not.toContain('DISPATCH: fix-check');
    expect(out).toMatch(/^DISPATCH: specialist batched effort=\S+ checklists=/m);
    expect(out).toContain('DISPATCH: red-team red-team effort=full');
    expect(out).toContain('DISPATCH: adversarial-native adversarial effort=full');
    expect(JSON.parse(run(r, [...pass2, '--range-base', rangeBase, '--json']).stdout)).toMatchObject({ next: { step: 'full', keepReader: true, rangeReaders: true }, fix_range: { base: rangeBase, runtime_lines: 24 } });
  });
  test('a 151-line range, no --range-base, an unknown range base and uncommitted fixes keep the full pass 2', () => {
    const big = fixed(151);
    expect(run(big.r, [...pass2, '--range-base', big.rangeBase]).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and the fix range has 151 runtime lines \(> 150\)/m);
    const { r, rangeBase } = fixed(10);
    expect(run(r, [...pass2.slice(0, -2), '--range-base', rangeBase]).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and pass 1 ran at full depth/m);
    expect(run(r, pass2).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and the fix range was not read/m);
    const unknown = run(r, [...pass2, '--range-base', 'f'.repeat(40)]).stdout;
    expect(unknown).toMatch(/^FIX_RANGE: unread \(.*\) base=f{40}$/m);
    expect(unknown).toMatch(/^NEXT: full /m);
    fs.writeFileSync(path.join(r.dir, 'src', 'fix.ts'), code(12, 'g'));
    const dirty = run(r, [...pass2, '--range-base', rangeBase]).stdout;
    expect(dirty).toMatch(/^FIX_RANGE: unread \(uncommitted or untracked edits.*\)/m);
    expect(dirty).toMatch(/^NEXT: full /m);
    expect(run(r, [...pass2, '--range-base']).status).toBe(2);
  }, 30_000);
  test('a fix range that touches a gate path keeps the full pass 2 without --touched-gate, and an empty range is unread', () => {
    const r = repo({ 'src/a.ts': code(80), '.github/workflows/ci.yml': 'on: push\n' });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    const rangeBase = git('rev-parse', 'HEAD').stdout.trim();
    expect(run(r, [...pass2, '--range-base', rangeBase]).stdout).toMatch(/^FIX_RANGE: unread \(the fix range is empty: .*\) base=/m);
    git('rm', '-q', '.github/workflows/ci.yml');
    fs.writeFileSync(path.join(r.dir, 'src', 'b.ts'), code(2, 'b'));
    git('add', '.'); git('commit', '-qm', 'fix: revert the workflow edit');
    const out = run(r, [...pass2, '--range-base', rangeBase]).stdout;
    expect(out).toMatch(/^REVIEW_DEPTH: light .* step=standard$/m);
    expect(out).toMatch(/^NEXT: full \(a blocking finding was fixed and a fix touched a gate-class path/m);
    expect(JSON.parse(run(r, [...pass2, '--range-base', rangeBase, '--json']).stdout)).toMatchObject({ next: { step: 'full' }, fix_range: { touched_gate: true } });
  }, 30_000);
  test.each([
    ['an auth revert', 'src/auth/login.ts', 'export const login = (u: string) => u.length > 0;\n'],
    ['a migration revert', 'db/migrate/001_a.sql', 'ALTER TABLE users ADD COLUMN email text;\n'],
  ])('%s on a full-depth PR plans the full pass 2', (_n, file, text) => {
    const r = repo({ 'src/a.ts': code(80) });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    const write = (body: string) => { fs.mkdirSync(path.dirname(path.join(r.dir, file)), { recursive: true }); fs.writeFileSync(path.join(r.dir, file), body); };
    git('checkout', '-q', 'main'); write(text); git('add', '.'); git('commit', '-qm', 'base file');
    git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'main');
    write(text + '-- edited\n'); git('add', '.'); git('commit', '-qm', 'feat edit');
    const rangeBase = git('rev-parse', 'HEAD').stdout.trim();
    write(text);
    fs.writeFileSync(path.join(r.dir, 'src', 'b.ts'), code(2, 'b'));
    git('add', '.'); git('commit', '-qm', 'fix: revert the edit');
    const out = run(r, [...full1, '--range-base', rangeBase]).stdout;
    expect(out).not.toMatch(/^REVIEW_CLASS: gate/m);
    expect(out).toMatch(/^NEXT: full /m);
  }, 30_000);
  test('a fix that un-skips a gate tag added in an earlier pass-1 commit plans the full pass 2 on a full-depth PR', () => {
    const r = repo({ 'src/a.ts': code(80), 'test/a.test.ts': "test.skip('x', () => {});\n" });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    fs.writeFileSync(path.join(r.dir, 'src', 'c.ts'), code(3, 'c')); git('add', '.'); git('commit', '-qm', 'later pass-1 commit');
    const rangeBase = git('rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(r.dir, 'test', 'a.test.ts'), "test('x', () => {});\n");
    fs.writeFileSync(path.join(r.dir, 'src', 'y.ts'), code(1, 'y'));
    git('add', '.'); git('commit', '-qm', 'fix: un-skip');
    expect(run(r, [...full1, '--range-base', rangeBase]).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and pass 1 ran at full depth/m);
  }, 30_000);
  test('--depth-floor full opts out of the scoped pass', () => {
    const { r, rangeBase } = fixed(10);
    expect(run(r, [...pass2, '--range-base', rangeBase, '--depth-floor', 'full']).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and the diff is at full depth/m);
  });
});

// Value: protects=the stop after an edit that followed the read-only final review names the exact command that records the
//   owner's ship-with-the-note ruling, with the edited paths and the stop head (GST-3775, GBRA-795); fails_when=the stop
//   says "ship with it as a ruled note" and names no command finish reads; seam=bin/gstack-review-plan --post-review
describe('gstack-review-plan --post-review stop names the edit ruling (GST-3775)', () => {
  test('a fix after the read-only final review prints gstack-approvals rule --finding edit:<path> at the stop head', () => {
    const r = repo({ 'src/a.ts': 'export const a = 1;\n', 'src/gone.ts': 'export const g = 0;\n' });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const passHead = git('rev-parse', 'HEAD');
    fs.rmSync(path.join(r.dir, 'src/gone.ts'));
    const odd = "src/q'$(id)`;x|y.ts";
    fs.appendFileSync(path.join(r.dir, 'src/a.ts'), 'export const b = 2;\n'); fs.writeFileSync(path.join(r.dir, 'src/a b.ts'), 'export const c = 3;\n');
    fs.writeFileSync(path.join(r.dir, odd), 'export const d = 4;\n');
    git('add', '.'); git('commit', '-qm', 'edit after the final review');
    const head = git('rev-parse', 'HEAD');
    const p = run(r, ['--pass', '3', '--last', 'full', '--range-base', passHead, '--post-review']);
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain("a fix followed the read-only final review: the lane's Captain decides (R51)");
    expect(p.stdout).toContain(`record that ruling once per edited path (each path shell-quoted; the owner-ref is the relay this open /gstack-ship run needs): gstack-approvals rule --finding 'edit:src/a.ts' --head ${head} --reason '<why`);
    expect(p.stdout).toContain("'src/a b.ts' cannot be ruled (a finding holds no whitespace), so an edit there keeps the fix and runs /gstack-ship again");
    expect(p.stdout).toContain("; a deletion ('src/gone.ts') cannot be ruled, so it keeps the fix and runs /gstack-ship again");
    const findings = [...p.stdout.split('\n').find(l => l.startsWith('NEXT: '))!.matchAll(/gstack-approvals rule --finding ('(?:[^']|'\\'')*') --head /g)].map(m => m[1]!);
    expect(findings).toHaveLength(2);
    const parsed = spawnSync('sh', ['-c', `printf '%s\\n' ${findings.join(' ')}`], { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    expect(parsed.stdout).toBe(`edit:src/a.ts\nedit:${odd}\n`);
    expect(run(r, ['--pass', '3', '--last', 'full', '--range-base', passHead, '--fixed-below']).stdout).not.toContain('--finding edit:');
  }, 30_000);
});

// Value: protects=an owner's edit:<path> ruling on an edit after the read-only final review is honoured by the plan as finish
//   honours it, so the ruled edit ships as a note and only the targeted reader receipt write asks for, or nothing, follows;
//   fails_when=the plan still counts the ruled range as a fix (FIX_RANGE runtime_lines>0, NEXT: stop or voices, GST-3814 on
//   #4819), or a ruling clears a path it does not name or bytes edited after it; seam=bin/gstack-review-plan --range-base reading
//   the approval record
describe('gstack-review-plan honours edit rulings in the fix range (GST-3814)', () => {
  const env = (r: { state: string }) => { const e: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: r.state, GSTACK_APPROVALS_MIRROR: '0' }; delete e.GSTACK_APPROVALS_DIR; return e; };
  const plan = (r: { dir: string; state: string }, args: string[]) => spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', ...args], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: env(r) });
  const rule = (r: { dir: string; state: string }, file: string, head: string) => spawnSync(path.join(path.dirname(BIN), 'gstack-approvals'), ['rule', '--finding', `edit:${file}`, '--head', head, '--reason', 'the docs-audit rename after the final review ships as a disclosed note', '--words', 'ship it with the note', '--by', 'GStack Minder (GSTA-36)'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: env(r) });
  const after = ['--pass', '3', '--last', 'full', '--fixed-below'];
  function edited(files: Record<string, string>) {
    const r = repo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const passHead = git('rev-parse', 'HEAD');
    for (const [p, text] of Object.entries(files)) fs.appendFileSync(path.join(r.dir, p), text);
    git('add', '.'); git('commit', '-qm', 'docs audit edit after the final review');
    return { r, git, passHead, head: git('rev-parse', 'HEAD') };
  }
  test('every path ruled at the head: the range plans as no fix and the stop is gone', () => {
    const { r, passHead, head } = edited({ 'src/a.ts': 'export const c = 3;\n' });
    expect(plan(r, [...after, '--range-base', passHead]).stdout).toMatch(/^NEXT: stop \(a fix followed the read-only final review/m);
    expect(rule(r, 'src/a.ts', head).status).toBe(0);
    const p = plan(r, [...after, '--range-base', passHead]);
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toMatch(new RegExp(`^RULED_EDIT: src/a\\.ts \\(ruled at ${head.slice(0, 12)} by GStack Minder \\(GSTA-36\\), approval a-[0-9a-f]{12}\\)$`, 'm'));
    expect(p.stdout).toContain(`FIX_RANGE: runtime_lines=0 base=${passHead} ruled=1`);
    expect(p.stdout).toMatch(/^NEXT: done \(every edit since --range-base is ruled a note \(RULED_EDIT\)/m);
    expect(p.stdout).not.toContain("Captain decides");
    expect(JSON.parse(plan(r, [...after, '--range-base', passHead, '--json']).stdout).fix_range).toMatchObject({ runtime_lines: 0, ruled: ['src/a.ts'] });
  }, 60_000);
  test('a path with no ruling, or edited again after its ruling, still stops', () => {
    const partial = edited({ 'src/a.ts': 'export const c = 3;\n', 'src/b.ts': 'export const d = 4;\n' });
    expect(rule(partial.r, 'src/a.ts', partial.head).status).toBe(0);
    const p = plan(partial.r, [...after, '--range-base', partial.passHead]);
    expect(p.stdout).toMatch(/^NEXT: stop \(a fix followed the read-only final review/m);
    expect(p.stdout).toContain('RULED_EDIT: src/a.ts');
    const later = edited({ 'src/a.ts': 'export const c = 3;\n' });
    expect(rule(later.r, 'src/a.ts', later.head).status).toBe(0);
    fs.appendFileSync(path.join(later.r.dir, 'src/a.ts'), 'export const e = 5;\n'); later.git('commit', '-qam', 'edit it again');
    const q = plan(later.r, [...after, '--range-base', later.passHead]);
    expect(q.stdout).toMatch(/^NEXT: stop \(a fix followed the read-only final review/m);
    expect(q.stdout).toContain('RULED_EDIT_REFUSED: src/a.ts (');
    expect(q.stdout).not.toMatch(/^RULED_EDIT: /m);
  }, 60_000);
});
