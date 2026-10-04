/**
 * Review-specific completion evidence, separate from provider transport success.
 *
 * classifyOutsideReview() is the INV-1 contract: it takes the review text, the
 * provider's stderr and exit status (and, for `codex exec --json`, the event
 * stream) and returns three separate answers: did the review execute, what is
 * the highest finding severity, and the verdict. validateOutsideReview() is the
 * older text-only shape, kept for direct importers and stale rendered skills.
 */
import { GATE_OUTCOMES, gateOutcomeLine, type GateReason } from './gate-outcomes';

export type OutsideGate = 'review' | 'structured' | 'spec' | 'execution';
export type OutsideVerdict = 'clean' | 'findings' | 'unverified' | 'unavailable';
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export interface OutsideReviewInput {
  text: string;
  gate: OutsideGate;
  stderr?: string;
  exit?: number;
  /** JSONL from `codex exec --json`: command events are positive execution evidence. */
  events?: string;
}

export interface OutsideReviewClassification {
  execution: { state: 'ran' } | { state: 'unavailable'; reason: GateReason; detail?: string };
  findings: { highest: Severity | null };
  verdict: OutsideVerdict;
  /** Set for every verdict except clean/findings. */
  reason?: GateReason;
  detail?: string;
  score?: number;
}

const REFUSAL = /\b(?:(?:I (?:cannot|can't|won't|will not|am unable to)|I'm unable to)\s+(?:review|analy[sz]e|evaluate|assess|inspect|access|complete|perform|provide|assist|help|proceed)|unable to (?:review|analy[sz]e)|I must (?:decline|refuse))\b/i;

/**
 * Sandbox setup failures as Codex and bubblewrap print them on stderr (fixtures:
 * test/fixtures/codex-sandbox/). Read from stderr and failed command output
 * only: a review that merely discusses bwrap or namespaces must still pass, and
 * a healthy run warns "could not find bubblewrap on PATH" while working.
 */
const SANDBOX_FAILURE = /^\s*bwrap: \S.*$|^.*\bbubblewrap is unavailable\b.*$|^.*\blandlock\b.{0,60}\b(?:fail\w*|error|not supported|unsupported)\b.*$|^.*\bseccomp\b.{0,60}\b(?:fail\w*|error)\b.*$|^.*\buser namespaces?\b.{0,80}\b(?:not (?:allowed|permitted|supported)|denied|disabled)\b.*$/im;
/** Exact phrases a reviewer uses when it could not execute; the last fallback, used only without positive evidence. */
const EXECUTION_FAILURE_PHRASE = /\b(?:commands? (?:could not|couldn't|cannot|can't) (?:be )?run|(?:could not|couldn't|was unable to|am unable to|unable to) (?:run (?:any )?(?:shell )?commands|execute (?:any )?commands|inspect the diff|read the diff|access the diff)|the diff could not be (?:read|inspected|accessed)|every (?:shell )?(?:command|invocation) failed)\b/i;
/** `codex review` transcript on stderr: a command that ran prints " succeeded in Nms:". */
const TRANSCRIPT_SUCCESS = /^\s*succeeded in \d+(?:\.\d+)?m?s:?\s*$/m;

function commandEvidence(events: string): { attempted: number; succeeded: number; failedOutput: string } {
  let attempted = 0, succeeded = 0, failedOutput = '';
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event?.item;
    if (event?.type !== 'item.completed' || item?.type !== 'command_execution') continue;
    attempted++;
    if (item.status === 'completed' && item.exit_code === 0) succeeded++;
    else failedOutput += `${typeof item.aggregated_output === 'string' ? item.aggregated_output : ''}\n`;
  }
  return { attempted, succeeded, failedOutput };
}

function stderrHead(stderr: string): string | undefined {
  return stderr.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 240);
}

function execution(input: OutsideReviewInput): OutsideReviewClassification['execution'] {
  const stderr = input.stderr ?? '';
  const exit = input.exit ?? 0;
  const sandbox = (output: string) => output.match(SANDBOX_FAILURE)?.[0].trim().slice(0, 240);
  if (exit !== 0) {
    const detail = sandbox(stderr);
    if (detail) return { state: 'unavailable', reason: 'sandbox_unavailable', detail };
    const head = stderrHead(stderr);
    return { state: 'unavailable', reason: exit === 124 ? 'timeout' : 'execution_failed', detail: head ? `exit ${exit}: ${head}` : `exit ${exit}` };
  }
  const commands = commandEvidence(input.events ?? '');
  const executed = commands.succeeded > 0 || TRANSCRIPT_SUCCESS.test(stderr);
  if (!executed) {
    const detail = sandbox(stderr) ?? sandbox(commands.failedOutput);
    if (detail) return { state: 'unavailable', reason: 'sandbox_unavailable', detail };
    if (commands.attempted > 0) return { state: 'unavailable', reason: 'commands_failed', detail: `all ${commands.attempted} commands failed` };
  }
  if (!input.text.trim()) return { state: 'unavailable', reason: 'empty_response' };
  const phrase = executed ? undefined : input.text.match(EXECUTION_FAILURE_PHRASE)?.[0];
  if (phrase) return { state: 'unavailable', reason: 'commands_failed', detail: `the review says "${phrase}"` };
  if (REFUSAL.test(input.text)) return { state: 'unavailable', reason: 'review_refused' };
  return { state: 'ran' };
}

/** Formatting the requested marker in bold, inline code, or a list does not invalidate a completed review. */
function plainReview(text: string): string {
  return text.split(/\r?\n/).map(line => line.replace(/^[\t ]*(?:#{1,6}[\t ]+|[-+*][\t ]+)?/, '').replace(/[*_`]/g, '')).join('\n');
}

export function classifyOutsideReview(input: OutsideReviewInput): OutsideReviewClassification {
  const plain = plainReview(input.text);
  const levels = [...plain.matchAll(/\[(P[0-3])\]|^(P[0-3]):/gm)].map(m => (m[1] ?? m[2]) as Severity);
  const findings = { highest: levels.length ? levels.sort()[0]! : null };
  const ran = execution(input);
  if (ran.state === 'unavailable') return { execution: ran, findings, verdict: 'unavailable', reason: ran.reason, detail: ran.detail };
  const blocking = findings.highest === 'P0' || findings.highest === 'P1';
  const result = (verdict: OutsideVerdict, reason?: GateReason, detail?: string): OutsideReviewClassification =>
    ({ execution: ran, findings, verdict, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });
  if (input.gate === 'spec') {
    const scores = [...input.text.matchAll(/^SCORE:[\t ]*(10|[0-9])[\t ]*\r?$/gm)];
    const ambiguities = [...input.text.matchAll(/^AMBIGUITIES:[\t ]*(\S[^\r\n]*)\r?$/gm)];
    if (scores.length !== 1 || ambiguities.length !== 1) return result('unavailable', 'missing_markers', 'missing or invalid SCORE/AMBIGUITIES markers');
    const score = Number(scores[0]![1]);
    return { ...result(score >= 7 ? 'clean' : 'findings'), score };
  }
  if (input.gate === 'structured') {
    const clear = /\bNO_FINDINGS\b|\bno (?:actionable |significant |new |concrete )?(?:bugs|issues|findings|problems)\b|\b(?:did not|didn't) (?:find|identify) any (?:actionable |new |concrete )?(?:bugs|issues|findings|problems)\b/i.test(input.text);
    if (!findings.highest && !clear) return result('unverified', 'untagged_review', 'missing severity or explicit no-findings conclusion');
    return result(blocking ? 'findings' : 'clean');
  }
  if (input.gate === 'review' && !/^Recommendation:[\t ]*[^\r\n]+\bbecause\b[\t ]*\S[^\r\n]+$/im.test(plain)) {
    return result('unavailable', 'missing_markers', 'missing review completion recommendation');
  }
  return result(blocking ? 'findings' : 'clean');
}

const LEGACY_REASONS: Partial<Record<GateReason, string>> = {
  empty_response: 'empty response',
  review_refused: 'review refused',
};

/** Text-only compatibility shape for direct importers (claude-code/SKILL.md.tmpl) and the two-argument CLI. */
export function validateOutsideReview(text: string, gate: OutsideGate): { completed: boolean; reason?: string; score?: number; gate?: 'pass' | 'fail' } {
  const checked = classifyOutsideReview({ text, gate });
  if (checked.verdict === 'unavailable' || checked.verdict === 'unverified') {
    const reason = LEGACY_REASONS[checked.reason!] ?? checked.detail ?? GATE_OUTCOMES[checked.reason!].summary;
    return { completed: false, reason };
  }
  if (gate === 'spec') return { completed: true, score: checked.score, gate: checked.verdict === 'clean' ? 'pass' : 'fail' };
  if (gate === 'structured') return { completed: true, gate: checked.verdict === 'findings' ? 'fail' : 'pass' };
  return { completed: true };
}

const VERDICT_EXIT: Record<OutsideVerdict, number> = { clean: 0, findings: 3, unverified: 4, unavailable: 1 };
const GATES = ['review', 'structured', 'spec', 'execution'];
const USAGE = `Usage: outside-review-result.ts <gate> <response-file>
       outside-review-result.ts --verdict [--stderr <file>] [--exit <code>] [--events <file>] [--label <name>] <gate> <response-file>
Gates: ${GATES.join('|')}. Two-argument form exits 0 completed, 1 unavailable, 2 usage.
Verdict form prints VERDICT: clean|findings|unverified|unavailable and exits 0, 3, 4 or 1.`;

async function readOptional(file: string | undefined): Promise<string> {
  if (!file) return '';
  try { return await Bun.file(file).text(); } catch { return ''; }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let verdictMode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--verdict') verdictMode = true;
    else if (['--stderr', '--exit', '--events', '--label'].includes(arg) && i + 1 < args.length) { flags[arg] = args[++i]!; verdictMode ||= arg !== '--label'; }
    else if (arg.startsWith('--')) { console.error(USAGE); process.exit(2); }
    else positional.push(arg);
  }
  const [gate, path] = positional;
  const exit = flags['--exit'] === undefined ? 0 : Number(flags['--exit']);
  if (!gate || !GATES.includes(gate) || !path || positional.length !== 2 || !Number.isInteger(exit)
      || (!verdictMode && gate === 'execution')) { console.error(USAGE); process.exit(2); }
  let text: string;
  try { text = await Bun.file(path).text(); } catch (error) {
    if (!verdictMode) { console.error(`Outside review unavailable: ${error}`); process.exit(1); }
    text = '';
  }
  if (!verdictMode) {
    const result = validateOutsideReview(text, gate as OutsideGate);
    if (!result.completed) { console.error(`Outside review unavailable: ${result.reason}; missing coverage.`); process.exit(1); }
    process.exit(0);
  }
  const checked = classifyOutsideReview({ text, gate: gate as OutsideGate, exit,
    stderr: await readOptional(flags['--stderr']), events: await readOptional(flags['--events']) });
  console.log(`VERDICT: ${checked.verdict}`);
  console.log(`FINDINGS: ${checked.findings.highest ?? 'none'}`);
  if (checked.reason) {
    console.log(`REASON: ${checked.reason}`);
    console.error(gateOutcomeLine(flags['--label'] ?? 'Outside review', checked.reason, checked.detail));
  }
  process.exit(VERDICT_EXIT[checked.verdict]);
}
