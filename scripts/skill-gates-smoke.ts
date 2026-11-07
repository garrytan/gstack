#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * skill-gates-smoke — the $0 headless smoke for the opt-in enforcement hooks
 * (GST-1461). It runs the real Claude Code CLI (\`claude -p\`, unattended, with
 * the hooks registered through \`gstack-skill-gates settings\`) against a local
 * stand-in for the Anthropic Messages API that plays a scripted session, so
 * no model is called and nothing is spent. Then it checks the GSTACK_GATE
 * markers in the session record, the hook log and the transcript JSONL.
 * Two scenarios share the server: the /plan-ceo-review gate (Stop blocked
 * until the output file ranks the top risks, written through Bash) and the
 * /autoplan gate (Eng's publish before CEO and a report-less CEO publish
 * refused at PreToolUse, then Stop blocked after Phase 1 until Eng publishes
 * and the Final Approval Gate is written).
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
const PLAN = '# Plan: one-click checkout\n\nShip one-click checkout behind a flag.\n';
const AP_PLAN = '# Plan: retry the fetch helper\n\n## Implementation plan\n\nAdd one retry with backoff to src/fetch.ts.\n\n## Review record\n\nNone yet.\n';
const FINDINGS = '\n## Findings\n\n1. Payment retries can double-charge when the provider times out.\n2. No rollback path for the new orders schema.\n';

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

type Block = Record<string, unknown>;
interface Dirs { home: string; repo: string; state: string }
interface Seen { code: number; transcript: string; record: Record<string, any> | null; log: string; requests: string; repo: string }
interface Scenario { name: string; hook: string; flag: string; skill: string; prompt: string; seed: (repo: string) => void; script: (repo: string) => Block[][]; checks: (s: Seen) => Array<[string, boolean]> }

const SCENARIOS: Scenario[] = [
  {
    name: 'plan-ceo-review', hook: 'ceo-review-gate', flag: '--ceo-review', skill: 'plan-ceo-review', prompt: 'review plan.md as a CEO and write the review into it',
    seed: repo => fs.writeFileSync(path.join(repo, 'README.md'), '# smoke\n'),
    script: repo => [
      [{ type: 'text', text: 'Loading /plan-ceo-review.' }, { type: 'tool_use', id: 'toolu_c1', name: 'Skill', input: { skill: 'plan-ceo-review' } }],
      [{ type: 'tool_use', id: 'toolu_w1', name: 'Write', input: { file_path: path.join(repo, 'plan.md'), content: PLAN } }],
      [{ type: 'text', text: 'Review complete.' }],
      [{ type: 'tool_use', id: 'toolu_b2', name: 'Bash', input: { command: `cat >> plan.md <<'EOF'\n${FINDINGS}EOF`, description: 'Append the ranked findings' } }],
      [{ type: 'text', text: 'Findings added to plan.md.' }],
    ],
    checks: s => {
      const h = s.record?.hooks['ceo-review-gate'];
      const run0 = h ? Object.values(h.runs ?? {})[0] as Record<string, unknown> | undefined : undefined;
      return [
        ['claude -p exited 0', s.code === 0],
        ['record: one run, fired', !!run0 && typeof run0.fired_at === 'string'],
        ['record: blocked once (Stop with no Findings)', run0?.blocked === 1],
        ['record: released by plan.md after the Bash heredoc', typeof run0?.released_at === 'string' && run0?.file === 'plan.md'],
        ['record: no hook errors', (h?.errors ?? []).length === 0],
        ['log: fired, blocked via=stop files=plan.md, released file=plan.md', /event=fired/.test(s.log) && /event=blocked .*via=stop files=plan\.md n=1/.test(s.log) && /event=released .*file=plan\.md/.test(s.log)],
        ['transcript: the Stop block carries the blocked via=stop marker (hook_blocking_error)', /hook_blocking_error[^\n]*GSTACK_GATE ceo-review-gate blocked [^"]*via=stop/.test(s.transcript)],
        ['transcript: fired and released ride hook_system_message', /hook_system_message[^\n]*GSTACK_GATE ceo-review-gate fired/.test(s.transcript) && /hook_system_message[^\n]*GSTACK_GATE ceo-review-gate released/.test(s.transcript)],
        ['requests: fired/released systemMessage markers never reach the model', !/ceo-review-gate (fired|released)/.test(s.requests)],
        ['requests: the model saw the block reason and where to write', /ceo-review-gate blocked [^"]*via=stop/.test(s.requests) && s.requests.includes("a '## Findings' section ranking the top risks")],
        ['repo: plan.md ends with the ranked Findings', fs.readFileSync(path.join(s.repo, 'plan.md'), 'utf8') === PLAN + FINDINGS],
      ];
    },
  },
  {
    name: 'autoplan', hook: 'autoplan-gate', flag: '--autoplan', skill: 'autoplan', prompt: 'run /autoplan on PLAN.md',
    seed: repo => fs.writeFileSync(path.join(repo, 'PLAN.md'), AP_PLAN),
    script: repo => [
      [{ type: 'text', text: 'Loading /autoplan.' }, { type: 'tool_use', id: 'toolu_a1', name: 'Skill', input: { skill: 'autoplan' } }],
      [{ type: 'tool_use', id: 'toolu_a2', name: 'Bash', input: { command: `bun --no-env-file --config=/dev/null "${path.join(ROOT, 'bin', 'gstack-autoplan-snapshot.ts')}" scope PLAN.md`, description: 'Phase 0 scope' } }],
      [{ type: 'text', text: '**Phase 3 complete.**\nOutside review: unavailable. Native subagent: completed: 1 issue.\nPassing to the Final Approval Gate.' }, { type: 'tool_use', id: 'toolu_d1', name: 'Bash', input: { command: 'true autoplan-published eng', description: 'Publish Phase 3 early' } }],
      [{ type: 'tool_use', id: 'toolu_d2', name: 'Bash', input: { command: 'true autoplan-published ceo', description: 'Publish Phase 1 with no report' } }],
      [{ type: 'text', text: '**Phase 1 complete.**\nOutside review: unavailable. Native subagent: completed: 2 issues.\nPassing to Phase 3.' }, { type: 'tool_use', id: 'toolu_a3', name: 'Bash', input: { command: 'true autoplan-published ceo', description: 'Publish Phase 1' } }],
      [{ type: 'text', text: 'Review complete.' }],
      [{ type: 'text', text: '**Phase 3 complete.**\nOutside review: unavailable. Native subagent: completed: 1 issue.\nPassing to the Final Approval Gate.' }, { type: 'tool_use', id: 'toolu_a4', name: 'Bash', input: { command: 'true autoplan-published eng', description: 'Publish Phase 3' } }],
      [{ type: 'tool_use', id: 'toolu_a5', name: 'Write', input: { file_path: path.join(repo, '.gstack', 'tmp', 'autoplan', 'gate.json'), content: '{"items":[]}\n' } }],
      [{ type: 'text', text: 'The Final Approval Gate is ready.' }],
    ],
    checks: s => {
      const h = s.record?.hooks['autoplan-gate'];
      const run0 = h ? Object.values(h.runs ?? {})[0] as Record<string, unknown> | undefined : undefined;
      return [
        ['claude -p exited 0', s.code === 0],
        ['record: one run, fired', !!run0 && typeof run0.fired_at === 'string'],
        ['record: blocked once (Stop after Phase 1)', run0?.blocked === 1],
        ['record: two publishes refused (Eng early, CEO with no report), the reported in-order ones never', run0?.denied === 2],
        ['log: refused via=publish out-of-order for eng and no-report for ceo', /event=blocked .*via=publish phase=eng why=out-of-order missing=ceo n=1/.test(s.log) && /event=blocked .*via=publish phase=ceo why=no-report missing=ceo n=2/.test(s.log)],
        ['requests: the model saw each refusal name the CEO report as due', (s.requests.match(/Next due: the Phase 1 \(CEO\) report\./g) ?? []).length >= 2],
        ['record: released with phases ceo,eng published', typeof run0?.released_at === 'string' && JSON.stringify(run0?.published) === '["ceo","eng"]' && JSON.stringify(run0?.phases) === '["ceo","eng"]'],
        ['record: no hook errors', (h?.errors ?? []).length === 0],
        ['log: fired, blocked missing=eng published=ceo, released phases=ceo,eng', /event=fired/.test(s.log) && /event=blocked .*via=stop missing=eng published=ceo n=1/.test(s.log) && /event=released .*phases=ceo,eng/.test(s.log)],
        ['transcript: the Stop block carries the blocked via=stop marker (hook_blocking_error)', /hook_blocking_error[^\n]*GSTACK_GATE autoplan-gate blocked [^"]*via=stop/.test(s.transcript)],
        ['transcript: fired and released ride hook_system_message', /hook_system_message[^\n]*GSTACK_GATE autoplan-gate fired/.test(s.transcript) && /hook_system_message[^\n]*GSTACK_GATE autoplan-gate released/.test(s.transcript)],
        ['requests: fired/released systemMessage markers never reach the model', !/autoplan-gate (fired|released)/.test(s.requests)],
        ['requests: the model saw the block reason naming Phase 3', /autoplan-gate blocked [^"]*missing=eng/.test(s.requests) && s.requests.includes('Next due: the Phase 3 (Eng) report.')],
      ];
    },
  },
];

function sse(content: Block[], model: string): string {
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

const readIf = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/** One scenario: its own HOME, repo and state root, one claude -p run against the scripted server. */
async function play(claude: string, sc: Scenario): Promise<[number, number]> {
  const dirs: Dirs = { home: path.join(work, sc.name, 'home'), repo: path.join(work, sc.name, 'repo'), state: path.join(work, sc.name, 'state') };
  fs.mkdirSync(path.join(dirs.home, '.claude', 'skills', sc.skill), { recursive: true });
  fs.copyFileSync(path.join(ROOT, sc.skill, 'SKILL.md'), path.join(dirs.home, '.claude', 'skills', sc.skill, 'SKILL.md'));
  fs.mkdirSync(dirs.repo, { recursive: true });
  sc.seed(dirs.repo);
  run('git', ['init', '-q', '-b', 'main'], dirs.repo);
  run('git', ['add', '-A'], dirs.repo);
  run('git', ['-c', 'user.name=Smoke fixture', '-c', 'user.email=smoke@gstack.test', 'commit', '-q', '-m', 'seed'], dirs.repo);
  const settingsFile = path.join(work, sc.name, 'settings.json');
  fs.writeFileSync(settingsFile, run(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(ROOT, 'bin', 'gstack-skill-gates'), 'settings', sc.flag], work));
  const script = sc.script(dirs.repo);

  const requests: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const raw = await req.text();
    requests.push(raw);
    if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 1 });
    const body = JSON.parse(raw || '{}');
    const main = Array.isArray(body.tools) && body.tools.length > 0;
    const content = main ? (script[body.messages.filter((m: { role: string }) => m.role === 'assistant').length] ?? [{ type: 'text', text: 'Done.' }]) : [{ type: 'text', text: 'ok' }];
    if (!body.stream) return Response.json({ id: 'msg_smoke', type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    return new Response(sse(content, body.model), { headers: { 'content-type': 'text/event-stream' } });
  } });

  const env = {
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`, HOME: dirs.home, GSTACK_STATE_ROOT: dirs.state,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: 'sk-smoke-not-a-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  };
  const proc = Bun.spawn([claude, '-p', sc.prompt, '--settings', settingsFile, '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--max-turns', '20'], { cwd: dirs.repo, env, stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => proc.kill(), 180_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(killer);
  server.stop(true);

  const projects = path.join(dirs.home, '.claude', 'projects');
  const transcripts = fs.existsSync(projects) ? fs.readdirSync(projects, { recursive: true }).map(String).filter(f => f.endsWith('.jsonl')) : [];
  const records = fs.existsSync(path.join(dirs.state, 'skill-gates')) ? fs.readdirSync(path.join(dirs.state, 'skill-gates')) : [];
  const seen: Seen = {
    code, repo: dirs.repo, requests: requests.join('\n'),
    transcript: transcripts.length ? readIf(path.join(projects, transcripts[0])) : '',
    record: records.length ? JSON.parse(readIf(path.join(dirs.state, 'skill-gates', records[0], 'record.json'))) : null,
    log: readIf(path.join(dirs.state, 'hooks', `${sc.hook}.log`)),
  };
  const checks = sc.checks(seen);
  process.stdout.write(`SCENARIO: ${sc.name} (${requests.length} requests)\n`);
  for (const line of new Set(seen.transcript.match(new RegExp(`GSTACK_GATE ${sc.hook} [a-z]+ [^"\\\\]*`, 'g')) ?? [])) process.stdout.write(`  transcript marker: ${line}\n`);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${sc.name}: ${name}\n`);
  const failed = checks.filter(([, ok]) => !ok).length;
  if (failed) process.stdout.write(`claude stdout: ${out.slice(0, 2000)}\nclaude stderr: ${err.slice(0, 2000)}\n`);
  return [failed, checks.length];
}

async function main(): Promise<number> {
  const claude = claudeBin();
  const version = run(claude, ['--version'], work).trim();
  process.stdout.write(`SMOKE: claude ${version} (fake Messages API, $0)\n`);
  let failed = 0;
  let total = 0;
  for (const sc of SCENARIOS) {
    const [f, n] = await play(claude, sc);
    failed += f;
    total += n;
  }
  if (failed) process.stdout.write(`work dir kept: ${work}\n`);
  else if (!keep) fs.rmSync(work, { recursive: true, force: true });
  process.stdout.write(`SMOKE_RESULT: ${failed ? 'fail' : 'pass'} scenarios=${SCENARIOS.length} checks=${total} failed=${failed}\n`);
  return failed ? 1 : 0;
}

main().then(code => process.exit(code), e => { process.stderr.write(`SMOKE_SETUP: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(2); });
