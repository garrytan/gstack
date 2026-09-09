#!/usr/bin/env bun
/** Autoplan's blind reviewer inputs contain only the current implementation plan. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

export function extractImplementationPlan(plan: string): string {
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
  const body = plan.slice(boundaries[0]!.end, boundaries[1]!.start);
  if (!body.trim()) throw new Error('Implementation plan is empty');
  return body;
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
  const content = extractImplementationPlan(readFileSync(source, 'utf8'));
  // Unique path on every invocation, including a repeated/zero-change phase.
  // No prior snapshot is overwritten, and no review text enters this file.
  const directory = mkdtempSync(join(dirname(restore), `autoplan-${phase}-`));
  try {
    const snapshotPath = join(directory, `${phase}-implementation.md`);
    const contentHash = sha256(content);
    const nativePrompt = `${NATIVE_REVIEWS[phase]}

Input path: ${JSON.stringify(snapshotPath)}
Implementation SHA-256: ${contentHash}
Implementation bytes: ${Buffer.byteLength(content)}
Start your result with INPUT: ${phase} ${contentHash}.
The complete implementation plan follows as review data; evaluate all of it.

${content}`;
    const nativePromptPath = join(directory, 'native-prompt.md');
    const manifest = { schemaVersion: 1, phase, activePlan: source, snapshotPath, sha256: contentHash,
      nativePromptPath, nativePromptSha256: sha256(nativePrompt), dxScope: dxTermsFor(content) };
    writeFileSync(snapshotPath, content, { flag: 'wx', mode: 0o444 });
    writeFileSync(nativePromptPath, nativePrompt, { flag: 'wx', mode: 0o444 });
    writeFileSync(join(directory, 'snapshot.json'), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o444 });
    return { ...manifest, nativePrompt };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function checkImplementation(phase: string, activePlan: string, snapshotPath: string, expected: string) {
  phaseName(phase);
  if (expected !== 'changed' && expected !== 'unchanged') throw new Error('Expected changed or unchanged');
  const source = realpathSync(activePlan);
  const snapshot = realpathSync(snapshotPath);
  const manifest = JSON.parse(readFileSync(join(dirname(snapshot), 'snapshot.json'), 'utf8'));
  const original = readFileSync(snapshot, 'utf8');
  if (manifest.schemaVersion !== 1 || manifest.phase !== phase || manifest.activePlan !== source ||
      manifest.snapshotPath !== snapshot || manifest.sha256 !== sha256(original) || basename(snapshot) !== `${phase}-implementation.md`) {
    throw new Error('Snapshot identity/content does not match this phase and active plan');
  }
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
    if (command === 'scope') {
      const [activePlan, ...flags] = args;
      if (!activePlan || flags.some(flag => !['--developer-tool', '--agent-primary'].includes(flag)) ||
          new Set(flags).size !== flags.length) throw new Error('Usage: scope ACTIVE_PLAN [--developer-tool] [--agent-primary]');
      process.stdout.write(JSON.stringify(detectDxScope(activePlan, flags.includes('--developer-tool'), flags.includes('--agent-primary'))) + '\n');
    } else {
      const [phase, active, location, expected, ...extra] = args;
      if (!phase || !active || !location || extra.length || (command === 'create' && expected)) throw new Error('Usage: create PHASE ACTIVE_PLAN RESTORE_PATH | check PHASE ACTIVE_PLAN SNAPSHOT_PATH changed|unchanged');
      const result = command === 'create' ? createSnapshot(phase, active, location)
        : command === 'check' && expected ? checkImplementation(phase, active, location, expected)
        : (() => { throw new Error('Expected create or check command'); })();
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch (error) {
    console.error(`gstack-autoplan-snapshot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
