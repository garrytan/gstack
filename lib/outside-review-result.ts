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

export type OutsideGate = 'review' | 'structured' | 'spec' | 'execution' | 'proposal';
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
  /** A P0-P3 label the parser could not read, quoted; set beside parsed blocking findings too. */
  unparsed?: string;
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
/**
 * Codex's own trailing error lines (`ERROR: ...`, `stream error: ...`), never
 * the whole stderr: it echoes the session prompt, which may quote any of the
 * phrases below. Mirrors the awk filter in bin/gstack-codex-probe.
 */
const CODEX_ERROR_LINE = /^\s*(?:\[[^\]]*\]\s*)?(?:ERROR:|stream error)/;
function codexErrorLines(stderr: string): string[] {
  let block: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (CODEX_ERROR_LINE.test(line)) block.push(line.trim());
    else if (line.trim()) block = [];
  }
  return block;
}
/** The account's usage limit: Codex's line carries the reset time, so it is relayed verbatim. Same signature as the probe. */
export const QUOTA_FAILURE = /usage limit|insufficient_quota|exceeded your current quota|quota exceeded/i;
/** A plain HTTP 429 or rate limit: transient, so a separate reason from the quota. */
export const RATE_LIMIT_FAILURE = /rate.?limit|too many requests|(?:^|[^0-9])429(?:[^0-9]|$)/i;
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
    const errors = exit !== 124 ? codexErrorLines(stderr) : [];
    const quota = errors.find(line => QUOTA_FAILURE.test(line));
    if (quota) return { state: 'unavailable', reason: 'quota_exhausted', detail: quota.slice(0, 240) };
    const rateLimit = errors.find(line => RATE_LIMIT_FAILURE.test(line));
    if (rateLimit) return { state: 'unavailable', reason: 'rate_limited', detail: rateLimit.slice(0, 240) };
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

/**
 * Severity words count as findings only in label position, never inside prose
 * ("high-level", "a low-risk change", "no critical findings"): `Severity: High`
 * or `Priority: high`, a leading `High:` / `High —` / `[High]` (after an
 * optional heading, bullet or number), a bold `**High**`, a table cell, or a
 * trailing `… — Medium.` / `… (High)` at the end of a finding line.
 * Critical and high block like P0/P1; medium and low are advisory like P2/P3.
 */
const SEVERITY_WORDS: Record<string, Severity> = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' };
const WORD = '(critical|high|medium|low)';
const SEVERITY_LABELS = [
  new RegExp(`\\b(?:severity|priority)\\b[\\t ]*[:=][\\t ]*(?:\\*\\*|__|\\[|\`)*${WORD}\\b`, 'gim'),
  new RegExp(`^[\\t ]*(?:>[\\t ]*)?(?:#{1,6}[\\t ]+|[-+*][\\t ]+|\\(?\\d{1,3}[.)][\\t ]+)?(?:\\*\\*|__)?\\[?${WORD}\\]?(?:\\*\\*|__)?[\\t ]*(?::|\u2014|\u2013|-[\\t ]|\\]|\\(|\\*\\*[\\t ]*(?:\u2014|\u2013|-[\\t ]))`, 'gim'),
  new RegExp(`(?:\\*\\*|__)\\[?${WORD}\\]?:?(?:\\*\\*|__)`, 'gi'),
  new RegExp(`\\|[\\t ]*(?:\\*\\*)?${WORD}(?:\\*\\*)?[\\t ]*(?=\\|)`, 'gi'),
  new RegExp(`[\\t ](?:\u2014|\u2013|-)[\\t ]+(?:\\*\\*|__)?${WORD}(?:\\*\\*|__)?[\\t ]*[.;]?[\\t ]*$`, 'gim'),
  new RegExp(`\\((?:severity:[\\t ]*)?${WORD}\\)[\\t ]*[.;]?[\\t ]*$`, 'gim'),
];
function severityWords(text: string): Severity[] {
  return SEVERITY_LABELS.flatMap(re => [...text.matchAll(re)].map(m => SEVERITY_WORDS[m[1]!.toLowerCase()]!));
}
/**
 * A no-findings statement opening a sentence: NO_FINDINGS (its underscore is
 * gone after plainReview), "No issues found", "I found no actionable
 * regressions", "I did not find any bugs". Never a phrase inside another
 * clause ("renaming the flag is no problem for callers, but ...").
 */
const FINDING_NOUN = '(?:(?:actionable|significant|new|concrete)\\s+)?(?:bugs?|issues?|findings?|problems?|regressions?|defects?)\\b';
const NO_FINDINGS_LEAD = '(?:(?:overall|in summary|in short|summary|conclusion|result)[,:]?\\s+|(?:after|having|on|upon)\\s+(?:reviewing|reading|checking|inspecting|reviewed|read|checked|inspected)\\b[^,.;]{0,80},\\s+)?';
const NO_FINDINGS = new RegExp(`^${NO_FINDINGS_LEAD}(?:NO_?FINDINGS\\b|(?:(?:i|we)\\s+(?:found|see|saw|identified)\\s+|there\\s+(?:are|were|is)\\s+)?no\\s+${FINDING_NOUN}|(?:i|we)\\s+(?:did not|didn't|could not|couldn't|cannot|can't)\\s+(?:find|identify|see)\\s+any\\s+${FINDING_NOUN})`, 'i');
/** A contrast or exception qualifies the claim, so the sentence does not conclude that nothing was found. */
const NO_FINDINGS_EXCEPTION = /(?<![\w-])(?:but|however|although|though|yet|except|excluding|unless|only|apart from|aside from|other than|besides|beyond|elsewhere|otherwise)(?![\w-])/i;
const NO_FINDINGS_PREDICATE = /^\s*(?:(?:was|were|is|are|has been|have been)\s+)?(?:found|identified|detected|evident|apparent|introduced|remain|exist|to report)?/i;
const WHOLE_CHANGE_SCOPE = /^(?:in|within|across|throughout|with|from|for)\s.*\b(?:chang(?:e|es|ed)|diffs?|patch(?:es)?|staged|unstaged|untracked|branch|commits?|pull request|PR)\b/i;

/**
 * The review's conclusion says it found nothing: its last prose sentence or
 * ", and" clause (a wrapped line that continues in lowercase joined), or the because-clause of its
 * Recommendation line, is an unqualified no-findings statement. When other
 * prose precedes it, anything after the statement other than a predicate
 * ("were found", "is evident") or a colon explanation must scope it to the
 * change as a whole: "No issues in the parser." or "No regressions were found
 * by the tests." says nothing about the rest of the reply.
 */
function concludesNoFindings(code: string): boolean {
  let prose = '', because: string | undefined, recommendationOpen = false;
  for (const line of code.split(/\r?\n/)) {
    const text = plainReview(line).trim();
    const listed = /^[\t ]*(?:#{1,6}|[-+*])[\t ]/.test(line);
    if (recommendationOpen && text && !listed) {
      because = `${because} ${text}`;
      recommendationOpen = !/[.!?]$/.test(text);
      continue;
    }
    recommendationOpen = false;
    if (!text || /^(?:Recommendation|Verdict)[\t ]*:/i.test(text)) {
      const clause = text.match(/^Recommendation[\t ]*:.*?\bbecause\b[\t ]*(\S.*)$/i)?.[1];
      if (clause) { because = clause; recommendationOpen = !/[.!?]$/.test(clause); }
      prose += '\n';
    } else if (/^[\t ]*#{1,6}[\t ]/.test(line)) prose += `\n${text}\n`;
    else prose += listed || prose.endsWith('\n') || /[.!?;:]$/.test(prose) || !/^[a-z]/.test(text) ? `\n${text}` : ` ${text}`;
  }
  const sentences = prose.split(/(?<=[.!?;])\s+|\n|,\s+and\s+/i).map(sentence => sentence.trim()).filter(Boolean);
  const total = sentences.length + (because ? 1 : 0);
  return [sentences.at(-1), because].some(conclusion => {
    const statement = conclusion?.match(NO_FINDINGS)?.[0];
    if (!conclusion || !statement || NO_FINDINGS_EXCEPTION.test(conclusion)) return false;
    const qualifier = conclusion.slice(statement.length).replace(NO_FINDINGS_PREDICATE, '').replace(/[\s.!]+$/, '').trim();
    return total === 1 || !qualifier || qualifier.startsWith(':') || WHOLE_CHANGE_SCOPE.test(qualifier);
  });
}

/** Formatting the requested marker in bold, inline code, or a list does not invalidate a completed review. */
function plainReview(text: string): string {
  return text.split(/\r?\n/).map(line => line.replace(/^[\t ]*(?:#{1,6}[\t ]+|[-+*][\t ]+)?/, '').replace(/[*_`]/g, '')).join('\n');
}

/**
 * Code quotes text, so a severity inside a fence or an inline code span is not
 * a label. An inline span holding only a severity token in label position
 * (`- \`P1\`: x`, `Severity: \`High\``, a table cell) is formatting and stays.
 */
const CODE_LABEL_BEFORE = /^[\t ]*(?:>[\t ]*)?(?:#{1,6}[\t ]+|[-+*][\t ]+|\(?\d{1,3}[.)][\t ]+)?(?:\*\*|__)?$|\b(?:severity|priority)[\t ]*[:=][\t ]*(?:\*\*|__)?$|\|[\t ]*(?:\*\*)?$/i;
function withoutCode(text: string): string {
  let fence: string | undefined;
  return text.split(/\r?\n/).map(line => {
    const marker = /^[\t ]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return '';
    }
    if (marker) { fence = marker; return ''; }
    return line.replace(/`([^`]+)`/g, (span, inner: string, at: number) =>
      inner.trim() === 'NO_FINDINGS' || /^\[?(?:P[0-3]|critical|high|medium|low)\]?$/i.test(inner.trim()) && CODE_LABEL_BEFORE.test(line.slice(0, at)) ? inner : ' ');
  }).join('\n');
}

/**
 * P0-P3 in label position: at a line start after an optional quote, heading,
 * bullet, number or bold, as `[P1]`, `P1:`, `P1 —`, `**P1 — x**`, `**P1** — x`,
 * `P1 (x)` or a bare `P1` ending the line; or a table cell `| P1 |`.
 */
const LABEL_START = '^[\\t ]*(?:>[\\t ]*)?(?:#{1,6}[\\t ]+|[-+*][\\t ]+|\\(?\\d{1,3}[.)][\\t ]+)?(?:\\*\\*|__)?';
const LABELED_P = new RegExp(`${LABEL_START}(?:\\[(P[0-3])\\]|(P[0-3])(?:\\*\\*|__)?[\\t ]*(?::|\u2014|\u2013|-[\\t ]|\\(|$|(?:\\*\\*|__)[\\t ]*(?::|\u2014|\u2013|-[\\t ]|$)))`, 'gm');
const TABLE_P = /\|[\t ]*(?:\*\*)?\[?(P[0-3])\]?(?:\*\*)?[\t ]*(?=\|)/g;
const LABEL_P = new RegExp(`${LABEL_START}\\[?P[0-3]\\b`);

function severityTokens(text: string): Severity[] {
  return [...[...text.matchAll(LABELED_P)].map(m => (m[1] ?? m[2]) as Severity),
    ...[...text.matchAll(TABLE_P)].map(m => m[1] as Severity)];
}

/** The first line with a P0-P3 token in label position that no severity form reads. */
function firstUnparsed(text: string): string | undefined {
  const lines = text.split('\n');
  const at = lines.findIndex(line => LABEL_P.test(line) && !new RegExp(LABELED_P.source, 'm').test(line));
  return at < 0 ? undefined : `line ${at + 1}: "${lines[at]!.trim().slice(0, 160)}"`;
}

/** The reply's last `Verdict:` line says it is not ready. */
function verdictNotReady(plain: string): boolean {
  const last = [...plain.matchAll(/^[\t ]*Verdict[\t ]*:[\t ]*([^\r\n]*)$/gim)].at(-1)?.[1];
  return last !== undefined && /^not[\t ]+ready\b/i.test(last.trim());
}

export function classifyOutsideReview(input: OutsideReviewInput): OutsideReviewClassification {
  const plain = plainReview(input.text);
  const reviewed = input.gate !== 'proposal';
  const code = withoutCode(input.text), plainCode = plainReview(code);
  const levels = [...[...plainCode.matchAll(/\[(P[0-3])\]|^(P[0-3]):/gm)].map(m => (m[1] ?? m[2]) as Severity),
    ...severityTokens(code), ...(reviewed ? severityWords(code) : [])];
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
  if ((input.gate === 'review' || input.gate === 'proposal') && !/^Recommendation:[\t ]*[^\r\n]+\bbecause\b[\t ]*\S[^\r\n]+$/im.test(plain)) {
    return result('unavailable', 'missing_markers', 'missing review completion recommendation');
  }
  if (!reviewed) return result(blocking ? 'findings' : 'clean');
  const unparsed = firstUnparsed(code);
  // A last explicit not-ready blocks even when the only parsed severities are advisory.
  const notReady = verdictNotReady(plainCode);
  if (blocking || notReady) return { ...result('findings'), ...(unparsed ? { unparsed } : {}) };
  if (unparsed) return { ...result('unverified', 'unparsed_severity', unparsed), unparsed };
  if ((input.gate === 'structured' || input.gate === 'review') && !findings.highest && !concludesNoFindings(code)) {
    return result('unverified', 'untagged_review', 'missing severity or explicit no-findings conclusion');
  }
  return result('clean');
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
const GATES = ['review', 'structured', 'spec', 'execution', 'proposal'];
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
  const label = flags['--label'] ?? 'Outside review';
  console.log(`VERDICT: ${checked.verdict}`);
  console.log(`FINDINGS: ${checked.findings.highest ?? (checked.verdict === 'findings' ? 'unspecified' : 'none')}`);
  if (checked.unparsed) console.log(`UNPARSED: ${checked.unparsed}`);
  if (checked.reason) {
    console.log(`REASON: ${checked.reason}`);
    console.error(gateOutcomeLine(label, checked.reason, checked.detail));
  } else if (checked.unparsed) {
    const outcome = GATE_OUTCOMES.unparsed_severity;
    console.error(`${label}: findings block this review; separately, ${outcome.summary} (${checked.unparsed}). Fix: ${outcome.fix}.`);
  }
  process.exit(VERDICT_EXIT[checked.verdict]);
}
