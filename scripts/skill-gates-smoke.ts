#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * skill-gates-smoke — the $0 headless smoke for the opt-in enforcement hooks
 * (GST-1461). It runs the real Claude Code CLI (\`claude -p\`, unattended, with
 * the hooks registered through \`gstack-skill-gates settings\`) against a local
 * stand-in for the Anthropic Messages API that plays a scripted session, so
 * no model is called and nothing is spent. Then it checks the GSTACK_GATE
 * markers in the session record, the hook log and the transcript JSONL.
 *
 *   bun scripts/skill-gates-smoke.ts [--claude <path to claude>] [--keep]
 *
 * Without --claude it fetches the pinned CLI with npm into a temp dir at run
 * time (never vendored; Anthropic's commercial terms apply to the CLI). Exit
 * 0 when every check passes, 1 when one fails, 2 on a setup error.
 * Docs: docs/skill-gates.md#headless-smoke.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CLAUDE_CODE_VERSION = '2.1.318';
const ROOT = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gates-smoke-')));
const home = path.join(work, 'home');
const repo = path.join(work, 'repo');
const state = path.join(work, 'state');
const SRC = 'export const total = (a: number, b: number) => a - b;\n';
const FIXED = 'export const total = (a: number, b: number) => a + b;\n';

function run(cmd: string, argv: string[], cwd: string, timeout = 120_000): string {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', timeout });
  if (r.status !== 0) { process.stderr.write(`SMOKE_SETUP: ${cmd} ${argv.join(' ')} failed: ${r.stderr || r.error}\n`); process.exit(2); }
  return r.stdout;
}

function claudeBin(): string {
  const i = args.indexOf('--claude');
  if (i >= 0) return path.resolve(args[i + 1]);
  const dir = path.join(work, 'cli');
  fs.mkdirSync(dir);
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', '--prefix', dir, `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`], dir, 600_000);
  return path.join(dir, 'node_modules', '.bin', 'claude');
}

const file = (rel: string) => path.join(repo, rel);
/** The scripted session: one assistant turn per main-loop request, chosen by how many assistant turns the request already holds. */
const SCRIPT: Array<Array<Record<string, unknown>>> = [
  [{ type: 'text', text: 'Loading /investigate.' }, { type: 'tool_use', id: 'toolu_s1', name: 'Skill', input: { skill: 'investigate' } }],
  [{ type: 'tool_use', id: 'toolu_r1', name: 'Read', input: { file_path: file('src/total.ts') } }],
  [{ type: 'tool_use', id: 'toolu_e1', name: 'Edit', input: { file_path: file('src/total.ts'), old_string: 'a - b', new_string: 'a + b' } }],
  [{ type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: "sed -i 's/a - b/a + b/' src/total.ts", description: 'Patch through the shell' } }],
  [{ type: 'text', text: 'Root cause: total() subtracts b instead of adding it (src/total.ts:1).' }, { type: 'tool_use', id: 'toolu_r2', name: 'Read', input: { file_path: file('src/total.ts') } }],
  [{ type: 'tool_use', id: 'toolu_e2', name: 'Edit', input: { file_path: file('src/total.ts'), old_string: 'a - b', new_string: 'a + b' } }],
  [{ type: 'text', text: 'Fixed total().' }],
];

function sse(content: Array<Record<string, unknown>>, model: string): string {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev('message_start', { type: 'message_start', message: { id: `msg_smoke_${Math.random().toString(36).slice(2)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  content.forEach((b, i) => {
    const start = b.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: b.id, name: b.name, input: {} };
    const delta = b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) };
    out += ev('content_block_start', { type: 'content_block_start', index: i, content_block: start });
    out += ev('content_block_delta', { type: 'content_block_delta', index: i, delta });
    out += ev('content_block_stop', { type: 'content_block_stop', index: i });
  });
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  return out + ev('message_stop', { type: 'message_stop' });
}

async function main(): Promise<number> {
  const claude = claudeBin();
  const version = run(claude, ['--version'], work).trim();
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'investigate'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'investigate', 'SKILL.md'), path.join(home, '.claude', 'skills', 'investigate', 'SKILL.md'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(file('src/total.ts'), SRC);
  run('git', ['init', '-q', '-b', 'main'], repo);
  run('git', ['add', '-A'], repo);
  run('git', ['-c', 'user.name=Smoke fixture', '-c', 'user.email=smoke@gstack.test', 'commit', '-q', '-m', 'seed'], repo);
  const settingsFile = path.join(work, 'settings.json');
  fs.writeFileSync(settingsFile, run(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'bin', 'gstack-skill-gates'), 'settings', '--investigate'], work));

  const requests: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const raw = await req.text();
    requests.push(raw);
    if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 1 });
    const body = JSON.parse(raw || '{}');
    const main = Array.isArray(body.tools) && body.tools.length > 0;
    const content = main ? (SCRIPT[body.messages.filter((m: { role: string }) => m.role === 'assistant').length] ?? [{ type: 'text', text: 'Done.' }]) : [{ type: 'text', text: 'ok' }];
    if (!body.stream) return Response.json({ id: 'msg_smoke', type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    return new Response(sse(content, body.model), { headers: { 'content-type': 'text/event-stream' } });
  } });

  const env = {
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`, HOME: home, GSTACK_STATE_ROOT: state,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: 'sk-smoke-not-a-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  };
  const proc = Bun.spawn([claude, '-p', 'total() returns the wrong value; investigate and fix it', '--settings', settingsFile, '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--max-turns', '20'], { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => proc.kill(), 180_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(killer);
  server.stop(true);

  const transcripts = fs.existsSync(path.join(home, '.claude', 'projects')) ? fs.readdirSync(path.join(home, '.claude', 'projects'), { recursive: true }).map(String).filter(f => f.endsWith('.jsonl')) : [];
  const transcript = transcripts.length ? fs.readFileSync(path.join(home, '.claude', 'projects', transcripts[0]), 'utf8') : '';
  const records = fs.existsSync(path.join(state, 'skill-gates')) ? fs.readdirSync(path.join(state, 'skill-gates')) : [];
  const record = records.length ? JSON.parse(fs.readFileSync(path.join(state, 'skill-gates', records[0], 'record.json'), 'utf8')) : null;
  const run0 = record ? Object.values(record.hooks['investigate-gate']?.runs ?? {})[0] as Record<string, unknown> | undefined : undefined;
  const log = fs.existsSync(path.join(state, 'hooks', 'investigate-gate.log')) ? fs.readFileSync(path.join(state, 'hooks', 'investigate-gate.log'), 'utf8') : '';
  const markerLines = [...new Set(transcript.match(/GSTACK_GATE investigate-gate [a-z]+ [^"\\]*/g) ?? [])];
  const later = requests.join('\n');

  const checks: Array<[string, boolean]> = [
    ['claude -p exited 0', code === 0],
    ['record: one run, fired', !!run0 && typeof run0.fired_at === 'string'],
    ['record: blocked twice (Edit, then Bash sed -i)', run0?.blocked === 2],
    ['record: released after the Root cause line', typeof run0?.released_at === 'string'],
    ['record: no hook errors', (record?.hooks['investigate-gate']?.errors ?? []).length === 0],
    ['log: fired, blocked via=edit, blocked via=bash, released', /event=fired/.test(log) && /event=blocked .*via=edit/.test(log) && /event=blocked .*via=bash/.test(log) && /event=released/.test(log)],
    ['transcript: deny reason carries the blocked via=edit marker (tool_result)', /"tool_result"[^\n]*GSTACK_GATE investigate-gate blocked [^"]*via=edit/.test(transcript)],
    ['transcript: PostToolUse block carries the blocked via=bash marker (hook_blocking_error)', /hook_blocking_error[^\n]*GSTACK_GATE investigate-gate blocked [^"]*via=bash/.test(transcript)],
    ['transcript: fired and released ride hook_system_message', /hook_system_message[^\n]*GSTACK_GATE investigate-gate fired/.test(transcript) && /hook_system_message[^\n]*GSTACK_GATE investigate-gate released/.test(transcript)],
    ['requests: fired/released systemMessage markers never reach the model', !/investigate-gate (fired|released)/.test(later)],
    ['requests: the model saw both block reasons', /investigate-gate blocked [^"]*via=edit/.test(later) && /investigate-gate blocked [^"]*via=bash/.test(later)],
    ['repo: the sed -i write was put back, then the released Edit applied', fs.readFileSync(file('src/total.ts'), 'utf8') === FIXED],
  ];
  process.stdout.write(`SMOKE: claude ${version} (fake Messages API, ${requests.length} requests, $0)\n`);
  for (const line of markerLines) process.stdout.write(`  transcript marker: ${line}\n`);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  const failed = checks.filter(([, ok]) => !ok).length;
  if (failed) process.stdout.write(`claude stdout: ${out.slice(0, 2000)}\nclaude stderr: ${err.slice(0, 2000)}\nwork dir kept: ${work}\n`);
  else if (!keep) fs.rmSync(work, { recursive: true, force: true });
  process.stdout.write(`SMOKE_RESULT: ${failed ? 'fail' : 'pass'} checks=${checks.length} failed=${failed}\n`);
  return failed ? 1 : 0;
}

main().then(code => process.exit(code), e => { process.stderr.write(`SMOKE_SETUP: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(2); });
