/**
 * Autoplan journal drift canary (periodic tier, rule kind, ~$0.02, haiku).
 *
 * The /autoplan publication guard reads Claude Code's own session journal and
 * must prove which records belong to the parent session. Claude Code has
 * changed that journal's root shape before (SessionStart hook attachments,
 * #3007/#2968; resumed forks that begin at a compact boundary, #2977), and each
 * change bricked /autoplan for users until a release. This canary captures real
 * journals from the pinned `claude` with a SessionStart hook installed, for
 * startup, /compact and `--resume --fork-session`, and runs the guard's reader on
 * them, so the next format change fails this lane instead of users.
 *
 * It never files issues; the periodic report job owns that.
 */
import { expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JUDGE_MS } from './helpers/eval-budgets';
import { describeIfSelected, testIfSelected } from './helpers/e2e-helpers';
import { resolveClaudeCommand } from '../lib/claude-bin';
import { readOwnedClaudePublicTranscript, readPlanCountTranscript } from '../lib/claude-public-transcript';

const ROOT = path.resolve(import.meta.dir, '..');
const CANARY_MODEL = 'claude-haiku-5-5';
const PINNED = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/.exec(
  fs.readFileSync(path.join(ROOT, '.github/docker/Dockerfile.ci'), 'utf8'))?.[1];

describeIfSelected('autoplan journal drift canary', ['autoplan-journal-drift'], () => {
  testIfSelected('autoplan-journal-drift', async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('autoplan-journal-drift requires ANTHROPIC_API_KEY; refusing to skip');
    const claude = resolveClaudeCommand();
    if (!claude || !PINNED) throw new Error('autoplan-journal-drift needs the claude CLI and the Dockerfile.ci pin');
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-journal-drift-')));
    try {
      const config = path.join(base, 'home', '.claude'), project = path.join(base, 'project');
      fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(project);
      // Two SessionStart hooks, one plain and one with additionalContext, the
      // shape plugins install and #3007 reported.
      fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [
        { type: 'command', command: 'echo drift-canary-hook' },
        { type: 'command', command: `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'drift canary' } })}'` },
      ] }] } }));
      const env = { PATH: process.env.PATH ?? '', HOME: path.join(base, 'home'), ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', TERM: 'dumb' };
      const claudeRun = (...args: string[]) => {
        const child = spawnSync(claude.command, [...claude.argsPrefix, ...args], { cwd: project, env, encoding: 'utf8', timeout: 90_000 });
        if (child.status !== 0) throw new Error(`claude ${args.join(' ')} exited ${child.status ?? child.signal}: ${child.stderr.slice(-400)}`);
        return child.stdout;
      };
      expect(claudeRun('--version')).toContain(PINNED);
      const journals = () => {
        const projects = path.join(config, 'projects');
        return fs.readdirSync(projects).flatMap(dir => fs.readdirSync(path.join(projects, dir))
          .filter(name => name.endsWith('.jsonl')).map(name => path.join(projects, dir, name)));
      };
      const owned = (file: string) => readOwnedClaudePublicTranscript(file, project, path.basename(file, '.jsonl'));
      const shape = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(r => r.uuid).map(r => [r.type, r.subtype, r.attachment?.type].filter(Boolean).join(':')).slice(0, 6);
      const expectOwned = (file: string, label: string) => {
        const read = owned(file);
        if (read.transcript.status !== 'ready')
          throw new Error(`${label}: Claude Code ${PINNED} journal is not owned (${read.transcript.reason ?? read.transcript.status}); head ${JSON.stringify(shape(file))}`);
        expect(read.events.some(e => e.kind === 'message')).toBe(true);
      };

      claudeRun('-p', 'Reply with the single word: ok', '--model', CANARY_MODEL, '--strict-mcp-config');
      const [startup] = journals();
      expect(journals()).toHaveLength(1);
      expectOwned(startup!, 'startup');
      expect(readPlanCountTranscript(config, project).status).toBe('ready');
      const session = path.basename(startup!, '.jsonl');

      claudeRun('-p', '/compact', '--resume', session, '--model', CANARY_MODEL, '--strict-mcp-config');
      expect(fs.readFileSync(startup!, 'utf8')).toContain('"compact_boundary"');
      expectOwned(startup!, 'compact');

      claudeRun('-p', 'Reply with the single word: ok', '--resume', session, '--fork-session', '--model', CANARY_MODEL, '--strict-mcp-config');
      const fork = journals().find(file => file !== startup);
      expect(fork).toBeDefined();
      expectOwned(fork!, 'fork after compact');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, JUDGE_MS * 3);
});
