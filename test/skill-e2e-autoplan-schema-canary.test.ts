/**
 * Latest-release schema canary (periodic tier, rule kind, ~$0.02, haiku; runs
 * daily from evals-periodic.yml).
 *
 * The /autoplan publication guard compares each PreToolUse payload with the
 * journal record of the same call. Claude Code 2.1.29x's fork-subagent gate
 * dropped run_in_background from the Agent payload while the journal kept the
 * model's raw input, and CI (pinned to an older CLI) never saw it. This case
 * installs the LATEST published Claude Code (scripts off, registry signatures
 * audited), runs one headless session with the fork gate on (the interactive
 * default) whose PreToolUse hook records one Agent and one Read payload, and
 * checks them against the journal with the guard's own comparison. It also
 * checks the background-reviewer records the guard reads (async launch,
 * completion notice). Flush timing is out of its reach (headless).
 */
import { expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JUDGE_MS } from './helpers/eval-budgets';
import { describeIfSelected, testIfSelected } from './helpers/e2e-helpers';
import { resolveClaudeCommand } from '../lib/claude-bin';
import { readOwnedClaudePublicTranscript } from '../lib/claude-public-transcript';
import { schemaDrift, type HookPayload } from './helpers/schema-canary';

const CANARY_MODEL = 'claude-haiku-4-5-20251001';
const PACKAGE = '@anthropic-ai/claude-code';

describeIfSelected('autoplan schema canary (latest Claude Code)', ['autoplan-schema-canary'], () => {
  testIfSelected('autoplan-schema-canary', async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('autoplan-schema-canary requires ANTHROPIC_API_KEY; refusing to skip');
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-schema-canary-')));
    try {
      const prefix = path.join(base, 'cli'), config = path.join(base, 'home', '.claude'), project = path.join(base, 'project');
      for (const dir of [prefix, config, project]) fs.mkdirSync(dir, { recursive: true });
      const npm = (...args: string[]) => {
        const child = spawnSync('npm', args, { cwd: prefix, encoding: 'utf8', timeout: 180_000,
          env: { PATH: process.env.PATH ?? '', HOME: path.join(base, 'home'), npm_config_update_notifier: 'false' } });
        if (child.status !== 0) throw new Error(`npm ${args.join(' ')} exited ${child.status ?? child.signal}: ${child.stderr.slice(-600)}`);
        return child.stdout;
      };
      // Supply chain: no install scripts run; the registry signatures are verified before the binary is used.
      fs.writeFileSync(path.join(prefix, 'package.json'), '{"private":true}\n');
      npm('install', '--ignore-scripts', '--no-audit', '--no-fund', `${PACKAGE}@latest`);
      npm('audit', 'signatures');
      const native = path.join(prefix, 'node_modules', `${PACKAGE}-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (!fs.existsSync(native)) throw new Error(`the latest ${PACKAGE} ships no native binary for ${process.platform}-${process.arch}`);
      const claude = resolveClaudeCommand({ ...process.env, GSTACK_CLAUDE_BIN: native });
      if (!claude || claude.command !== native) throw new Error('GSTACK_CLAUDE_BIN did not select the freshly installed CLI');

      const record = path.join(base, 'payloads.jsonl');
      fs.writeFileSync(path.join(project, 'note.txt'), 'schema canary\n');
      fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Agent|Read', hooks: [
        { type: 'command', command: `cat >> '${record}' && echo >> '${record}' && echo '{}'` }] }] } }));
      const env = { PATH: process.env.PATH ?? '', HOME: path.join(base, 'home'), ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', TERM: 'dumb', CLAUDE_CODE_FORK_SUBAGENT: '1' };
      const run = (...args: string[]) => {
        const child = spawnSync(claude.command, [...claude.argsPrefix, ...args], { cwd: project, env, encoding: 'utf8', timeout: 150_000 });
        if (child.status !== 0) throw new Error(`claude ${args.join(' ')} exited ${child.status ?? child.signal}: ${child.stderr.slice(-400)}`);
        return child.stdout;
      };
      const version = run('--version').trim();
      run('-p', 'First use the Read tool to read note.txt. Then call the Agent tool exactly once with description "canary", ' +
        'subagent_type "general-purpose", prompt "Reply with the single word OK." and run_in_background set to false; include ' +
        'run_in_background even if the tool schema lacks it. Wait for the agent, then reply DONE.',
        '--model', CANARY_MODEL, '--strict-mcp-config', '--allowedTools', 'Read,Agent');

      const payloads = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as HookPayload & { transcript_path: string; session_id: string });
      expect(payloads.length).toBeGreaterThan(0);
      const journal = payloads[0]!.transcript_path;
      const records = fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      const inputs = new Map<string, Record<string, unknown>>();
      for (const r of records) for (const block of r.message?.content ?? [])
        if (block?.type === 'tool_use' && r.isSidechain === false) inputs.set(block.id, block.input);
      const problems = schemaDrift(payloads, inputs);
      if (problems.length) throw new Error(`Claude Code ${version} breaks the /autoplan guard's payload assumptions:\n- ${problems.join('\n- ')}`);

      // Background reviewers: an async launch must be followed by a completion notice the guard's reader projects.
      const agent = payloads.find(p => p.tool_name === 'Agent')!;
      const launch = records.find(r => r.type === 'user' && (r.message?.content ?? []).some?.((b: any) => b?.tool_use_id === agent.tool_use_id));
      if (launch?.toolUseResult?.isAsync === true) {
        const notice = records.find(r => r.origin?.kind === 'task-notification' && typeof r.message?.content === 'string' &&
          r.message.content.includes(`<tool-use-id>${agent.tool_use_id}</tool-use-id>`));
        if (!notice) throw new Error(`Claude Code ${version}: background Agent ${agent.tool_use_id} has no task-notification record`);
        expect({ promptSource: notice.promptSource, isMeta: notice.isMeta === true }).toEqual({ promptSource: 'system', isMeta: false });
        const owned = readOwnedClaudePublicTranscript(journal, project, payloads[0]!.session_id);
        expect(owned.transcript.status).toBe('ready');
        expect(owned.events.some(e => e.kind === 'result' && e.toolUseId === agent.tool_use_id && e.async === true)).toBe(true);
        expect(owned.events.some(e => e.kind === 'task_notification' && e.notifiedToolUseId === agent.tool_use_id)).toBe(true);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, JUDGE_MS * 3);
});
