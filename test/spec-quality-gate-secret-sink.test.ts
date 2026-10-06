/** Execute the actual generated redaction fence before observable dispatch/sinks. */
import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
let output: string;

beforeAll(() => {
  output = mkdtempSync(join(tmpdir(), 'gstack-spec-gate-render-'));
  const rendered = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', output], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
  });
  if (rendered.exitCode !== 0) throw new Error(rendered.stderr.toString());
});
afterAll(() => { if (output) rmSync(output, { recursive: true, force: true }); });

function content(host: 'claude' | 'codex'): string {
  return readFileSync(host === 'claude' ? join(output, 'spec', 'sections', 'gate-and-file.md')
    : join(output, '.agents', 'skills', 'gstack-spec', 'SKILL.md'), 'utf8');
}

function runScan(host: 'claude' | 'codex', body: string, scanner: 'real' | 'broken' | 'missing' = 'real', errexit = false) {
  const scratch = mkdtempSync(join(tmpdir(), 'gstack-spec-sink-'));
  const runtime = join(scratch, 'runtime');
  const bin = join(runtime, 'bin');
  const sinks = join(scratch, 'sinks');
  const temps = join(scratch, 'tmp');
  const systemTemps = join(scratch, 'system-tmp');
  const shims = join(scratch, 'shims');
  // C1: the env-var-host prelude honors an exported GSTACK_ROOT only when it has bin/ and lib/.
  for (const dir of [bin, join(runtime, 'lib'), sinks, temps, systemTemps, shims]) mkdirSync(dir, { recursive: true });
  const realMktemp = Bun.which('mktemp');
  if (!realMktemp) throw new Error('mktemp is required for the spec redaction fixture');
  writeFileSync(join(shims, 'mktemp'), `#!/usr/bin/env bash
if [ "$#" -eq 0 ]; then exec '${realMktemp}' '${systemTemps}/tmp.XXXXXXXX'; fi
exec '${realMktemp}' "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'gstack-config'), '#!/usr/bin/env bash\nprintf "public\\n"\n', { mode: 0o755 });
  if (scanner === 'real') symlinkSync(join(ROOT, 'bin/gstack-redact'), join(bin, 'gstack-redact'));
  if (scanner === 'broken') writeFileSync(join(bin, 'gstack-redact'), '#!/usr/bin/env bash\nexit 70\n', { mode: 0o755 });
  writeFileSync(join(bin, 'fake-reviewer'), '#!/usr/bin/env bash\ncat > "$SINK_DIR/reviewer-received.txt"\n', { mode: 0o755 });
  const full = content(host);
  // The agent's part: run the draft-file block, then write the draft with its
  // file-write tool (CEO-12: the text never passes through the shell).
  const create = full.match(/```bash\n([^`]*?REDACT_FILE=\$\(mktemp[\s\S]*?)\n```/);
  if (!create) throw new Error(`Missing draft-file block in ${host} spec`);
  const made = Bun.spawnSync(['bash', '-c', create[1]], { cwd: scratch, env: { ...process.env, TMPDIR: temps }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  const draft = /^REDACT_FILE: (\S+) \(name: (\S+)\)$/m.exec(made.stdout.toString());
  if (made.exitCode !== 0 || !draft) throw new Error(`draft-file block failed: ${made.stderr.toString()}`);
  writeFileSync(draft[1], body + '\n');
  const start = full.indexOf('#### Redaction scan — pre-codex');
  if (start < 0) throw new Error(`Missing pre-codex redaction in ${host} spec`);
  const match = full.slice(start).match(/```bash\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`Missing executable scan fence in ${host} spec`);
  const fence = match[1]
    .replaceAll('~/.claude/skills/gstack', runtime)
    .replaceAll('$HOME/.claude/skills/gstack', runtime)
    .replace('<redact-file-name>', draft[2]);
  if (fence.includes('<redact-file-name>')) throw new Error('Spec fixture did not substitute the draft file name');
  // Deliberately put sinks directly after the real fence. A missing executable
  // stop (the previous prose-only gate) sends/persists the secret and fails.
  const script = `${errexit ? 'set -e\n' : ''}${fence}\n"$GSTACK_BIN/fake-reviewer" < "$REDACT_FILE"
cat "$REDACT_FILE" > "$SINK_DIR/archive.md"
cat "$REDACT_FILE" > "$SINK_DIR/transcript.md"
rm -f "$REDACT_FILE"
`;
  try {
    const result = Bun.spawnSync(['bash', '-c', script], { cwd: scratch,
      env: { ...process.env, PATH: `${shims}${delimiter}${process.env.PATH ?? ''}`,
        GSTACK_ROOT: runtime, GSTACK_BIN: bin, SINK_DIR: sinks, TMPDIR: temps },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    const stdout = result.stdout.toString();
    const printed = /^REDACT_FILE: (.+)$/m.exec(stdout)?.[1];
    return { code: result.exitCode, stdout, stderr: result.stderr.toString(),
      sinks: readdirSync(sinks).map(name => ({ name, body: readFileSync(join(sinks, name), 'utf8') })),
      pending: [temps, systemTemps, join(scratch, '.gstack', 'tmp')].flatMap(dir => readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf8'))),
      printed: printed && existsSync(printed) ? readFileSync(printed, 'utf8') : undefined };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const host of ['claude', 'codex'] as const) {
  describe(`${host} /spec quality-gate secret sink`, () => {
    test('HIGH blocks reviewer dispatch and all downstream raw sinks, even without errexit', () => {
      const secret = ['AKIA', '1234567890ABCDEF'].join('');
      for (const errexit of [false, true]) {
        const result = runScan(host, `Deploy using ${secret}`, 'real', errexit);
        expect(result.code).toBe(3);
        expect(result.sinks).toEqual([]);
        expect(result.pending).toEqual([]);
        expect(result.stdout).not.toContain(secret);
        expect(result.stderr).toContain('blocked');
      }
    });
    test('MEDIUM pauses dispatch pending its existing user disposition', () => {
      const body = 'Notify the launch contact at owner@private-customer.io';
      const result = runScan(host, body);
      expect(result.code).toBe(2);
      expect(result.sinks).toEqual([]);
      expect(result.pending).toEqual([body + '\n']);
      expect(result.printed).toBe(body + '\n');
      expect(result.stderr).toContain('paused');
    });
    for (const scanner of ['broken', 'missing'] as const) {
      test(`${scanner} scanner cannot become successful coverage or persistence`, () => {
        const result = runScan(host, 'Add a greeting command with a unit test.', scanner);
        expect(result.code).not.toBe(0);
        expect(result.sinks).toEqual([]);
        expect(result.pending).toEqual([]);
        expect(result.stderr).toContain('refusing');
      });
    }
    test('clean scan passes the exact scanned bytes to the reviewer and sinks', () => {
      const body = 'Add a greeting command with a unit test.\nKeep the CLI backwards compatible.';
      const result = runScan(host, body);
      expect(result.code).toBe(0);
      expect(result.sinks.map(sink => sink.name).sort()).toEqual(['archive.md', 'reviewer-received.txt', 'transcript.md']);
      expect(result.sinks.every(sink => sink.body === body + '\n')).toBe(true);
      expect(result.pending).toEqual([]);
    });
    test('redaction remains ahead of outside preflight and --no-gate only skips scoring', () => {
      const text = content(host);
      const scan = text.indexOf('#### Redaction scan — pre-codex');
      const preflight = text.indexOf('_OUTSIDE_CFG=enabled', scan);
      expect(scan).toBeGreaterThan(-1);
      expect(preflight).toBeGreaterThan(scan);
      expect(text).toContain('`--no-gate` skips the outside score only; redaction always runs');
      expect(text).toContain('On --no-gate record skipped after redaction succeeds.');
    });
  });
}
