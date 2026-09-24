/** Capture an actual public AskUserQuestion, without reading model transcripts. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveEvalModel } from '../../lib/eval-model';
import { launchClaudePty, capturePlanCountQuestion, parseNumberedOptions, type ClaudePtySession } from './claude-pty-runner';
import { buildSeedConfig, isHermeticEnabled } from './hermetic-env';
import { getProjectEvalDir } from './eval-store';
import { readFirstPendingQuestionForDisplay, pendingQuestionRecorderStatus } from './plan-count-pending-question';
import type { NativePlanQuestion, NativePlanQuestionCall } from './plan-count-transcript';

export const NATIVE_AUQ_CAPTURE_MS = 240_000;
// close() reserves at most two seconds for SIGINT and one for SIGKILL.
const CLEANUP_MS = 3_000;

export interface NativeAuqCaptureOptions {
  planDir: string;
  skillName: string;
  scenario: string;
  testName: string;
  runId?: string;
  model?: string;
}

export interface NativeAuqCapture {
  outcome: 'question_captured';
  workflowCompleted: false;
  source: 'pre_tool_use';
  sessionId: string;
  toolUseId: string;
  questionIndex: number;
  question: NativePlanQuestion;
  publicCall: NativePlanQuestionCall;
  text: string;
  artifactDir?: string;
}

/** Neutral separators only: every graded word must come from this one question. */
export function serializeNativeAuq(question: NativePlanQuestion): string {
  return [question.header, question.question,
    ...question.options.map(option => [option.label, option.description].filter(value => value !== undefined).join('\n')),
  ].join('\n\n');
}

/** Counting tolerates damaged labels; format capture must reject visible contradictions. */
function nativeOptionLabelsAgree(screen: string, question: NativePlanQuestion): boolean {
  const rows = screen.replace(/\r+\n?/g, '\n').split('\n');
  const cursorRow = rows.findLastIndex(row => /❯\s*1\./.test(row));
  if (cursorRow < 0) return false;
  const menu = rows.slice(cursorRow);
  const width = (text: string) => Bun.stringWidth(text);
  const left = (text: string, columns: number) => {
    let result = '', used = 0;
    for (const char of text) {
      const next = width(char);
      if (used + next > columns || used >= columns) break;
      result += char; used += next;
    }
    return result;
  };
  // Strip only an actual aligned preview box, not a literal bar inside a label.
  let previewColumn: number | undefined;
  for (let top = 0; top < menu.length; top++) {
    const box = /┌─+┐\s*$/.exec(menu[top]!);
    if (!box || box.index === 0) continue;
    const column = width(menu[top]!.slice(0, box.index));
    const bottom = menu.findIndex((row, i) => i > top &&
      row.slice(left(row,column).length).trim() === box[0].trim().replace('┌','└').replace('┐','┘'));
    if (bottom > top + 1 && menu.slice(top + 1,bottom).every(row =>
      /^│[^\n]*│\s*$/.test(row.slice(left(row,column).length)))) {
      previewColumn = column; break;
    }
  }
  const labelRows = menu.map(row => {
    if (previewColumn === undefined) return row;
    const prefix = left(row,previewColumn), sidebar = row.slice(prefix.length);
    return /^(?:[┌│└]|Notes: press n to add notes\s*$)/.test(sidebar) ? prefix.trimEnd() : row;
  });
  const options = parseNumberedOptions(labelRows.join('\n'));
  const optionRow = /^[ \t]{0,3}(?:❯\s*)?([1-9])\.\s*(.*)$/;
  // The shared parser requires two choices. A single remaining visible choice
  // can still explicitly contradict its indexed native label.
  for (const row of labelRows) {
    const match = optionRow.exec(row);
    if (match && !options.some(option => option.index === Number(match[1]))) {
      options.push({index:Number(match[1]),label:match[2]!.trim()});
    }
  }
  const compact = (text: string) => text.replace(/\s+/g,'');
  const label = (text: string) => compact(question.multiSelect ? text.replace(/^\[[ ✓✔xX]\]\s*/,'') : text);
  return options.every(option => {
    const expected = question.options[option.index - 1];
    if (!expected) return /^(?:Typesomething\.?|Chataboutthis)$/.test(compact(option.label));
    let shown = label(option.label), wanted = compact(expected.label);
    if (!shown || shown === wanted) return true;
    if (/(?:…|\.\.\.)$/.test(shown)) {
      const prefix = shown.replace(/(?:…|\.\.\.)$/,'');
      return !prefix || wanted.startsWith(prefix);
    }
    if (!wanted.startsWith(shown)) return false;
    const start = labelRows.findIndex(row => {
      const match = optionRow.exec(row);
      return match && Number(match[1]) === option.index;
    });
    if (start < 0) return false;
    let last = start;
    for (let i = start + 1; i < labelRows.length && /^[ \t]{4,}\S/.test(labelRows[i]!); i++) {
      const next = compact(labelRows[i]!.trim());
      if (!wanted.startsWith(shown + next)) return false;
      shown += next; last = i;
      if (shown === wanted) return true;
    }
    // Prefix-only equality requires visible clipping at the actual 120-column
    // viewport edge; a shorter complete row such as Keep != Keep current fails.
    return width(menu[last]!.trimEnd()) === 120 && wanted.startsWith(shown);
  });
}

/** The native UI can clip a tall pane's top and elide its tail simultaneously. */
function clippedElidedNativeAuqIdentity(screen: string, call: NativePlanQuestionCall):
  {indices:number[]; packetBar:boolean} | undefined {
  const visible = screen.replace(/\r+\n?/g, '\n');
  const cursor = [...visible.matchAll(/^❯\s*1\./gm)].at(-1);
  if (!cursor) return undefined;
  // Native panes can leave blank outer margin rows when the header scrolls
  // away. Remove only that margin; internal/unboxed rows remain evidence.
  let before = visible.slice(0,cursor.index).replace(/^(?:[ \t]*\n)+/,'').trimEnd();
  const bar = call.questions.length > 1
    ? /^←[^\n]*[☐☒][^\n]*✔[ \t]*Submit[ \t]*→[ \t]*\n/.exec(before) : null;
  if (bar) before = before.slice(bar[0].length).replace(/^(?:[ \t]*\n)+/,'');
  const rows = before.split('\n');
  // Only the actual viewport's boxed question body qualifies. Do not strip a
  // foreign header, quoted output, or prose prefix to manufacture a match.
  if (rows.length < 2 || !/^[ \t]*[│┃](?: |$)/.test(rows[0]!) || /[☐□❯]/.test(before)) return undefined;
  // Once the clipped boxed body starts, every interior row belongs to it.
  // Counting may normalize blank rows; capture cannot discard that contradiction.
  if (rows.some(row => !/^[ \t]*[│┃](?: |$)/.test(row))) return {indices:[],packetBar:!!bar};
  const body = rows.map(row => row.replace(/^[ \t]*[│┃] ?/,'')).join('\n').trimEnd();
  if (!body.endsWith('…')) return undefined;
  const compact = (value: string) => value.replace(/\s+/g,'');
  const fragment = compact(body.slice(0,-1));
  if (fragment.length < 160) return undefined;
  const menu = visible.slice(cursor.index);
  const footer = call.questions.length > 1
    ? /(?:^|\n)Enter\s*to\s*select\s*·\s*Tab\/Arrow\s*keys\s*to\s*navigate\s*·\s*Esc\s*to\s*cancel[\s│┃─━└┘]*$/.exec(menu)
    : /(?:^|\n)Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel[\s│┃─━└┘]*$/.exec(menu);
  // Once this boxed/elided shape is recognized, an incompatible
  // footer is contradictory evidence, not permission to try another route.
  if (!footer) return {indices:[],packetBar:!!bar};
  // Inspect every displayed row, including an out-of-order control that the
  // shared parser intentionally omits when its contiguous menu ends.
  const options = [...menu.matchAll(/^[ \t]{0,3}(?:❯[ \t]*)?([0-9]+)\.[ \t]*(.*)$/gm)]
    .map(match => ({index:Number(match[1]),label:match[2]!}));
  const matches = call.questions.flatMap((question,questionIndex) => {
    const offered = options.slice(0,question.options.length);
    const controls = options.slice(question.options.length);
    const exactMenu = offered.length === question.options.length && offered.every((option,index) =>
      option.index === index + 1 && compact(option.label) === compact(question.options[index]!.label)) &&
      controls.length <= 2 && controls.every((option,index) =>
        option.index === question.options.length + index + 1 &&
        (index === 0 ? /^Typesomething\.?$/ : /^Chataboutthis$/).test(compact(option.label)));
    if (!exactMenu) return [];
    const native = compact(question.question);
    // A literal terminal ellipsis can also be complete-body/suffix evidence.
    // Count that candidate alongside elided candidates, before either route
    // can select a different member of the same packet.
    if (bar ? native === compact(body) : native.endsWith(compact(body))) return [questionIndex];
    const start = native.indexOf(fragment);
    if (start < 0 || start + fragment.length >= native.length) return [];
    // Repeated visible segments remain ambiguous, not an absent candidate
    // that would let another packet member win by default.
    return native.indexOf(fragment,start + 1) === -1 ? [questionIndex] : [questionIndex,questionIndex];
  });
  return {indices:matches,packetBar:!!bar};
}

/** Project a verified complete body; null rejects contradictory boxed evidence. */
function unboxCompleteNativeAuqBody(screen: string, call: NativePlanQuestionCall): string | null | undefined {
  // Packets already have their own body projection and unique-tab matching.
  // A singleton header must never provide a new route into a packet.
  if (call.questions.length !== 1) return undefined;
  const visible=screen.replace(/\r+\n?/g,'\n');
  const cursor=[...visible.matchAll(/^❯\s*1\./gm)].at(-1);
  if (!cursor) return undefined;
  const before=visible.slice(0,cursor.index);
  const header=[...before.matchAll(/(?:^|\n)[ \t]*[☐□]([^\n│]*)\n/g)].at(-1);
  if (!header) return undefined;
  const compact=(value:string)=>value.replace(/\s+/g,'');
  const question=call.questions[0]!;
  const bodyStart=header.index+header[0].length;
  const bodySpan=before.slice(bodyStart);
  const rows=bodySpan.replace(/^(?:[ \t]*\n)+/,'').trimEnd().split('\n');
  if (!/^[ \t]*[│┃](?: |$)/.test(rows[0]!)) return undefined;
  if (compact(header[1]!)!==compact(question.header) || rows.some(row=>!/^[ \t]*[│┃](?: |$)/.test(row))) return null;
  // A complete boxed pane must pass this capture-specific check before the
  // broader counting parser. Only a genuinely elided body uses its other route.
  const body=rows.map(row=>row.replace(/^[ \t]*[│┃] ?/,'')).join('\n');
  if (!compact(body) || compact(body)!==compact(question.question)) return body.endsWith('…') ? undefined : null;
  // Ordinary prior public output is outside the pane only when separated by
  // the native horizontal rule. A quoted/fenced pane is not display evidence.
  const prefix=before.slice(0,header.index).trimEnd();
  if (prefix && (!/^[─━]{20,}$/.test(prefix.split('\n').at(-1)!) ||
      /(?:^|\n)[ \t]*(?:>|```)/.test(prefix))) return null;
  // Strip exactly one framing prefix, preserving literal box characters in
  // the actual question. No size threshold: malformed short briefs need grades.
  const menu=visible.slice(cursor.index);
  if (!/(?:^|\n)Enter\s*to\s*select\s*·\s*↑\/↓\s*to\s*navigate\s*·\s*(?:n\s*to\s*add\s*notes\s*·\s*)?Esc\s*to\s*cancel[\s│┃─━└┘]*$/.test(menu)) return null;
  const options=[...menu.matchAll(/^[ \t]{0,3}(?:❯[ \t]*)?([0-9]+)\.[ \t]*(.*)$/gm)]
    .map(match=>({index:Number(match[1]),label:match[2]!}));
  const offered=options.slice(0,question.options.length), controls=options.slice(question.options.length);
  if (offered.length!==question.options.length || offered.some((option,index)=>option.index!==index+1 || !option.label.trim()) ||
      controls.length>2 || controls.some((option,index)=>option.index!==question.options.length+index+1 ||
        !(index===0?/^Typesomething\.?$/:/^Chataboutthis$/).test(compact(option.label))) ||
      !nativeOptionLabelsAgree(visible,question)) return null;
  return visible.slice(0,bodyStart)+bodySpan.replace(/^[ \t]*[│┃] ?/gm,'')+visible.slice(cursor.index);
}

/** A hook payload alone, screen prose, or a different packet is not a capture. */
export function displayedNativeAuq(screen: string, call: NativePlanQuestionCall | undefined):
  {question: NativePlanQuestion; questionIndex: number} | undefined {
  if (!call || call.answered || call.failed) return undefined;
  const clipped = clippedElidedNativeAuqIdentity(screen,call);
  const uniqueFirst = clipped?.indices.length === 1 && clipped.indices[0] === 0;
  // Question identity must be unique across complete and elided body routes;
  // an early shared match must not bypass a contradictory second candidate.
  if (clipped && !uniqueFirst) return undefined;
  const unboxed=unboxCompleteNativeAuqBody(screen,call);
  if (unboxed===null) return undefined;
  const matched = capturePlanCountQuestion(unboxed ?? screen, new Set(), 0, false, call);
  // Never use the screen-only fallback. The additional native-only branch
  // proves the observed combined clipping mode from this same owned payload.
  // A visible tab bar keeps its existing route; its parsed body above is only
  // additional ambiguity rejection, never a new route to accept another tab.
  if (!matched?.nativeCall && (!uniqueFirst || clipped?.packetBar)) return undefined;
  const questionIndex = matched?.nativeCall ? matched.nativeQuestionIndex ?? 0 : 0;
  if (questionIndex !== 0) return undefined; // A later tab cannot replace the first question.
  const question = call.questions[questionIndex];
  return question && nativeOptionLabelsAgree(screen, question) ? {question, questionIndex} : undefined;
}

/** Read only a public CLI error panel; never inspect private journal blocks. */
export function nativeAuqPublicError(screen: string): string | undefined {
  const match = /(?:^|\n)[\t │┃]*(?:[⎿●⏺]\s*)?API Error:[\s\S]*/i.exec(screen);
  return match?.[0].trim().slice(0, 2000);
}

/** The current viewport only, never terminal history or a model transcript. */
export function nativeAuqViewport(screen: string): {viewport:string; viewportTruncated:boolean} {
  const limit = 16_384;
  return {viewport:screen.slice(-limit), viewportTruncated:screen.length > limit};
}

export async function captureNativeFirstAuq(opts: NativeAuqCaptureOptions): Promise<NativeAuqCapture> {
  const startedAt = Date.now();
  const deadline = startedAt + NATIVE_AUQ_CAPTURE_MS - CLEANUP_MS;
  const cwd = path.resolve(opts.planDir);
  const model = resolveEvalModel('capture', opts.model);
  const sessionId = randomUUID();
  const runId = opts.runId || process.env.EVALS_RUN_ID || `local-${sessionId}`;
  let session: ClaudePtySession | undefined;
  let ownedRoot: string | undefined;
  let artifactDir: string | undefined;
  let artifactRoot: string | undefined;
  let outcome = 'error';
  let diagnostic: string | undefined;
  let captured: NativeAuqCapture | undefined;
  let pendingPublicCall: NativePlanQuestionCall | undefined;
  let viewport: ReturnType<typeof nativeAuqViewport> | undefined;
  let viewportAt: string | undefined;
  let displayMatched = false;
  let pendingRecorder: ReturnType<typeof pendingQuestionRecorderStatus> | undefined;

  const observeViewport = async (): Promise<string> => {
    const screen = await session!.currentScreen();
    viewport = nativeAuqViewport(screen);
    viewportAt = new Date().toISOString();
    return screen;
  };

  const fail = (reason: string, detail?: string): never => {
    outcome = reason;
    diagnostic = detail;
    throw new Error(`${opts.testName}: AUQ capture failed (${reason})${detail ? `: ${detail}` : ''}`);
  };
  try {
    if (!isHermeticEnabled()) fail('hermetic_required');
    if (process.env.GSTACK_EVAL_DIR || process.env.EVALS_RUN_ID || opts.runId) {
      const segment = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'run';
      // Resolve the optional store inside the operation budget, before launch.
      artifactRoot = path.resolve(process.env.GSTACK_EVAL_DIR || getProjectEvalDir(), 'native-auq', segment(runId));
    }
    // This invocation owns its session/config. Only this fresh recorder's exact
    // public PreToolUse fields are read; its parent JSONL is never opened.
    ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-native-auq-'));
    const configDir = path.join(ownedRoot, '.claude');
    const stateDir = path.join(ownedRoot, 'gstack-home');
    fs.mkdirSync(configDir);
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify(buildSeedConfig({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.GSTACK_ANTHROPIC_API_KEY,
      trustedDirs: [cwd],
    })), {mode:0o600});
    const skillPath = path.join(cwd, opts.skillName, 'SKILL.md');
    const prompt = `The ONLY skill file you may read is this absolute path: ${skillPath}. Do NOT search for, Glob, find, or read any other SKILL.md anywhere — especially nothing under ~/.claude or /Users.

Read ${skillPath} and follow its workflow for this scenario:

${opts.scenario}

Skip any system-audit / environment-setup / codebase-exploration steps. At the first decision requiring user input, ask the user through the AskUserQuestion tool and wait for their answer.`;
    session = await launchClaudePty({
      // Explicit tool approvals suffice. Bypass mode introduces a separate
      // safety-consent screen in a fresh CLI config; never accept that screen.
      cwd, model, seedSkills: false, permissionMode: 'default',
      observeScreen: true, observeSetupQuestions: true,
      timeoutMs: Math.max(1, deadline - Date.now()),
      // Explicit availability as well as approval: no Bash/Agent/Skill or MCP.
      // The positional prompt starts a real interactive turn, without a boot
      // sleep, hypothetical output request, or synthetic answer submission.
      extraArgs: ['--tools', 'Read,Write,AskUserQuestion', '--allowed-tools', 'Read,Write,AskUserQuestion',
        '--session-id', sessionId, prompt],
      env: {CLAUDE_CONFIG_DIR: configDir, GSTACK_HOME: stateDir, GSTACK_HEADLESS: ''},
    });
    if (session.hermeticConfigDir !== configDir || !session.pendingQuestionFile) fail('missing_observer');
    while (Date.now() < deadline) {
      const screen = await observeViewport();
      const call = readFirstPendingQuestionForDisplay(session.pendingQuestionFile, cwd, configDir, startedAt, sessionId);
      if (call) pendingPublicCall = call;
      pendingRecorder = pendingQuestionRecorderStatus(session.pendingQuestionFile, cwd, configDir);
      const publicError = nativeAuqPublicError(screen);
      if (publicError) fail('error_api', publicError);
      if (session.exited()) fail(`exit_code_${session.exitCode() ?? 'unknown'}`);
      if (pendingRecorder.status === 'invalid') fail('invalid_capture', pendingRecorder.reason);
      const displayed = displayedNativeAuq(screen, call);
      if (displayed && call) {
        captured = {outcome:'question_captured', workflowCompleted:false, source:'pre_tool_use',
          sessionId, toolUseId:call.toolUseId, ...displayed, publicCall:call,
          text:serializeNativeAuq(displayed.question)};
        displayMatched = true;
        outcome = captured.outcome;
        break;
      }
      await Bun.sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
    if (!captured) {
      // Refresh the final public frame before shutdown; a startup/permission
      // screen is useful timeout evidence even when no AUQ hook ever fired.
      const screen = await observeViewport();
      const call = readFirstPendingQuestionForDisplay(session.pendingQuestionFile, cwd, configDir, startedAt, sessionId);
      if (call) pendingPublicCall = call;
      pendingRecorder = pendingQuestionRecorderStatus(session.pendingQuestionFile, cwd, configDir);
      const publicError = nativeAuqPublicError(screen);
      if (publicError) fail('error_api', publicError);
      fail('timeout');
    }
  } catch (error) {
    if (outcome === 'error') diagnostic = String(error);
    throw error;
  } finally {
    // Deliberate cutoff after a displayed question is not workflow completion.
    let cleanupError: string | undefined;
    let artifactError: string | undefined;
    try { await session?.close(); } catch (error) { cleanupError = String(error); }
    try { if (ownedRoot) fs.rmSync(ownedRoot, {recursive:true, force:true}); }
    catch (error) { cleanupError = [cleanupError, String(error)].filter(Boolean).join('; '); }
    if (captured && cleanupError) outcome = 'cleanup_error';
    // Persist only supported public fields. No terminal history or transcript
    // is retained, and no partial artifact can supply a later invocation.
    try {
      if (artifactRoot) {
        const segment = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'run';
        fs.mkdirSync(artifactRoot, {recursive:true, mode:0o700});
        artifactDir = fs.mkdtempSync(path.join(artifactRoot, `${segment(opts.testName)}-`));
        fs.writeFileSync(path.join(artifactDir, 'capture.json'), JSON.stringify({
          ...captured, pendingPublicCall, ...viewport, viewportAt, displayMatched, pendingRecorder,
          outcome, workflowCompleted:false, diagnostic, cleanupError, testName:opts.testName,
          skillName:opts.skillName, model, runId, sessionId, cwd,
          // Native display capture does not expose a terminal billing result.
          billing:'unavailable',
          elapsedMs:Date.now() - startedAt, at:new Date().toISOString(),
        }, null, 2) + '\n', {mode:0o600});
      }
    } catch (error) { artifactError = String(error); }
    if (captured && artifactError) outcome = 'artifact_error';
    console.log(`[AUQ-native ${opts.testName}] outcome=${outcome} workflowCompleted=false`
      + (artifactDir ? ` artifact=${artifactDir}` : '')
      + (artifactError ? ` artifactError=${artifactError}` : '')
      + (cleanupError ? ` cleanupError=${cleanupError}` : ''));
    // Keep the original refusal/crash/timeout primary when diagnostics fail.
    if (captured && (cleanupError || artifactError)) {
      throw new Error(`${opts.testName}: AUQ capture failed (${outcome}): ${cleanupError || artifactError}`);
    }
  }
  return {...captured!, artifactDir};
}
