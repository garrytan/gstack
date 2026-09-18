import * as fs from 'node:fs';
import * as path from 'node:path';
import { readOwnedClaudeTranscript } from './owned-claude-transcript';
import type { ClaudePtySession } from './claude-pty-runner';

type SeedSession = Pick<ClaudePtySession, 'pid' | 'exited' | 'hermeticConfigDir' | 'send' | 'sendKey' | 'mark'> & {
  currentScreen: ClaudePtySession['currentScreenFrame'];
};
export class PlanSeedTimeout extends Error {}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const content = (row: any): any[] => typeof row.message?.content === 'string'
  ? [{ type: 'text', text: row.message.content }] : row.message?.content ?? [];

/** Separate paste, submission, native receipt and completed response. This is
 * preflight for the existing smoke budget, not another model turn allowance.
 * The retained live Bun child owns the PID on every platform; Linux additionally
 * verifies the independently understood native procStart and PID namespace.
 */
export async function submitPlanSeed(session: SeedSession, seed: string, opts: {
  cwd: string; launchedAt: number; deadlineAt: number;
  isQuestionOrPermission: (visible: string) => boolean;
}): Promise<void> {
  const pid = session.pid();
  const suppliedConfig = session.hermeticConfigDir;
  if (!pid || !suppliedConfig || !session.currentScreen) throw new Error('Plan seed requires an owned live session and decoded screen');
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(seed)) throw new Error('Plan seed contains terminal controls');
  const cwd = fs.realpathSync(opts.cwd);
  const config = fs.realpathSync(suppliedConfig);
  const statusFile = path.join(config, 'sessions', `${pid}.json`);
  let identity = '';
  let previous: string[] = [];
  let inode = '';

  function read() {
    if (session.exited() || session.pid() !== pid) throw new Error('Plan seed child exited or changed');
    const meta = fs.lstatSync(statusFile, { throwIfNoEntry: false });
    if (!meta) return null;
    if (!meta.isFile() || fs.realpathSync(statusFile) !== statusFile || meta.size > 64 * 1024) throw new Error('Invalid plan seed PID status file');
    // The CLI updates this status in place. An incomplete JSON read is not
    // an identity match; wait for a complete rewrite within the same budget.
    let status: any;
    try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    if (status.pid !== pid || status.cwd !== cwd || !UUID.test(status.sessionId ?? '')
      || status.kind !== 'interactive' || status.entrypoint !== 'cli'
      || typeof status.version !== 'string' || !status.version
      || typeof status.procStart !== 'string' || !status.procStart
      || typeof status.pidDomain !== 'string' || !status.pidDomain
      || !Number.isFinite(status.startedAt) || status.startedAt < opts.launchedAt || status.startedAt > Date.now()) {
      throw new Error('Plan seed PID status does not match this launch');
    }
    if (process.platform === 'linux') {
      const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ');
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      // Match the CLI's empty-string fallback for these optional domain pieces.
      // Process stat, parent, cwd and environment above/below remain required.
      let machineId = '', pidNamespace = '';
      try { machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch { /* CLI fallback */ }
      try { pidNamespace = fs.readlinkSync(`/proc/${pid}/ns/pid`); } catch { /* CLI fallback */ }
      const domain = `linux:${machineId}:${pidNamespace}`;
      if (fields[19] !== status.procStart || Number(fields[1]) !== process.pid
        || fs.readlinkSync(`/proc/${pid}/cwd`) !== cwd || status.pidDomain !== domain
        || !env.includes(`CLAUDE_CONFIG_DIR=${suppliedConfig}`)) throw new Error('Plan seed native process identity changed');
    }
    const key = JSON.stringify(['pid', 'cwd', 'sessionId', 'startedAt', 'procStart', 'pidDomain', 'version', 'kind', 'entrypoint'].map(k => status[k]));
    if (identity && key !== identity) throw new Error('Plan seed native session changed');
    identity = key;
    const transcript = readOwnedClaudeTranscript(config, status.sessionId);
    if (transcript.file) {
      const stat = fs.lstatSync(transcript.file);
      if (fs.realpathSync(transcript.file) !== transcript.file) throw new Error('Plan seed transcript path is substituted');
      const current = `${stat.dev}:${stat.ino}`;
      if (inode && inode !== current) throw new Error('Plan seed transcript was replaced');
      inode = current;
    }
    const rows = transcript.rows;
    if (rows.some(r => r.cwd != null && r.cwd !== cwd)) throw new Error('Foreign cwd in plan seed transcript');
    const serialized = rows.map(r => JSON.stringify(r));
    if (previous.some((r, i) => serialized[i] !== r)) throw new Error('Plan seed transcript prefix changed');
    previous = serialized;
    // Status can update activity, but cannot switch the launch or session while
    // the transcript is read. Never use a latest-file or filename-only binding.
    const afterMeta = fs.lstatSync(statusFile);
    if (!afterMeta.isFile() || fs.realpathSync(statusFile) !== statusFile) throw new Error('Plan seed PID status path was substituted');
    let after: any;
    try { after = JSON.parse(fs.readFileSync(statusFile, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    if (JSON.stringify(['pid', 'cwd', 'sessionId', 'startedAt', 'procStart', 'pidDomain', 'version', 'kind', 'entrypoint'].map(k => after[k])) !== key
      || session.exited()) throw new Error('Plan seed ownership changed during read');
    if (afterMeta.dev !== meta.dev || afterMeta.ino !== meta.ino) return null; // Atomic activity update: retry the same verified identity.
    return { rows, pendingBytes: transcript.pendingBytes, status: after };
  }

  async function until(check: () => boolean | Promise<boolean>) {
    while (Date.now() < opts.deadlineAt) {
      if (session.exited()) throw new Error('Plan seed child exited');
      const ready = await check();
      if (ready && Date.now() < opts.deadlineAt) return;
      await Bun.sleep(Math.min(100, Math.max(0, opts.deadlineAt - Date.now())));
    }
    throw new PlanSeedTimeout('Plan seed submission did not complete within the existing case budget');
  }
  const composer = (text: string): { line: string; row: number } | null => {
    const lines = text.split('\n');
    const rules = lines.flatMap((line, row) => /^─+$/.test(line) ? [row] : []);
    if (rules.length < 2) return null;
    const [top, bottom] = rules.slice(-2);
    // Native input sits above the viewport's one footer row. Locate it before
    // considering its contents; a historical box elsewhere is not an input.
    // More than one enclosed row may be a multiline draft, so leave it untouched.
    if (bottom !== lines.length - 2 || lines[top] !== lines[bottom] || bottom !== top + 2
      || !/^❯[ \u00a0]*/.test(lines[top + 1])
      || lines.slice(bottom + 1).some(line => /^❯[ \u00a0]*/.test(line))) return null;
    return { line: lines[top + 1], row: top + 1 };
  };
  const emptyStartupComposer = (frame: Awaited<ReturnType<NonNullable<SeedSession['currentScreen']>>>, rows: any[], input: { line: string; row: number }) => {
    const { line, row } = input, prefix = line.match(/^❯[ \u00a0]*/)![0];
    const value = line.slice(prefix.length).trimEnd();
    if (!value) return true;
    // Claude paints a Try suggestion only for an empty, untouched input. A
    // similarly worded real draft has normal cells and must remain blocked.
    if (rows.some(row => row.type === 'user' || row.type === 'assistant') || !/^Try "[^\r\n]+"$/.test(value)) return false;
    const spans = (frame.styledText ?? []).filter(span => span.row === row);
    return spans.some(span => span.start === prefix.length && span.text.trimEnd() === value && span.dim)
      || spans.some(span => span.start === prefix.length && span.text === 'T' && span.inverse)
        && spans.some(span => span.start === prefix.length + 1 && span.text.trimEnd() === value.slice(1) && span.dim);
  };
  let before = 0;
  await until(async () => {
    const owned = read();
    if (!owned || owned.pendingBytes || owned.status.waitingFor) return false;
    const frame = await session.currentScreen!();
    if (opts.isQuestionOrPermission(frame.text)) return false;
    const input = composer(frame.text);
    if (frame.rawEnd !== session.mark() || !input
      || !emptyStartupComposer(frame, owned.rows, input)) return false;
    const fresh = read();
    if (!fresh || fresh.pendingBytes || fresh.status.waitingFor || fresh.rows.length !== owned.rows.length) return false;
    before = fresh.rows.length;
    return true;
  });
  if (Date.now() >= opts.deadlineAt) throw new PlanSeedTimeout('Plan seed submission exhausted the existing case budget');
  session.send(`\x1b[200~${seed}\x1b[201~`);
  const pasted = `[Pasted text #1 +${(seed.match(/\n/g) ?? []).length} lines]`;
  await until(async () => {
    if (!read()) return false;
    const frame = await session.currentScreen!();
    const input = composer(frame.text);
    return frame.rawEnd === session.mark() && !!input
      && input.line.replace(/^❯[ \u00a0]*/, '').trimEnd() === pasted && !!read();
  });
  if (Date.now() >= opts.deadlineAt) throw new PlanSeedTimeout('Plan seed submission exhausted the existing case budget');
  session.sendKey('Enter'); // Separate input event after the acknowledged paste.
  await until(async () => {
    const owned = read();
    if (!owned || owned.pendingBytes) return false;
    const rows = owned.rows.slice(before);
    const users = rows.filter(r => r.type === 'user' && content(r).some(c => c.type === 'text'));
    if (!users.length) return false;
    if (users.length !== 1 || content(users[0]).length !== 1 || content(users[0])[0].text !== seed) throw new Error('Plan seed was fused, duplicated, or changed');
    const after = rows.slice(rows.indexOf(users[0]) + 1);
    const pending = new Set<string>();
    let complete = false;
    for (const row of after) {
      if (row.type === 'assistant') {
        complete = false;
        for (const c of content(row)) if (c.type === 'tool_use') {
          if (c.name === 'AskUserQuestion') throw new Error('Plan seed response requires an answer before skill invocation');
          pending.add(c.id);
        }
        complete = row.message?.stop_reason === 'end_turn' && content(row).some(c => c.type === 'text' && c.text.trim());
      }
      if (row.type === 'user') for (const c of content(row)) if (c.type === 'tool_result') pending.delete(c.tool_use_id);
    }
    if (!complete || pending.size || owned.status.waitingFor) return false;
    const frame = await session.currentScreen!();
    if (opts.isQuestionOrPermission(frame.text)) throw new Error('Plan seed response requires an answer before skill invocation');
    const input = composer(frame.text);
    if (frame.rawEnd !== session.mark() || !input
      || input.line.replace(/^❯[ \u00a0]*/, '').trim() !== '') return false;
    const fresh = read();
    return !!fresh && !fresh.pendingBytes && fresh.rows.length === owned.rows.length && !fresh.status.waitingFor;
  });
}
