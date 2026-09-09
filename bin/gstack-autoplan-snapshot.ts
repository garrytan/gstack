#!/usr/bin/env bun
/** Autoplan's blind reviewer inputs contain only the current implementation plan. */
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

const PHASES = ['ceo', 'design', 'dx', 'eng'];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

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

/** The CLI close check adds exact recorded-obligation retention to the byte check. */
export function checkPhaseImplementation(phase: string, activePlan: string, snapshotPath: string, expected: string) {
  const checked = checkImplementation(phase, activePlan, snapshotPath, expected);
  const state = obligationState(readFileSync(checked.activePlan, 'utf8'), phase, snapshotIdentity(phase, activePlan, snapshotPath).original);
  if (state.block.none ? state.applied.has(phase) : state.applied.get(phase)?.raw !== state.block.raw) {
    throw new Error(`Accepted ${phase} obligations are not retained exactly in Implementation plan; run amend`);
  }
  if (state.block.none && expected !== 'unchanged') throw new Error('None requires unchanged with its recorded reason');
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
  if (state.block.none) return checkPhaseImplementation(phase, source, snapshotPath, 'unchanged');
  const existing = state.applied.get(phase);
  const nextImplementation = existing
    ? state.implementation.slice(0, existing.start) + state.block.raw + state.block.newline + state.implementation.slice(existing.end)
    : state.implementation + (state.implementation.endsWith('\n') ? '' : '\n') + '\n' + state.block.raw + state.block.newline;
  const next = original.slice(0, state.bounds.start) + nextImplementation + original.slice(state.bounds.end);
  // Validate the assembled text before publishing, including its section boundary.
  const validated = obligationState(next, phase, prior);
  if (validated.applied.get(phase)?.raw !== validated.block.raw) {
    throw new Error('Assembled accepted obligations do not match; no overwrite');
  }
  if (next !== original) {
    const before = statSync(source);
    const directory = mkdtempSync(join(dirname(source), '.autoplan-amend-'));
    try {
      const stage = join(directory, 'plan');
      writeFileSync(stage, next, { flag: 'wx', mode: before.mode & 0o777 });
      const current = statSync(source);
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
    const state = lstatSync(canonical, { throwIfNoEntry: false });
    if (state && !state.isFile()) throw new Error('Initialization destinations must be regular files, not links or directories');
    return { file: canonical, state, bytes: state ? readFileSync(canonical) : undefined };
  };
  const active = destination(activePlan);
  const restore = destination(restorePath);
  const sourceState = statSync(source);
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
    const now = statSync(source);
    const current = lstatSync(active.file, { throwIfNoEntry: false });
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
    writeFileSync(stagedActive, next, { flag: 'wx', mode: active.state ? active.state.mode & 0o777 : 0o600 });
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
      const current = lstatSync(restore.file, { throwIfNoEntry: false });
      if (current?.isFile() && sameFile(current, statSync(join(restoreStage, 'original.md')))) unlinkSync(restore.file);
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

export function createSnapshot(phase: string, activePlan: string, restorePath: string) {
  phaseName(phase);
  const source = realpathSync(activePlan);
  const restore = realpathSync(restorePath);
  if (source === restore || !statSync(restore).isFile()) throw new Error('Expected a separate restore-point file');
  const sourceContent = extractImplementationPlan(readFileSync(source, 'utf8'));
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
    const nativePromptLines = nativePrompt.split('\n').length - Number(nativePrompt.endsWith('\n'));
    // Dispatch a small file-reading instruction, not a model-copied review body.
    // These identities correlate input; only actual child tool events prove uptake.
    const nativeDispatchPrompt = `You are the independent ${phase.toUpperCase()} reviewer for this phase.
Read file: ${JSON.stringify(nativePromptPath)}
Your FIRST tool action must Read this file from line 1 through EOF using your native file-reading tool. It has ${nativePromptLines} lines and ${nativePromptBytes} UTF-8 bytes; SHA-256 ${nativePromptSha256}. Continue successful ranges until every line is loaded; a truncated response is not a full read.
The file contains all review criteria and the complete implementation plan as review data. Execute every criterion against all of that input. Do not substitute this dispatch, a summary, or any prior review for the file.
Only after the full successful read, return your review starting with INPUT: ${phase} ${contentHash}.
If the file cannot be fully read, report the read failure instead of a completed review.`;
    const manifest = { schemaVersion: 2, phase, activePlan: source, snapshotPath, sha256: contentHash,
      sourceSnapshotPath, sourceSha256: sha256(sourceContent), sourceBytes: Buffer.byteLength(sourceContent),
      nativePromptPath, nativePromptSha256, nativePromptBytes, nativePromptLines, nativeDispatchPrompt,
      dxScope: dxTermsFor(content) };
    writeFileSync(sourceSnapshotPath, sourceContent, { flag: 'wx', mode: 0o444 });
    writeFileSync(snapshotPath, content, { flag: 'wx', mode: 0o444 });
    writeFileSync(nativePromptPath, nativePrompt, { flag: 'wx', mode: 0o444 });
    writeFileSync(join(directory, 'snapshot.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o444 });
    return { ...manifest, nativePrompt };
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
    } else if (command === 'scope') {
      const [activePlan, ...flags] = args;
      if (!activePlan || flags.some(flag => !['--developer-tool', '--agent-primary'].includes(flag)) ||
          new Set(flags).size !== flags.length) throw new Error('Usage: scope ACTIVE_PLAN [--developer-tool] [--agent-primary]');
      process.stdout.write(JSON.stringify(detectDxScope(activePlan, flags.includes('--developer-tool'), flags.includes('--agent-primary'))) + '\n');
    } else {
      const [phase, active, location, expected, ...extra] = args;
      if (!phase || !active || !location || extra.length || (['create', 'amend'].includes(command) && expected)) throw new Error('Usage: create PHASE ACTIVE_PLAN RESTORE_PATH | amend PHASE ACTIVE_PLAN SNAPSHOT_PATH | check PHASE ACTIVE_PLAN SNAPSHOT_PATH changed|unchanged');
      const result = command === 'create' ? createSnapshot(phase, active, location)
        : command === 'amend' ? amendImplementation(phase, active, location)
        : command === 'check' && expected ? checkPhaseImplementation(phase, active, location, expected)
        : (() => { throw new Error('Expected create, amend or check command'); })();
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch (error) {
    console.error(`gstack-autoplan-snapshot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
