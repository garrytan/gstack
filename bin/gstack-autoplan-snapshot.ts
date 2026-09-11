#!/usr/bin/env bun
/** Autoplan's blind reviewer inputs contain only the current implementation plan. */
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

const PHASES = ['ceo', 'design', 'dx', 'eng'];
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

// Exact terms from Autoplan's existing Phase 0 DX trigger. Count occurrences,
// not a subjective reinterpretation of whether an API is internal or external.
const DX_TERMS = ["API", "endpoint", "REST", "GraphQL", "gRPC", "webhook", "CLI", "command", "flag", "argument", "terminal", "shell", "SDK", "library", "package", "npm", "pip", "import", "require", "SKILL.md", "skill template", "Claude Code", "MCP", "agent", "OpenClaw", "action", "developer docs", "getting started", "onboarding", "integration", "debug", "implement", "error message"];

function dxTermsFor(content: string) {
  const matches = DX_TERMS.map(term => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { term, count: [...content.matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))].length };
  }).filter(match => match.count > 0);
  const matchCount = matches.reduce((sum, match) => sum + match.count, 0);
  return { threshold: 2, matches, matchCount, dxRequiredByTerms: matchCount >= 2 };
}

/** Byte-bound scope evidence; semantic product/user triggers can only enable DX. */
export function detectDxScope(activePlan: string, developerTool = false, agentPrimary = false) {
  const source = realpathSync(activePlan);
  const content = extractImplementationPlan(readFileSync(source, 'utf8'));
  const terms = dxTermsFor(content);
  return { activePlan: source, sha256: sha256(content), ...terms, developerTool, agentPrimary,
    dxRequired: terms.dxRequiredByTerms || developerTool || agentPrimary };
}

// The native dispatch payload is assembled from the same immutable bytes as
// the outside reviewer input. Keep full role criteria here, not a hand summary.
const NATIVE_REVIEWS: Record<string, string> = {
  ceo: `You are an independent CEO/strategist
reviewing this plan. You have NOT seen any prior review. Evaluate:
1. Is this the right problem to solve? Could a reframing yield 10x impact?
2. Are the premises stated or just assumed? Which ones could be wrong?
3. What's the 6-month regret scenario — what will look foolish?
4. What alternatives were dismissed without sufficient analysis?
5. What's the competitive risk — could someone else solve this first/better?
For each finding: what's wrong, severity (critical/high/medium), and the fix.`,
  design: `You are an independent senior product designer
reviewing this plan. You have NOT seen any prior review. Evaluate:
1. Information hierarchy: what does the user see first, second, third? Is it right?
2. Missing states: loading, empty, error, success, partial — which are unspecified?
3. User journey: what's the emotional arc? Where does it break?
4. Specificity: does the plan describe SPECIFIC UI or generic patterns?
5. What design decisions will haunt the implementer if left ambiguous?
For each finding: what's wrong, severity (critical/high/medium), and the fix.`,
  dx: `You are an independent DX engineer
reviewing this plan. You have NOT seen any prior review. Evaluate:
1. Getting started: how many steps from zero to hello world? What's the TTHW?
2. API/CLI ergonomics: naming consistency, sensible defaults, progressive disclosure?
3. Error handling: does every error path specify problem + cause + fix + docs link?
4. Documentation: copy-paste examples? Information architecture? Interactive elements?
5. Escape hatches: can developers override every opinionated default?
For each finding: what's wrong, severity (critical/high/medium), and the fix.`,
  eng: `You are an independent senior engineer
reviewing this plan. You have NOT seen any prior review. Evaluate:
1. Architecture: Is the component structure sound? Coupling concerns?
2. Edge cases: What breaks under 10x load? What's the nil/empty/error path?
3. Tests: What's missing from the test plan? What would break at 2am Friday?
4. Security: New attack surface? Auth boundaries? Input validation?
5. Hidden complexity: What looks simple but isn't?
For each finding: what's wrong, severity, and the fix.`
};

function implementationBounds(plan: string) {
  const boundaries: Array<{ name: string; start: number; end: number }> = [];
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  for (const raw of plan.split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      if (fence) {
        if (run[0] === fence.char && run.length >= fence.length && !delimiter[2]!.trim()) fence = null;
      } else if (run[0] !== '`' || !delimiter[2]!.includes('`')) {
        fence = { char: run[0]!, length: run.length };
      }
    } else if (!fence) {
      const heading = /^ {0,3}##[ \t]+(Implementation plan|Review record)[ \t]*(?:#+[ \t]*)?$/.exec(line);
      if (heading) boundaries.push({ name: heading[1]!, start: offset, end: offset + raw.length });
    }
    offset += raw.length;
  }
  if (boundaries.length !== 2 || boundaries[0]!.name !== 'Implementation plan' || boundaries[1]!.name !== 'Review record') {
    throw new Error('Expected one Implementation plan section followed by one Review record section outside Markdown code/quotes');
  }
  const start = boundaries[0]!.end;
  const end = boundaries[1]!.start;
  if (!plan.slice(start, end).trim()) throw new Error('Implementation plan is empty');
  return { start, end, reviewStart: boundaries[1]!.end };
}

export function extractImplementationPlan(plan: string): string {
  const { start, end } = implementationBounds(plan);
  return plan.slice(start, end);
}

// The author records accepted requirements, including conditions and verification,
// once. This verifies their exact transport, not approval or complete enumeration.
type AcceptedBlock = { phase: string; start: number; end: number; raw: string; body: string; newline: string; none: boolean };
function acceptedBlocks(text: string): Map<string, AcceptedBlock> {
  const blocks = new Map<string, AcceptedBlock>();
  let open: { phase: string; start: number; body: number } | null = null;
  let fence: { char: string; length: number } | null = null;
  let offset = 0;
  for (const raw of text.split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      if (fence) {
        if (run[0] === fence.char && run.length >= fence.length && !delimiter[2]!.trim()) fence = null;
      } else if (run[0] !== '`' || !delimiter[2]!.includes('`')) fence = { char: run[0]!, length: run.length };
    } else if (!fence) {
      const marker = /^<!-- (\/?)autoplan-accepted:(ceo|design|dx|eng) -->$/.exec(line);
      if (marker) {
        const phase = marker[2]!;
        if (!marker[1]) {
          if (open || blocks.has(phase)) throw new Error('Duplicate or nested accepted-obligations block');
          open = { phase, start: offset, body: offset + raw.length };
        } else {
          if (!open || open.phase !== phase) throw new Error('Unmatched accepted-obligations block');
          const body = text.slice(open.body, offset).trim();
          const none = /^None: \S[^\r\n]*$/.test(body);
          if (!body || (!none && (/^None:/.test(body) || !/^- \S/m.test(body)))) {
            throw new Error('Accepted obligations require complete list items or None: reason');
          }
          if (!none && body.split(/\r?\n/).some(line => line.trim() &&
              (!/^(?:- |[ \t]{2,})/.test(line) || /^\s*(?:[-*]\s+)?(?:Severity|Verdict|Consensus|Reviewer|Surfaced by):/i.test(line.replace(/[*_`]/g, ''))))) {
            throw new Error('Accepted block must contain implementation list items, not review metadata');
          }
          const end = offset + raw.length;
          blocks.set(phase, { phase, start: open.start, end,
            raw: text.slice(open.start, offset + line.length), body: text.slice(open.body, offset), newline: raw.slice(line.length) || '\n', none });
          open = null;
        }
      } else if (/^<!-- \/?autoplan-accepted:/.test(line)) throw new Error('Malformed accepted-obligations marker');
    }
    offset += raw.length;
  }
  if (open) throw new Error('Unclosed accepted-obligations block');
  return blocks;
}

// Marker lines belong to the author's retention record, not blind review data.
// Keep every requirement-body byte, including line endings and literal examples.
function implementationForReview(source: string): string {
  let result = ''; let offset = 0;
  for (const block of acceptedBlocks(source).values()) {
    if (block.none) throw new Error('No-change record does not belong in Implementation plan');
    result += source.slice(offset, block.start) + block.body;
    offset = block.end;
  }
  return result + source.slice(offset);
}

function obligationState(plan: string, phase: string, prior: string) {
  const bounds = implementationBounds(plan);
  const implementation = plan.slice(bounds.start, bounds.end);
  const recorded = acceptedBlocks(plan.slice(bounds.reviewStart));
  const applied = acceptedBlocks(implementation);
  const block = recorded.get(phase);
  if (!block) throw new Error(`Missing accepted-obligations record for ${phase}`);
  for (const [previous, immutable] of acceptedBlocks(prior)) {
    if (!recorded.has(previous) || recorded.get(previous)!.none) throw new Error(`Prior accepted obligations missing: ${previous}`);
    if (previous !== phase && recorded.get(previous)!.raw !== immutable.raw) {
      throw new Error(`Prior accepted obligations changed: ${previous}; record revisions in the current phase`);
    }
  }
  for (const [name, current] of recorded) {
    if (name === phase) continue;
    if (current.none ? applied.has(name) : applied.get(name)?.raw !== current.raw) {
      throw new Error(`Previously recorded obligations are not retained exactly: ${name}`);
    }
  }
  return { bounds, implementation, recorded, applied, block };
}

// A small exact-replacement record explains baseline byte changes. It cannot
// establish who approved them or whether every decision was recorded correctly.
function baselineEditRecords(review: string) {
  let fence: { char: string; length: number } | null = null;
  const records = new Map<string, { sourceSha256: string; replacements: Array<{ oldText: string; newText: string }> }>();
  for (const raw of review.split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      if (fence) {
        if (run[0] === fence.char && run.length >= fence.length && !delimiter[2]!.trim()) fence = null;
      } else if (run[0] !== '`' || !delimiter[2]!.includes('`')) fence = { char: run[0]!, length: run.length };
    } else if (!fence && /^<!-- \/?autoplan-baseline-edits:/.test(line)) {
      const marker = /^<!-- autoplan-baseline-edits:(ceo|design|dx|eng) (\{.*\}) -->$/.exec(line);
      if (!marker || records.has(marker[1]!)) throw new Error('Malformed or duplicate baseline-edit record');
      const record = JSON.parse(marker[2]!);
      // Canonical compact JSON also rejects duplicate keys and hidden extra fields.
      if (!record || Object.keys(record).join(',') !== 'sourceSha256,replacements' ||
          !/^[a-f0-9]{64}$/.test(record.sourceSha256) || !Array.isArray(record.replacements) ||
          JSON.stringify(record) !== marker[2]) throw new Error('Expected exact compact baseline-edit JSON');
      for (const edit of record.replacements) {
        if (!edit || Object.keys(edit).join(',') !== 'oldText,newText' || typeof edit.oldText !== 'string' ||
            !edit.oldText || typeof edit.newText !== 'string' ||
            [edit.oldText, edit.newText].some(value => Buffer.from(value).toString('utf8') !== value)) {
          throw new Error('Baseline replacements require nonempty oldText and UTF-8 newText only');
        }
      }
      records.set(marker[1]!, record);
    }
  }
  return records;
}

function editedBaseline(review: string, phase: string, prior: string): string {
  const record = baselineEditRecords(review).get(phase);
  if (!record) return prior;
  if (record.sourceSha256 !== sha256(prior)) throw new Error('Baseline-edit source SHA does not match immutable input');
  const protectedBlocks = [...acceptedBlocks(prior).values()];
  const spans = record.replacements.map(edit => {
    const start = prior.indexOf(edit.oldText);
    if (start < 0 || prior.indexOf(edit.oldText, start + 1) >= 0) throw new Error('Baseline oldText must occur exactly once');
    const end = start + edit.oldText.length;
    if (protectedBlocks.some(block => start < block.end && end > block.start)) {
      throw new Error('Baseline replacements cannot touch prior accepted blocks');
    }
    return { ...edit, start, end };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) throw new Error('Baseline replacement anchors overlap');
  }
  let result = prior;
  for (const edit of spans.reverse()) result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  if (baselineEditRecords(result).size) throw new Error('Baseline-edit metadata belongs only in Review record');
  // Edits may change requirements, never manufacture or hide retention structure.
  const afterBlocks = acceptedBlocks(result);
  if (afterBlocks.size !== protectedBlocks.length || protectedBlocks.some(block => afterBlocks.get(block.phase)?.raw !== block.raw)) {
    throw new Error('Baseline replacements changed accepted-block structure');
  }
  return result;
}

function withAcceptedBlock(baseline: string, block: AcceptedBlock) {
  const existing = acceptedBlocks(baseline).get(block.phase);
  return block.none ? baseline : existing
    ? baseline.slice(0, existing.start) + block.raw + block.newline + baseline.slice(existing.end)
    : baseline + (baseline.endsWith('\n') ? '' : '\n') + '\n' + block.raw + block.newline;
}

// Check only demonstrable document-local dependencies in recorded requirements.
// A heading's presence does not prove that its requirements are complete/correct.
function referenceProse(text: string): string[] {
  const lines: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      if (fence) {
        if (run[0] === fence.char && run.length >= fence.length && !delimiter[2]!.trim()) fence = null;
      } else if (run[0] !== '`' || !delimiter[2]!.includes('`')) fence = { char: run[0]!, length: run.length };
    } else if (!fence && !/^(?: {4}|\t|\s*>)/.test(line)) {
      lines.push(line);
    }
  }
  return lines;
}

function numberedSections(text: string) {
  const sections = new Map<string, number>();
  for (const line of referenceProse(text)) {
    const heading = /^ {0,3}#{1,6}[ \t]+Section[ \t]+(\d+(?:\.\d+)*)(?=[ \t:]|$)/i.exec(line);
    if (heading) sections.set(heading[1]!, (sections.get(heading[1]!) || 0) + 1);
  }
  return sections;
}

function checkLocalRequirementReferences(review: string, implementation: string, block: AcceptedBlock) {
  if (block.none) return;
  // The prior block is a structural boundary, not an inferred phase heading.
  const precedingEnd = Math.max(0, ...[...acceptedBlocks(review).values()]
    .filter(other => other.end <= block.start).map(other => other.end));
  const targets = numberedSections(review.slice(precedingEnd, block.start));
  const available = numberedSections(implementation);
  for (const line of referenceProse(block.body)) {
    const prose = line.replace(/(`+).*?\1|"(?:\\.|[^"\\])*"|“[^”]*”/g, '');
    for (const reference of prose.matchAll(/\b(?:in|under)[ \t]+Section[ \t]+(\d+(?:\.\d+)*)(?!\d|\.\d)\b/gi)) {
      const before = prose.slice(0, reference.index);
      const tail = prose.slice(reference.index! + reference[0].length);
      // Exempt only an attached external source, never an unrelated clause.
      if (/^[ \t]+(?:of|in|from)\b|^[ \t]*\(/i.test(tail) ||
          /(?:https?:\/\/[^\s;]+|\b[^\s;]+\.(?:md|pdf|html))[,]?[ \t]+(?:as[ \t]+specified[ \t]+)?$/i.test(before)) continue;
      const section = reference[1]!;
      if (targets.get(section) === 1 && !available.has(section)) {
        throw new Error(`Accepted ${block.phase} requirements reference Review-record-only Section ${section}; inline its required details in the accepted block, remove the dangling reference, and retry`);
      }
    }
  }
}

function expectedAmendment(plan: string, phase: string, prior: string, state: ReturnType<typeof obligationState>) {
  const baseline = editedBaseline(plan.slice(state.bounds.reviewStart), phase, prior);
  const implementation = withAcceptedBlock(baseline, state.block);
  if (state.block.none && baseline !== prior) throw new Error('None cannot authorize baseline replacements');
  checkLocalRequirementReferences(plan.slice(state.bounds.reviewStart), implementation, state.block);
  return { baseline, implementation };
}

/** The CLI close check adds exact recorded-obligation retention to the byte check. */
export function checkPhaseImplementation(phase: string, activePlan: string, snapshotPath: string, expected: string) {
  const checked = checkImplementation(phase, activePlan, snapshotPath, expected);
  const plan = readFileSync(checked.activePlan, 'utf8');
  const prior = snapshotIdentity(phase, activePlan, snapshotPath).original;
  const state = obligationState(plan, phase, prior);
  if (state.block.none ? state.applied.has(phase) : state.applied.get(phase)?.raw !== state.block.raw) {
    throw new Error(`Accepted ${phase} obligations are not retained exactly in Implementation plan; run amend`);
  }
  if (state.block.none && expected !== 'unchanged') throw new Error('None requires unchanged with its recorded reason');
  if (state.implementation !== expectedAmendment(plan, phase, prior, state).implementation) {
    throw new Error('Unrecorded Implementation rewrite; preserve immutable input or record exact baseline replacements');
  }
  return { ...checked, recordedObligations: { phase, sha256: sha256(state.block.raw), none: state.block.none },
    limitation: 'Exact recorded text retained; approval, enumeration and semantic correctness still require review.' };
}

/** Copy the current phase's whole accepted block; never re-summarize its conditions. */
export function amendImplementation(phase: string, activePlan: string, snapshotPath: string) {
  const source = realpathSync(activePlan);
  const original = readFileSync(source, 'utf8');
  const prior = snapshotIdentity(phase, activePlan, snapshotPath).original;
  // Reuse the unchanged snapshot identity checks without assuming current changes.
  checkImplementation(phase, source, snapshotPath, extractImplementationPlan(original) === prior ? 'unchanged' : 'changed');
  const state = obligationState(original, phase, prior);
  const planned = expectedAmendment(original, phase, prior, state);
  const allowed = [prior, planned.baseline, planned.implementation];
  const current = state.applied.get(phase);
  // The current phase may accumulate more obligations after an earlier amend.
  // Only its block may differ; its surrounding baseline must still be exact.
  if (current) allowed.push(withAcceptedBlock(prior, current), withAcceptedBlock(planned.baseline, current));
  if (!allowed.includes(state.implementation)) {
    throw new Error('Unrecorded Implementation rewrite; no overwrite; preserve input or record exact baseline replacements');
  }
  if (state.block.none) return checkPhaseImplementation(phase, source, snapshotPath, 'unchanged');
  const nextImplementation = planned.implementation;
  const next = original.slice(0, state.bounds.start) + nextImplementation + original.slice(state.bounds.end);
  // Validate the assembled text before publishing, including its section boundary.
  const validated = obligationState(next, phase, prior);
  if (validated.applied.get(phase)?.raw !== validated.block.raw) {
    throw new Error('Assembled accepted obligations do not match; no overwrite');
  }
  if (next !== original) {
    const before = statSync(source, { bigint: true });
    const directory = mkdtempSync(join(dirname(source), '.autoplan-amend-'));
    try {
      const stage = join(directory, 'plan');
      writeFileSync(stage, next, { flag: 'wx', mode: Number(before.mode & 0o777n) });
      const current = statSync(source, { bigint: true });
      if (before.dev !== current.dev || before.ino !== current.ino || readFileSync(source, 'utf8') !== original) {
        throw new Error('Active plan changed during amendment; no overwrite');
      }
      renameSync(stage, source);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  return checkPhaseImplementation(phase, source, snapshotPath, extractImplementationPlan(next) === prior ? 'unchanged' : 'changed');
}

/** Initialize the existing strict section contract before any scope or review call. */
export function initializePlan(sourcePlan: string, activePlan: string, restorePath: string) {
  if (![sourcePlan, activePlan, restorePath].every(isAbsolute)) throw new Error('Initialization requires three absolute paths');
  const source = realpathSync(sourcePlan);
  const destination = (file: string) => {
    let parent = dirname(file);
    const missing: string[] = [];
    while (!lstatSync(parent, { throwIfNoEntry: false })) {
      missing.unshift(basename(parent)); parent = dirname(parent);
    }
    const canonical = join(realpathSync(parent), ...missing, basename(file));
    const state = lstatSync(canonical, { throwIfNoEntry: false, bigint: true });
    if (state && !state.isFile()) throw new Error('Initialization destinations must be regular files, not links or directories');
    return { file: canonical, state, bytes: state ? readFileSync(canonical) : undefined };
  };
  const active = destination(activePlan);
  const restore = destination(restorePath);
  // Windows file IDs can exceed Number's exact range. Preserve their full
  // identity for alias, concurrent-change and rollback ownership checks.
  const sourceState = statSync(source, { bigint: true });
  if (!sourceState.isFile()) throw new Error('Initialization source must be a regular file');
  const sourceBytes = readFileSync(source);
  const sameFile = (a: typeof sourceState, b: typeof sourceState) => a.dev === b.dev && a.ino === b.ino;
  if (restore.file === source || restore.file === active.file ||
      (restore.state && (sameFile(restore.state, sourceState) || (active.state && sameFile(restore.state, active.state)))) ||
      (active.state && active.file !== source && sameFile(active.state, sourceState))) {
    throw new Error('Initialization source, active and restore paths have an ambiguous alias');
  }
  const normalized = (original: Buffer) => {
    const text = original.toString('utf8');
    if (!text.trim() || !Buffer.from(text).equals(original)) throw new Error('Initialization source must be nonempty UTF-8 text');
    let plan = text;
    try { extractImplementationPlan(plan); }
    catch {
      plan = `## Implementation plan\n${text}${text.endsWith('\n') ? '' : '\n'}## Review record\n`;
      // Partial/duplicate boundaries and unclosed fences remain errors, not raw-plan fallbacks.
      extractImplementationPlan(plan);
    }
    const reference = JSON.stringify(restore.file).replace(/--/g, '\\u002d\\u002d');
    return Buffer.from(`<!-- /autoplan restore point: ${reference} -->\n${plan}`);
  };
  const result = (original: Buffer, reused: boolean) => ({
    sourcePlan: source, activePlan: active.file, restorePath: restore.file,
    originalSha256: sha256(original.toString('utf8')), originalBytes: original.length,
    reused, scope: detectDxScope(active.file),
  });
  if (restore.bytes) {
    if (!active.bytes?.equals(normalized(restore.bytes)) || (source !== active.file && !sourceBytes.equals(restore.bytes))) {
      throw new Error('Existing restore does not match this initialization; preserve it and use a new restore path');
    }
    return result(restore.bytes, true);
  }
  if (active.bytes && active.bytes.length && !active.bytes.equals(sourceBytes)) {
    throw new Error('Active plan already has different content; refusing to overwrite it');
  }
  const next = normalized(sourceBytes);
  const expectedScopeHash = sha256(extractImplementationPlan(next.toString('utf8')));
  const unchanged = () => {
    const now = statSync(source, { bigint: true });
    const current = lstatSync(active.file, { throwIfNoEntry: false, bigint: true });
    if (!sameFile(now, sourceState) || !readFileSync(source).equals(sourceBytes) ||
        (active.state ? !current?.isFile() || !sameFile(current, active.state) || !readFileSync(active.file).equals(active.bytes!) : current !== undefined)) {
      throw new Error('Initialization input or destination changed; refusing to overwrite it');
    }
  };
  let activeStage: string | undefined;
  let restoreStage: string | undefined;
  let backupPublished = false;
  let activePublished = false;
  const createdParents: string[] = [];
  const ensureParent = (dir: string) => {
    const existing = lstatSync(dir, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isDirectory() || realpathSync(dir) !== dir) throw new Error('Initialization parent changed or is not a directory');
      return;
    }
    ensureParent(dirname(dir));
    mkdirSync(dir, { mode: 0o700 });
    createdParents.push(dir);
  };
  try {
    // A harness may assign a plan before its plans directory exists.
    // Create only explicit destination parents, after validating all input bytes.
    ensureParent(dirname(active.file));
    ensureParent(dirname(restore.file));
    activeStage = mkdtempSync(join(dirname(active.file), '.gstack-autoplan-init-'));
    restoreStage = mkdtempSync(join(dirname(restore.file), '.gstack-autoplan-restore-'));
    const stagedActive = join(activeStage, 'active.md');
    const stagedRestore = join(restoreStage, 'original.md');
    writeFileSync(stagedActive, next, { flag: 'wx', mode: active.state ? Number(active.state.mode & 0o777n) : 0o600 });
    writeFileSync(stagedRestore, sourceBytes, { flag: 'wx', mode: 0o400 });
    unchanged();
    // Link publishes complete restore bytes exclusively; an existing backup is never replaced.
    linkSync(stagedRestore, restore.file);
    backupPublished = true;
    unchanged();
    // An assigned existing plan is replaced atomically after its identity/content recheck.
    // A previously absent destination uses an exclusive link to reject a new collision.
    if (active.state) renameSync(stagedActive, active.file);
    else linkSync(stagedActive, active.file);
    activePublished = true;
    const initialized = result(sourceBytes, false);
    if (initialized.scope.sha256 !== expectedScopeHash) throw new Error('Initialized plan changed before scope readback');
    return initialized;
  } finally {
    // On pre-publication failure remove only the restore inode this invocation published.
    if (backupPublished && !activePublished && restoreStage) {
      const current = lstatSync(restore.file, { throwIfNoEntry: false, bigint: true });
      if (current?.isFile() && sameFile(current, statSync(join(restoreStage, 'original.md'), { bigint: true }))) unlinkSync(restore.file);
    }
    if (activeStage) rmSync(activeStage, { recursive: true, force: true });
    if (restoreStage) rmSync(restoreStage, { recursive: true, force: true });
    if (!activePublished) for (const dir of createdParents.reverse()) {
      // Never remove someone else's newly created content during rollback.
      try { rmdirSync(dir); } catch {}
    }
  }
}

function phaseName(phase: string): string {
  if (!PHASES.includes(phase)) throw new Error('Phase must be ceo, design, dx or eng');
  return phase;
}

function methodologyContent(phase: string, skillFile: string) {
  phaseName(phase);
  const skill = `plan-${phase === 'dx' ? 'devex' : phase}-review`;
  if (!isAbsolute(skillFile) || basename(skillFile) !== 'SKILL.md') throw new Error('Expected an absolute installed SKILL.md path');
  const readPart = (file: string) => {
    const resolved = realpathSync(file);
    if (!statSync(resolved).isFile()) throw new Error('Methodology source must be a regular file');
    const bytes = readFileSync(resolved);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('Methodology source must be valid UTF-8');
    return { path: file, resolvedPath: resolved, bytes, text };
  };
  const main = readPart(skillFile);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(main.text);
  if (!frontmatter?.[1]!.split(/\r?\n/).includes(`name: ${skill}`)) {
    throw new Error('Methodology skill identity does not match this phase');
  }
  const mainProse = referenceProse(main.text).join('\n');
  const indexHeadings = [...mainProse.matchAll(/^## Section index[^\r\n]*$/gm)];
  const parts = [main];
  if (indexHeadings.length) {
    if (indexHeadings.length !== 1 || /^## Review Sections\b/m.test(mainProse)) throw new Error('Ambiguous methodology layout');
    const index = mainProse.slice(indexHeadings[0]!.index! + indexHeadings[0]![0].length).split(/\n## /)[0]!;
    const sections = [...index.matchAll(/`(sections\/[^`]+)`/g)].map(match => match[1]!);
    if (sections.length !== 1 || sections[0] !== 'sections/review-sections.md') throw new Error('Expected the one complete current review section');
    const section = readPart(join(dirname(skillFile), sections[0]));
    const sectionProse = referenceProse(section.text).join('\n');
    if ([...sectionProse.matchAll(/^## Review Sections\b/gm)].length !== 1 ||
        /^## Section index\b/m.test(sectionProse) || /sections\/[\w.-]+\.md/.test(sectionProse)) {
      throw new Error('Missing or nested methodology review section');
    }
    parts.push(section);
  } else if ([...mainProse.matchAll(/^## Review Sections\b/gm)].length !== 1) {
    throw new Error('Inline methodology is missing its complete review section');
  }
  // Read and validate every source before creating anything. Preserve source
  // bytes inside explicit ranges; separators never replace a source newline.
  const chunks: Buffer[] = [];
  let offset = 0;
  const sources = parts.map(part => {
    const header = Buffer.from(`<!-- Autoplan methodology source: ${JSON.stringify(part.path)} -->\n`);
    chunks.push(header, part.bytes, Buffer.from('\n\n'));
    const startByte = offset + header.length;
    offset = startByte + part.bytes.length + 2;
    return { path: part.path, resolvedPath: part.resolvedPath, sha256: sha256(part.text), bytes: part.bytes.length,
      startByte, endByte: startByte + part.bytes.length };
  });
  const content = Buffer.concat(chunks);
  return { content, sources };
}

/** Explicit pagination avoids losing a final partial chunk; it is not Read evidence. */
function methodologyReadRanges(lines: number) {
  return Array.from({ length: Math.ceil(lines / 600) }, (_, index) => {
    const offset = index * 600 + 1;
    const limit = Math.min(600, lines - offset + 1);
    return { offset, limit, endLine: offset + limit - 1 };
  });
}

/** One complete current-phase load target, not evidence that an agent read it. */
export function prepareMethodology(phase: string, skillFile: string, restorePath: string) {
  const restore = realpathSync(restorePath);
  if (!statSync(restore).isFile()) throw new Error('Expected the existing restore-point file');
  const { content, sources } = methodologyContent(phase, skillFile);
  const directory = mkdtempSync(join(dirname(restore), `autoplan-${phase}-methodology-`));
  try {
    const methodologyPath = join(directory, 'methodology.md');
    const manifest = { phase, methodologyPath, restorePath: restore, restoreSha256: sha256(readFileSync(restore)),
      sha256: sha256(content.toString('utf8')), bytes: content.length,
      lines: content.toString('utf8').split('\n').length,
      readRanges: methodologyReadRanges(content.toString('utf8').split('\n').length), sources,
      instruction: 'Read methodologyPath at every readRanges offset/limit, including the final chunk, before create or dispatch; log successful ranges through EOF. Apply the existing Autoplan skip list and overrides. This artifact supplies exact methodology, not proof of reading or execution.' };
    writeFileSync(methodologyPath, content, { flag: 'wx', mode: 0o444 });
    writeFileSync(join(directory, 'methodology.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o444 });
    return manifest;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Require preparation, never treat a supplied artifact/hash as proof of reading. */
function requireMethodology(phase: string, restore: string, methodologyPath: string) {
  if (typeof methodologyPath !== 'string' || !isAbsolute(methodologyPath) || basename(methodologyPath) !== 'methodology.md') {
    throw new Error('Expected METHODOLOGY_PATH from methodology PHASE SKILL_FILE RESTORE_PATH; Read it completely before create');
  }
  const directory = dirname(methodologyPath);
  const manifestPath = join(directory, 'methodology.json');
  if (realpathSync(methodologyPath) !== methodologyPath || dirname(directory) !== dirname(restore) ||
      !basename(directory).startsWith(`autoplan-${phase}-methodology-`)) {
    throw new Error('Methodology artifact does not belong to this phase and restore directory');
  }
  for (const file of [methodologyPath, manifestPath]) {
    const stat = lstatSync(file);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o444)) {
      throw new Error('Expected immutable regular methodology files');
    }
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.phase !== phase || manifest.methodologyPath !== methodologyPath || manifest.restorePath !== restore ||
      manifest.restoreSha256 !== sha256(readFileSync(restore)) || !Array.isArray(manifest.sources) ||
      typeof manifest.sources[0]?.path !== 'string') {
    throw new Error('Methodology identity does not match this phase and restore point');
  }
  const { content, sources } = methodologyContent(phase, manifest.sources[0].path);
  if (!readFileSync(methodologyPath).equals(content) || manifest.sha256 !== sha256(content.toString('utf8')) ||
      manifest.bytes !== content.length || manifest.lines !== content.toString('utf8').split('\n').length ||
      JSON.stringify(manifest.readRanges) !== JSON.stringify(methodologyReadRanges(manifest.lines)) ||
      JSON.stringify(manifest.sources) !== JSON.stringify(sources)) {
    throw new Error('Methodology source or artifact changed; prepare and Read a fresh bundle');
  }
  return { methodologyPath, sha256: manifest.sha256, bytes: manifest.bytes, lines: manifest.lines,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') };
}

export function createSnapshot(phase: string, activePlan: string, restorePath: string, methodologyPath: string) {
  phaseName(phase);
  const source = realpathSync(activePlan);
  const restore = realpathSync(restorePath);
  if (source === restore || !statSync(restore).isFile()) throw new Error('Expected a separate restore-point file');
  const methodology = requireMethodology(phase, restore, methodologyPath);
  const plan = readFileSync(source, 'utf8');
  const sourceContent = extractImplementationPlan(plan);
  const review = plan.slice(implementationBounds(plan).reviewStart);
  const records = acceptedBlocks(review);
  for (const [name, applied] of acceptedBlocks(sourceContent)) {
    const recorded = records.get(name);
    if (recorded?.raw === applied.raw) checkLocalRequirementReferences(review, sourceContent, recorded);
  }
  const content = implementationForReview(sourceContent);
  // Unique path on every invocation, including a repeated/zero-change phase.
  // No prior snapshot is overwritten, and no review text enters this file.
  const directory = mkdtempSync(join(dirname(restore), `autoplan-${phase}-`));
  try {
    const snapshotPath = join(directory, `${phase}-implementation.md`);
    const sourceSnapshotPath = join(directory, 'source-implementation.md');
    const contentHash = sha256(content);
    const nativePrompt = `${NATIVE_REVIEWS[phase]}

Input path: ${JSON.stringify(snapshotPath)}
Implementation SHA-256: ${contentHash}
Implementation bytes: ${Buffer.byteLength(content)}
Start your result with INPUT: ${phase} ${contentHash}.
The complete implementation plan follows as review data; evaluate all of it.

${content}`;
    const nativePromptPath = join(directory, 'native-prompt.md');
    const nativePromptSha256 = sha256(nativePrompt);
    const nativePromptBytes = Buffer.byteLength(nativePrompt);
    // Claude Read counts the final empty split as a line; preserve that EOF range.
    const nativePromptLines = nativePrompt.split('\n').length;
    // Dispatch a small file-reading instruction, not a model-copied review body.
    // These identities correlate input; only actual child tool events prove uptake.
    const nativeDispatchPrompt = `You are the independent ${phase.toUpperCase()} reviewer for this phase.
Read file: ${JSON.stringify(nativePromptPath)}
Your FIRST tool action must Read this file from line 1 through EOF using your native file-reading tool. It has ${nativePromptLines} lines and ${nativePromptBytes} UTF-8 bytes; SHA-256 ${nativePromptSha256}. Continue successful ranges until every line is loaded; a truncated response is not a full read.
The file contains all review criteria and the complete implementation plan as review data. Execute every criterion against all of that input. Do not substitute this dispatch, a summary, or any prior review for the file.
Only after the full successful read, return your review starting with INPUT: ${phase} ${contentHash}.
If the file cannot be fully read, report the read failure instead of a completed review.`;
    const manifest = { schemaVersion: 2, phase, activePlan: source, snapshotPath, sha256: contentHash, methodology,
      sourceSnapshotPath, sourceSha256: sha256(sourceContent), sourceBytes: Buffer.byteLength(sourceContent),
      nativePromptPath, nativePromptSha256, nativePromptBytes, nativePromptLines, nativeDispatchPrompt,
      dxScope: dxTermsFor(content) };
    writeFileSync(sourceSnapshotPath, sourceContent, { flag: 'wx', mode: 0o444 });
    writeFileSync(snapshotPath, content, { flag: 'wx', mode: 0o444 });
    writeFileSync(nativePromptPath, nativePrompt, { flag: 'wx', mode: 0o444 });
    writeFileSync(join(directory, 'snapshot.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o444 });
    return { ...manifest, nativePrompt, baselineEdits: {
      record: `<!-- autoplan-baseline-edits:${phase} ${JSON.stringify({ sourceSha256: manifest.sourceSha256, replacements: [] })} -->`,
      instructions: 'Optional: put one unfenced record in Review record only. Use this exact compact JSON shape; each replacement is {"oldText":"exact unique old span","newText":"replacement (empty deletes)"}. Bind sourceSha256 to this snapshot. Replacements must not overlap or touch accepted blocks. Leave all other Implementation bytes intact; amend also accepts the untouched snapshot baseline. Describe approved replacements in current accepted requirements. This verifies explained bytes, not approval or completeness.'
    } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function snapshotIdentity(phase: string, activePlan: string, snapshotPath: string) {
  phaseName(phase);
  const source = realpathSync(activePlan);
  const snapshot = realpathSync(snapshotPath);
  const manifest = JSON.parse(readFileSync(join(dirname(snapshot), 'snapshot.json'), 'utf8'));
  const content = readFileSync(snapshot, 'utf8');
  if (![1, 2].includes(manifest.schemaVersion) || manifest.phase !== phase || manifest.activePlan !== source ||
      manifest.snapshotPath !== snapshot || manifest.sha256 !== sha256(content) || basename(snapshot) !== `${phase}-implementation.md`) {
    throw new Error('Snapshot identity/content does not match this phase and active plan');
  }
  let original = content;
  if (manifest.schemaVersion === 2) {
    const originalPath = join(dirname(snapshot), 'source-implementation.md');
    if (manifest.sourceSnapshotPath !== originalPath || !lstatSync(originalPath).isFile()) {
      throw new Error('Snapshot source identity does not match its immutable directory');
    }
    original = readFileSync(originalPath, 'utf8');
    if (manifest.sourceSha256 !== sha256(original) || manifest.sourceBytes !== Buffer.byteLength(original) ||
        implementationForReview(original) !== content) {
      throw new Error('Snapshot source content or blind review projection does not match');
    }
  } else if (lstatSync(join(dirname(snapshot), 'source-implementation.md'), { throwIfNoEntry: false }) ||
      manifest.sourceSnapshotPath !== undefined || manifest.sourceSha256 !== undefined ||
      manifest.sourceBytes !== undefined || acceptedBlocks(content).size) {
    throw new Error('Legacy snapshot cannot contain accepted-obligation source metadata');
  }
  return { source, snapshot, original };
}

export function checkImplementation(phase: string, activePlan: string, snapshotPath: string, expected: string) {
  if (expected !== 'changed' && expected !== 'unchanged') throw new Error('Expected changed or unchanged');
  const { source, snapshot, original } = snapshotIdentity(phase, activePlan, snapshotPath);
  const implementation = extractImplementationPlan(readFileSync(source, 'utf8'));
  const changed = implementation !== original;
  if (changed !== (expected === 'changed')) {
    throw new Error(`Implementation plan is ${changed ? 'changed' : 'unchanged'}; review-record/task edits are not implementation amendments`);
  }
  // This is a byte-level readback, NOT proof that any decision was approved or
  // implemented correctly. The reviewer must check the actual text vs decisions.
  return { phase, activePlan: source, snapshotPath: snapshot, changed, sha256: sha256(implementation), implementation };
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'init') {
      if (args.length !== 3 || args.some(arg => !arg)) throw new Error('Usage: init SOURCE_PLAN ACTIVE_PLAN RESTORE_PATH');
      process.stdout.write(JSON.stringify(initializePlan(args[0]!, args[1]!, args[2]!)) + '\n');
    } else if (command === 'methodology') {
      if (args.length !== 3 || args.some(arg => !arg)) throw new Error('Usage: methodology PHASE SKILL_FILE RESTORE_PATH');
      process.stdout.write(JSON.stringify(prepareMethodology(args[0]!, args[1]!, args[2]!)) + '\n');
    } else if (command === 'create') {
      if (args.length !== 4 || args.some(arg => !arg)) throw new Error('Usage: create PHASE ACTIVE_PLAN RESTORE_PATH METHODOLOGY_PATH (prepare methodology and Read it completely first)');
      process.stdout.write(JSON.stringify(createSnapshot(args[0]!, args[1]!, args[2]!, args[3]!)) + '\n');
    } else if (command === 'scope') {
      const [activePlan, ...flags] = args;
      if (!activePlan || flags.some(flag => !['--developer-tool', '--agent-primary'].includes(flag)) ||
          new Set(flags).size !== flags.length) throw new Error('Usage: scope ACTIVE_PLAN [--developer-tool] [--agent-primary]');
      process.stdout.write(JSON.stringify(detectDxScope(activePlan, flags.includes('--developer-tool'), flags.includes('--agent-primary'))) + '\n');
    } else {
      const [phase, active, location, expected, ...extra] = args;
      if (!phase || !active || !location || extra.length || (command === 'amend' && expected)) throw new Error('Usage: amend PHASE ACTIVE_PLAN SNAPSHOT_PATH | check PHASE ACTIVE_PLAN SNAPSHOT_PATH changed|unchanged');
      const result = command === 'amend' ? amendImplementation(phase, active, location)
        : command === 'check' && expected ? checkPhaseImplementation(phase, active, location, expected)
        : (() => { throw new Error('Expected create, amend or check command'); })();
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch (error) {
    console.error(`gstack-autoplan-snapshot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
