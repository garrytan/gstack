import type { AutoDecisionState } from './auto-decision-state';
import type { NativePublicToolEvent, PlanCountTranscript } from './plan-count-transcript';

export interface NativeAutoDecision {
  sessionId: string;
  skillToolUseId?: string;
  preambleToolUseId?: string;
  preferenceToolUseId?: string;
  questionLogToolUseId?: string;
  timestamp: string;
  summary: string;
  option: string;
  annotation: string;
  stateRecord?: Record<string, unknown>;
}

const plain = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, '$1').trim();
const annotationLine = /^Auto-decided ([^\r\n→]{1,240}) → ([^\r\n→]{1,200}) \(your (?:preference|saved preference on `([a-z][a-z0-9-]*)`)\)\. Change with \/plan-tune\.$/;

/** Asserted prose only; later quoted examples cannot retract a current decision. */
function publicProse(text: string): string {
  const lines: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = undefined;
      continue;
    }
    if (fence || /^(?: {4}|\t|\s*>)/.test(line)) continue;
    const current = plain(line);
    // A quoted name is still the target of an otherwise asserted mode field.
    // Preserve only that slot; whole quoted declarations remain non-assertions.
    const correction = /^(?:Correction|Actually|Update):\s*/i.test(current);
    lines.push(current.replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, (quoted, offset) => {
      const field = modeField(current.slice(0, offset) + '""');
      if (field && modeNames.some(mode => field.value.toUpperCase() === `${mode} FOR ""`)) return quoted;
      return correction ? quoted.replace(/["“”`]/g, '') : '""';
    }));
  }
  return lines.join('\n');
}

// The same current-mode field grammar owns declarations and later corrections.
function modeField(line: string): { value: string; completed: boolean } | null {
  const match = /^(?:(?:Correction|Actually|Update):\s*)?(?<label>(?:Review )?Mode(?: decision)?|Decision)(?: (?<status>[^:\r\n]+))?:\s*(?<value>.*)$/i.exec(line.replace(/^\s*[-*+]\s+/, '').trim());
  if (!match) return null;
  // "Mode" and "Mode decision" are both field labels. If an explicit status
  // follows, only the completion class is supported. Pending, cancelled,
  // unfinished and unknown statuses also invalidate an earlier declaration.
  const { label, status, value: rawValue } = match.groups!;
  const completeStatus = !status || /^(?:done|complete|completed)$/i.test(status.trim());
  const explicitMode = /^(?:the )?(?:review )?mode\b(?:\s+is\b|:)?\s*/i;
  // An unqualified Decision field owns a review mode only when its value
  // names that vocabulary. Keep unrelated decisions out of withdrawal checks;
  // partial/negated mode names still own a field and therefore fail closed.
  if (/^Decision$/i.test(label!) && !explicitMode.test(rawValue!) &&
      !/\b(?:HOLD|SCOPE|SELECTIVE)\b/i.test(rawValue!)) return null;
  const value = plain(rawValue!).replace(explicitMode, '');
  // Target-name words are identifiers, not modal/lifecycle assertions.
  const choiceValue = value.replace(/^(.*?\bfor\s+)(?:"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`)/i, '$1""');
  // A completed choice and commentary about the recommendation are different
  // assertions. Modal words in an explicitly owned recommendation clause do
  // not make the selected mode conditional. Keep uncertain choice assertions,
  // including those after that commentary, and every lifecycle veto intact.
  const chosenMode = modeNames.find(mode => value.toUpperCase().startsWith(mode) &&
    !/\w/.test(value[mode.length] ?? ''));
  const conditionalChoice = choiceValue.split(/[();,\n]|[.!?](?=\s|$)|\s+[—–-]\s+|\b(?:and|but|while|whereas|however)\b/i).some(clause => {
    const recommendation = /^\s*(?:(?:the|my|our)\s+)?recommendation\b/i.exec(clause);
    const remainder = recommendation ? clause.slice(recommendation[0].length) : clause;
    const ownsChoice = /\b(?:mode|decision|selection|choice|I|we)\b/i.test(remainder) ||
      modeNames.some(mode => mode !== chosenMode && new RegExp(`\\b${mode.replaceAll(' ', '[ _]+')}\\b`, 'i').test(remainder));
    return (!recommendation || ownsChoice) && /\b(?:if|unless|would|might|will)\b/i.test(clause);
  });
  const unfinishedValue = conditionalChoice || /\b(?:withdrawn|retracted|revoked|cancelled|canceled|undecided|unfinished|incomplete|not complete(?:d)?|not selected|not decided|not yet|pending|proposed)\b/i.test(choiceValue);
  const negatedMode = modeNames.some(mode => new RegExp(`\\b(?:not|never|no longer)\\s+${mode.replaceAll(' ', '[ _]+')}\\b`, 'i').test(choiceValue));
  return { value, completed: completeStatus && !unfinishedValue && !negatedMode };
}

function selectedMode(value: string, questionSummary?: string): string | null {
  // The label ends before an explanatory clause or parenthetical. Use this same
  // boundary for declarations and corrections: explanation punctuation cannot
  // turn a completed choice into a withdrawal. modeField checks the full value
  // first so conditional or unfinished explanations still fail closed.
  const match = /^(.+?)(?:(\s+\()|[.,;:]|\s+[—–-]\s+\S|(\s+for\s+\S)|$)/i.exec(value);
  const mode = match?.[1]?.trim().toUpperCase() ?? null;
  // The new completed-field form belongs to the closed review-mode vocabulary.
  // Generic Skill annotations keep their prior mode delimiter behavior.
  if (!mode || !modeNames.includes(mode)) {
    const original = /^(.+?)(?:\s+\([^()]*\)[.!;]?$|[.,;:]|\s+[—–-]\s+\S|$)/.exec(value);
    return original?.[1]?.trim().toUpperCase() ?? null;
  }
  // A balanced explanation can contain punctuation, nesting and following
  // prose. Validate its whole field before recognizing the opening boundary;
  // an unfinished explanation or a glued-on alternative is not a declaration.
  let depth = 0;
  let firstParentheticalEnd = -1;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')') {
      if (--depth < 0) return null;
      if (depth === 0 && firstParentheticalEnd < 0) firstParentheticalEnd = i;
      if (depth === 0 && value[i + 1] && !/[\s.,;:—–-]/.test(value[i + 1]!)) return null;
    }
  }
  if (depth !== 0) return null;
  if (match?.[3]) {
    // A target clause must belong to the same completed audit decision. A
    // matching mode alone cannot authenticate another draft or future review.
    const target = (text: string) => /\bfor\s+((?:"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`)(?:\s+(?:draft|plan))?|.+?)(?=\s+\(|[,;:]|[.!?](?=\s|$)|$)/i.exec(text)?.[1]?.trim();
    const identity = (text: string) => {
      const normalize = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();
      const value = text.replace(/^the\s+/i, '');
      const quoted = /^(?:"((?:[^"\\]|\\.)*)"|“([^”]*)”|`([^`]*)`)(?:\s+(?:draft|plan))?$/i.exec(value);
      if (quoted) return { name: normalize(quoted[1] ?? quoted[2] ?? quoted[3]!), bare: null };
      if (/["“”`]/.test(value)) return null;
      const name = normalize(value), wrapper = /^(.+)\s+(?:draft|plan)$/i.exec(name);
      return { name, bare: wrapper?.[1] ?? null };
    };
    const declared = target(value), recorded = questionSummary && target(questionSummary);
    const named = declared && identity(declared), logged = recorded && identity(recorded);
    // A plan/draft head noun may wrap one exact title. Never strip words inside
    // a quoted title, or strip different suffixes from both names to force a match.
    const sameTarget = named && logged && !!named.name && (named.name === logged.name ||
      named.name === logged.bare || named.bare === logged.name);
    const noncurrent = /\b(?:future|previous|prior|earlier|past|later|next|another|different|other|historical|hypothetical|example|quoted)\s+(?:draft|plan|review|invocation|session)\b/i;
    if (!questionSummary || !declared || noncurrent.test(declared) || (recorded && noncurrent.test(recorded)) ||
        (!/^(?:this|the current) (?:draft|plan|review|invocation|session)$/i.test(declared) &&
          !sameTarget)) return null;
  }
  if (match?.[2] || match?.[3]) {
    // One current field names one mode. A different mode after its explanation
    // is ambiguous regardless of the joining word or punctuation; it cannot be
    // discarded as suffix prose. A separate later Mode field is checked below.
    const suffix = value.slice(match[2] ? firstParentheticalEnd + 1 : match[1]!.length);
    if (modeNames.some(other => other !== mode &&
      new RegExp(`\\b${other.replaceAll(' ', '[ _]+')}\\b`, 'i').test(suffix))) return null;
  }
  return mode;
}

function withdrawn(text: string, option: string, questionSummary?: string): boolean {
  const prose = publicProse(text);
  if (/\b(?:I|we)\s+(?:retract|withdraw|revoke|cancel)\b[^.!?\n]{0,100}\b(?:auto[- ]decision|annotation|decision|selection|choice)\b/i.test(prose) ||
      /\b(?:I|we)\s+(?:did not|didn't|have not|haven't|will not|won't|no longer)\s+auto-decide\b/i.test(prose) ||
      /\b(?:I|we)\s+(?:did not|didn't|have not|haven't)\s+make\s+(?:this|that|the)\s+(?:decision|selection|choice)\b/i.test(prose) ||
      /\b(?:this|that|the)\s+(?:auto[- ]decision|annotation|statement|decision|selection|choice)\b[^.!?\n]{0,100}\b(?:withdrawn|retracted|revoked|cancelled|canceled|hypothetical|conditional|example)\b/i.test(prose)) return true;
  return prose.split('\n').some(line => {
    const parsed = modeField(line);
    if (parsed === null) return false;
    if (!parsed.completed) return true;
    return selectedMode(parsed.value, questionSummary)?.toLowerCase() !== option.toLowerCase();
  });
}

function assertedAnnotation(text: string, skillName: string): RegExpExecArray | null {
  const paragraphs = text.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '').split(/\r?\n\s*\r?\n/);
  let index = 0;
  // A preamble notice is independent of the immediately following current
  // mode declaration. No arbitrary source/example prefix is skipped.
  const preambleNotice = "Heads-up from the preamble: unshipped work on this branch, so `/review` then `/ship` when you're ready. Also, gstack follows the **Boil the Ocean** principle: do the complete thing when AI makes the marginal cost near zero. Read more at https://garryslist.org/posts/boil-the-ocean if you'd like.";
  const decisionNotice = "Heads-up from gstack: there is unshipped work on this branch, so `/review` then `/ship` when you get to it.";
  if (/^Heads-up from gstack: this branch has unshipped work\. Run `\/review` then `\/ship` when you're ready\.$/.test(paragraphs[0] ?? '') || paragraphs[0] === preambleNotice || paragraphs[0] === decisionNotice) index++;
  const mode = /^\*\*Review mode:\s*([^*\n.]+)\.\*\*$/.exec(paragraphs[index] ?? '');
  const decisionHeading = /^\*\*D[1-9]\d* [—–-] Review mode for the ([^*\n]+) draft\*\*$/.exec(paragraphs[index] ?? '');
  if (decisionHeading && /\b(?:example|hypothetical|historical|previous|quoted)\b/i.test(decisionHeading[1]!)) return null;
  if (mode || decisionHeading) index++;
  if (index && !mode && !decisionHeading) return null;
  const paragraph = paragraphs[index];
  if (!paragraph || /^(?: {4}|\t)/.test(paragraph) || paragraph.includes('\n')) return null;
  const match = annotationLine.exec(paragraph);
  if (!match || !plain(match[1]!) || !plain(match[2]!)) return null;
  if (decisionHeading && (!/^"Review mode:[^"]+\?"$/.test(match[1]!) ||
      !/^(?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)$/.test(plain(match[2]!)))) return null;
  // The printed skill template is not a concrete observed choice.
  if (/<[^>\r\n]+>/.test(match[1]!) || /<[^>\r\n]+>/.test(match[2]!)) return null;
  // A named saved preference belongs to the invoked skill's mode, and its
  // concrete choice must agree with the adjacent current mode declaration.
  if (match[3] && (match[3] !== `${skillName}-mode` || !mode ||
      !/^(?:HOLD SCOPE|SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION)$/.test(plain(match[2]!)))) return null;
  if (mode && (plain(mode[1]!).toLowerCase() !== plain(match[2]!).toLowerCase() ||
      (!/^(?:review mode|"Review mode:[^"]+\?")$/i.test(match[1]!) &&
       !(match[3] && /^"Select review mode"$/.test(match[1]!))))) return null;
  return match;
}

// These are closed literal CLI forms, not a shell evaluator. In particular,
// source quoted in echo, substitutions, extra commands and pipelines cannot
// authenticate a completed preference action.
function literalWords(command: string): string[] | null {
  const words: string[] = [];
  const token = /[ \t]*(?:'([^']*)'|"([^"\\]*)"|([^\s'"\\|;&<>]+))/y;
  let offset = 0;
  while (offset < command.length) {
    if (!command.slice(offset).trim()) break;
    token.lastIndex = offset;
    const match = token.exec(command);
    if (!match || (token.lastIndex < command.length && !/\s/.test(command[token.lastIndex]!))) return null;
    const value = match[1] ?? match[2] ?? match[3]!;
    if (match[1] === undefined && /[$`]/.test(value) &&
        value !== '$PPID' && !/^\$HOME\/[\w./-]+$/.test(value)) return null;
    words.push(value); offset = token.lastIndex;
  }
  return words;
}

function cliArgs(command: string, name: string): string[] | null {
  const words = literalWords(command);
  if (!words?.length || !/^(?:~\/|\$HOME\/|\.claude\/|\/)/.test(words[0]!) ||
      words[0]!.split('/').includes('..') || !words[0]!.endsWith(`/skills/gstack/bin/${name}`)) return null;
  // Tilde and variable expansion are not performed inside single quotes.
  if (/^\s*['"]~\//.test(command) || /^\s*'\$HOME\//.test(command)) return null;
  return words.slice(1);
}

function preambleArgs(command: string): string[] | null {
  const direct = cliArgs(command, 'gstack-skill-start');
  if (direct) return direct;
  // The generated preamble's fixed fallback wrapper owns its _SS variable.
  const prefix = '_SS="$HOME/.claude/skills/gstack/bin/gstack-skill-start"\n[ -x "$_SS" ] || _SS=".claude/skills/gstack/bin/gstack-skill-start"\n"$_SS" ';
  const suffix = ' || echo "SKILL_START: unavailable — stale install; run ./setup or /gstack-upgrade (preamble degraded, continue the user\'s task)"';
  const normalized = command.replace(/\\\r?\n\s*/g, ' ');
  return normalized.startsWith(prefix) && normalized.endsWith(suffix)
    ? literalWords(normalized.slice(prefix.length, -suffix.length).trim()) : null;
}

const modeNames = ['HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'];
const modeValue = (value: unknown) => typeof value === 'string' && modeNames.includes(value.replaceAll('_', ' '))
  ? value.replaceAll('_', ' ') : null;

function currentModeStatement(text: string, questionSummary?: string): { option: string; statement: string } | null {
  const prose = publicProse(text);
  const lines = prose.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const statement = lines[i]!.replace(/^\s*[-*+]\s+/, '').trim();
    const field = modeField(statement);
    const option = field?.completed ? selectedMode(field.value, questionSummary) : null;
    if (!option || !modeNames.includes(option)) continue;
    // Source/example introductions and conditional selections cannot supply
    // a current declaration merely by putting a Mode field on the next line.
    const context = lines.slice(0, i + 1).join('\n').replace(/\b[\w/-]+(?:\.[\w-]+)+\b/g, '');
    if (/\b(?:example|hypothetical|historical|previous|quoted)\b/i.test(context)) continue;
    return { option, statement: lines[i]!.trim() };
  }
  return null;
}

/** A native slash expansion need not produce a Skill tool call. Its completed
 * preamble → preference check → decision log → current public mode provides
 * the alternative evidence, without attributing a synthetic Skill event. */
function structuredModeDecision(transcript: PlanCountTranscript, tools: NativePublicToolEvent[],
  opts: { skillName: string; sessionId: string; commandStartedAt: number; now: number; proseQuestionObserved?: boolean; stateEvidence?: AutoDecisionState },
): NativeAutoDecision | null {
  const time = (value: string) => Date.parse(value);
  const timely = (value: string) => Number.isFinite(time(value)) && time(value) >= opts.commandStartedAt && time(value) <= opts.now;
  const owned = tools.filter(e => e.sessionId === opts.sessionId);
  const messages = transcript.assistantMessages.filter(m => m.sessionId === opts.sessionId);
  if (opts.proseQuestionObserved || transcript.calls.some(c => c.sessionId === opts.sessionId) ||
      owned.some(e => e.kind === 'use' && /(?:^|__)AskUserQuestion$/.test(e.name ?? '')) ||
      messages.some(m => !Number.isFinite(time(m.timestamp)) || time(m.timestamp) > opts.now)) return null;
  const current = messages.filter(m => timely(m.timestamp));
  const prose = current.map(m => publicProse(m.text)).join('\n\n');
  if (/\b(?:reply|respond)\s+(?:with|using)\b/i.test(prose) ||
      (/^\s*A[).]\s+\S/m.test(prose) && /^\s*B[).]\s+\S/m.test(prose))) return null;
  const successful = (use: NativePublicToolEvent) => {
    if (!timely(use.timestamp) || !use.toolUseId || owned.filter(e => e.kind === 'use' && e.toolUseId === use.toolUseId).length !== 1) return null;
    const results = owned.filter(e => e.kind === 'result' && e.toolUseId === use.toolUseId);
    const result = results.length === 1 ? results[0]! : null;
    return result && result.isError === false && timely(result.timestamp) && time(result.timestamp) >= time(use.timestamp) ? result : null;
  };
  const bash = owned.filter(e => e.kind === 'use' && e.name === 'Bash' && timely(e.timestamp) && typeof e.input?.command === 'string');
  const starts = bash.flatMap(use => {
    const args = preambleArgs(use.input!.command as string), result = successful(use);
    if (!args || !result || args.length % 2 || args.length < 2) return [];
    const pairs = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--skill', '--model', '--parent-pid'].includes(args[i]!) || pairs.has(args[i]!)) return [];
      pairs.set(args[i]!, args[i + 1]!);
    }
    if (pairs.get('--skill') !== opts.skillName || typeof result.content !== 'string') return [];
    const status = result.content.split('GSTACK_INSTRUCTION_BEGIN:')[0]!;
    const sessions = [...status.matchAll(/^SESSION_ID: ([A-Za-z0-9-]+)$/gm)];
    if (sessions.length !== 1 || !/^SKILL_START_PROTO: 1$/m.test(status) || !/^QUESTION_TUNING: true$/m.test(status)) return [];
    return [{ use, result, session: sessions[0]![1]! }];
  });
  if (starts.length !== 1) return null;
  const start = starts[0]!, questionId = `${opts.skillName}-mode`;
  // Opt-in fixture evidence bypasses no failed shell ACK: the owned file is
  // the completed write. The preamble, record and current public declaration
  // must all agree in this native session, after invocation and before now.
  if (opts.stateEvidence?.questionId === questionId && opts.stateEvidence.preference === 'never-ask') {
    const rows = opts.stateEvidence.records.filter(row => row.question_id === questionId);
    if (rows.length === 1) {
      const row = rows[0]!;
      const loggedAt = typeof row.ts === 'string' ? time(row.ts) : NaN;
      if (row.skill === opts.skillName && row.session_id === start.session && row.source === 'agent' &&
          row.auto_decided === true && modeValue(row.user_choice) && modeValue(row.user_choice) === modeValue(row.recommended) &&
          typeof row.question_summary === 'string' && row.question_summary.trim() &&
          loggedAt >= time(start.result.timestamp) && loggedAt <= opts.now) {
        for (const message of current) {
          const declared = currentModeStatement(message.text, row.question_summary);
          if (time(message.timestamp) < loggedAt || !declared || declared.option !== modeValue(row.user_choice)) continue;
          const after = current.filter(m => time(m.timestamp) >= time(message.timestamp)).map(m => m.text).join('\n\n');
          if (withdrawn(after, declared.option, row.question_summary)) continue;
          return { sessionId: opts.sessionId, timestamp: message.timestamp, summary: row.question_summary,
            option: declared.option, annotation: message.text, preambleToolUseId: start.use.toolUseId, stateRecord: row };
        }
      }
    }
    return null;
  }
  const checks = bash.flatMap(use => {
    let command = (use.input!.command as string).trim();
    const result = successful(use); if (time(use.timestamp) < time(start.result.timestamp)) return [];
    const status = '; echo "EXIT: $?"', hasStatus = command.endsWith(status);
    if (hasStatus) command = command.slice(0, -status.length);
    const pipe = /^printf\s+(?:'%s'|"%s")\s+(?:'[^']*'|"[^"$`\\]*")\s*\|\s*/.exec(command);
    if (pipe) command = command.slice(pipe[0].length);
    const args = cliArgs(command, 'gstack-question-preference');
    if (!args || args[0] !== '--check' || args[1] !== questionId ||
        (pipe ? args.length !== 3 || args[2] !== '--summary-stdin' : args.length !== 2)) return [];
    const valid = result && typeof result.content === 'string' &&
      result.content.trim() === (hasStatus ? 'AUTO_DECIDE\nEXIT: 0' : 'AUTO_DECIDE');
    return [{ use, result: valid ? result : null }];
  });
  if (checks.length !== 1 || !checks[0]!.result) return null;
  const check = checks[0]!;
  const logs = bash.flatMap(use => {
    let command = (use.input!.command as string).trim();
    const result = successful(use); if (time(use.timestamp) < time(check.result!.timestamp)) return [];
    let valid = !!result;
    // Optional quiet logging reports success only through &&, never a masked
    // failed log followed by an unconditional echo.
    const reported = /(?:\s+2>\/dev\/null)?\s+&&\s+echo\s+((?:[A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"|'[A-Za-z0-9_-]+'))(?:\s+\|\|\s+echo\s+"([^"$`\\]*)")?$/.exec(command);
    if (reported) { command = command.slice(0, -reported[0].length); valid &&= typeof result?.content === 'string' && result.content.trim() === literalWords(reported[1]!)?.[0] &&
      (reported[2] === undefined || reported[2].trim() !== literalWords(reported[1]!)?.[0]); }
    else valid &&= typeof result?.content === 'string' && !result.content.trim();
    const args = cliArgs(command, 'gstack-question-log'); if (!args || args.length !== 1) return [];
    let log: any; try { log = JSON.parse(args[0]!); } catch { return []; }
    if (!log || Array.isArray(log) || log.skill !== opts.skillName || log.question_id !== questionId) return [];
    valid &&= log.session_id === start.session && log.auto_decided === true &&
      typeof log.question_summary === 'string' && !!log.question_summary.trim() &&
      !!modeValue(log.user_choice) && modeValue(log.user_choice) === modeValue(log.recommended);
    return [{ use, result: valid ? result : null, log }];
  });
  if (logs.length !== 1 || !logs[0]!.result) return null;
  const logged = logs[0]!;
  for (const message of current) {
    if (time(message.timestamp) < time(logged.result!.timestamp)) continue;
    const declared = currentModeStatement(message.text, logged.log.question_summary);
    if (!declared || declared.option !== modeValue(logged.log.user_choice)) continue;
    const after = current.filter(m => time(m.timestamp) >= time(message.timestamp)).map(m => m.text).join('\n\n');
    if (withdrawn(after, declared.option, logged.log.question_summary) || current.some(m => time(m.timestamp) >= time(message.timestamp) &&
        currentModeStatement(m.text, logged.log.question_summary)?.option !== undefined && currentModeStatement(m.text, logged.log.question_summary)!.option !== declared.option)) continue;
    return { sessionId: opts.sessionId, timestamp: message.timestamp, summary: logged.log.question_summary,
      option: declared.option, annotation: message.text, preambleToolUseId: start.use.toolUseId,
      preferenceToolUseId: check.use.toolUseId, questionLogToolUseId: logged.use.toolUseId };
  }
  return null;
}

/** Owned native auto-decision evidence; exact annotations retain their original path. */
export function findNativeAutoDecision(
  transcript: PlanCountTranscript,
  tools: NativePublicToolEvent[],
  opts: { skillName: string; sessionId: string; commandStartedAt: number; now: number; proseQuestionObserved?: boolean; stateEvidence?: AutoDecisionState },
): NativeAutoDecision | null {
  if (transcript.status !== 'ready' || !opts.sessionId || !opts.skillName || opts.proseQuestionObserved ||
      !Number.isFinite(opts.commandStartedAt) || !Number.isFinite(opts.now) || opts.now < opts.commandStartedAt) return null;
  const structured = structuredModeDecision(transcript, tools, opts);
  if (structured) return structured;
  const at = (timestamp: string) => Date.parse(timestamp);
  const timely = (timestamp: string) => Number.isFinite(at(timestamp)) && at(timestamp) >= opts.commandStartedAt && at(timestamp) <= opts.now;
  const uses = tools.filter(e => e.kind === 'use' && e.sessionId === opts.sessionId && e.name === 'Skill' &&
    [opts.skillName, `gstack:${opts.skillName}`].includes(String(e.input?.skill ?? '')) && timely(e.timestamp));
  if (uses.length !== 1 || !uses[0]!.toolUseId) return null;
  const use = uses[0]!;
  const results = tools.filter(e => e.kind === 'result' && e.sessionId === opts.sessionId && e.toolUseId === use.toolUseId);
  if (results.length !== 1 || results[0]!.isError !== false || !timely(results[0]!.timestamp) || at(results[0]!.timestamp) < at(use.timestamp)) return null;
  // A native question actually surfaced; the annotation cannot erase it.
  if (transcript.calls.some(call => call.sessionId === opts.sessionId)) return null;
  const messages = transcript.assistantMessages.filter(m => m.sessionId === opts.sessionId);
  if (messages.some(m => !Number.isFinite(at(m.timestamp)) || at(m.timestamp) > opts.now)) return null;
  const loadedAt = at(results[0]!.timestamp);
  for (const message of messages) {
    if (at(message.timestamp) < loadedAt) continue;
    const match = assertedAnnotation(message.text, opts.skillName);
    if (!match) continue;
    const option = plain(match[2]!);
    const current = messages.filter(m => at(m.timestamp) >= at(message.timestamp)).map(m => m.text).join('\n\n');
    if (withdrawn(current, option)) continue;
    return { sessionId: opts.sessionId, skillToolUseId: use.toolUseId, timestamp: message.timestamp,
      summary: plain(match[1]!), option, annotation: match[0] };
  }
  return null;
}
