import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { atomicWriteSync } from './fs-atomic';
import { qaDeadlineStatus, readQaDeadline, runQaDeadlineCommand, runQaWindowsWorker, startQaDeadline, withQaReceiptOutput } from './qa-deadline';
import { scan } from './redact-engine';

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const exact = (value: unknown, keys: string[]) => object(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
class QaEvidenceError extends Error {}
const currentRevision = () => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return result.status === 0 && /^[0-9a-f]{40,64}$/.test(result.stdout.trim()) ? result.stdout.trim() : undefined;
};

function id(value: string): string {
  if (!/^\d{3}$/.test(value)) throw new QaEvidenceError('Capture and checkpoint IDs must be three digits');
  return value;
}

export function qaEvidenceRoot(value: string): string {
  const root = path.resolve(value);
  if (!value || value.includes('\0') || value.split(/[\\/]/).includes('..') || root === path.parse(root).root
    || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()
    || (process.getuid && fs.lstatSync(root).uid !== process.getuid())) throw new QaEvidenceError('Invalid report root');
  let current = root;
  while (current !== path.parse(current).root) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new QaEvidenceError('Linked report root');
    current = path.dirname(current);
  }
  return root;
}

function owned(root: string, value: string): string {
  const target = path.resolve(root, value);
  if (!value || value.includes('\0') || value.split(/[\\/]/).includes('..') || !target.startsWith(root + path.sep)) throw new QaEvidenceError('Source must be inside the report root');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))) throw new QaEvidenceError('Linked or nonregular evidence path');
    if (stat && process.getuid && stat.uid !== process.getuid()) throw new QaEvidenceError('Evidence path has a different owner');
  }
  return target;
}

function read(root: string, name: string): Buffer {
  const target = owned(root, name);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    const current = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== current.ino || stat.dev !== current.dev) throw new QaEvidenceError('Changed evidence source');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function decode(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function privateDirectory(root: string, name: string, exclusive = false): string {
  const target = owned(root, name);
  try { fs.mkdirSync(target, { mode: 0o700 }); }
  catch (error) { if (exclusive || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) throw new QaEvidenceError('Evidence directory must be private');
  return target;
}

function publish(root: string, name: string, value: unknown): string {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  atomicWriteSync(owned(root, name), bytes, { mode: 0o600, noReplace: true });
  return hash(bytes);
}

export function readQaCaptureRecord(reportRoot: string, captureId: string, expectedHash?: string) {
  const root = qaEvidenceRoot(reportRoot);
  const directory = `.qa-evidence/${id(captureId)}`;
  const receiptBytes = read(root, `${directory}/receipt.json`);
  if (expectedHash !== undefined && hash(receiptBytes) !== expectedHash) throw new QaEvidenceError('Capture differs from completed producer receipt');
  const receipt = JSON.parse(decode(receiptBytes));
  if (!exact(receipt, ['version', 'id', 'cwd', 'argv', 'deadline', 'timing', 'observation', 'publicOutput', 'startedAt', 'completedAt', 'exitCode', 'signal', 'status', 'stdout', 'stderr'])
    || receipt.version !== 1 || receipt.id !== captureId || !['complete', 'incomplete', 'sensitive'].includes(receipt.status)
    || receipt.signal !== null && typeof receipt.signal !== 'string' || typeof receipt.publicOutput !== 'boolean'
    || !Number.isInteger(receipt.exitCode) || receipt.exitCode < 0 || receipt.exitCode > 255
    || !path.isAbsolute(receipt.cwd) || !path.isAbsolute(receipt.deadline) || !Array.isArray(receipt.timing)
    || !Array.isArray(receipt.argv) || !receipt.argv.length || !receipt.argv.every((arg: unknown) => typeof arg === 'string')
    || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.completedAt))
    || Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) throw new QaEvidenceError('Incomplete or invalid capture');
  const stdout = read(root, `${directory}/stdout`);
  const stderr = read(root, `${directory}/stderr`);
  for (const [stream, bytes] of [['stdout', stdout], ['stderr', stderr]] as const) {
    if (!exact(receipt[stream], ['sha256', 'bytes']) || receipt[stream].sha256 !== hash(bytes) || receipt[stream].bytes !== bytes.length) throw new QaEvidenceError('Captured output changed');
  }
  return { receipt, sha256: hash(receiptBytes), stdout, stderr };
}

export function readQaCapture(reportRoot: string, captureId: string, expectedHash?: string) {
  const root = qaEvidenceRoot(reportRoot);
  const { receipt, sha256, stdout, stderr } = readQaCaptureRecord(root, captureId, expectedHash);
  if (receipt.status !== 'complete' || receipt.signal !== null) throw new QaEvidenceError('Incomplete capture cannot be published');
  const out = decode(stdout), err = decode(stderr);
  if (scan(out + '\n' + err + '\n' + JSON.stringify(receipt.argv)).findings.some(finding => finding.tier === 'HIGH')) throw new QaEvidenceError('Sensitive capture cannot be published');
  let observed: unknown = out;
  try { observed = JSON.parse(out); } catch {}
  const observationText = JSON.stringify(observed, null, 2) + '\n';
  if (!exact(receipt.observation, ['sha256', 'bytes']) || receipt.observation.sha256 !== hash(observationText)
    || receipt.observation.bytes !== Buffer.byteLength(observationText)
    || !read(root, `.qa-evidence/${id(captureId)}/observation.json`).equals(Buffer.from(observationText))) throw new QaEvidenceError('Observation view differs from captured output');
  return { receipt, sha256, stdout: out, stderr: err, observed, observationText };
}

const anchoredOn = (command: unknown, captureId: string) => typeof command === 'string' && new RegExp(`\\scapture\\s+\\S+\\s+${captureId}(?:\\s|$)`).test(command);
const nativeCommand = (command: string) => command.slice(command.indexOf(' -- ') + 4).trim();
const MERGED_NOTE = ['observationCapture', 'observationArgv', 'observed', 'hypothesis', 'nextCapture', 'nextArgv'];
const links = (note: Record<string, any>, previous: string, captureId: string) => note.observationCapture === previous && note.nextCapture === captureId
  || anchoredOn(note.observationCommand, previous) && anchoredOn(note.nextCommand, captureId);
const learned = (note: Record<string, any>) => exact(note, MERGED_NOTE)
  ? JSON.stringify(note.observationArgv) !== JSON.stringify(note.nextArgv)
  : typeof note.observationCommand === 'string' && typeof note.nextCommand === 'string' && nativeCommand(note.observationCommand) !== nativeCommand(note.nextCommand);
const validHypothesis = (value: unknown) => typeof value === 'string' && value.trim().length > 20 && /[a-z]{3}/i.test(value);

function checkpointNotes(root: string): Record<string, any>[] {
  return fs.readdirSync(root).filter(name => /^exploration-\d{3}\.json$/.test(name)).sort()
    .map(name => ({ name, ...JSON.parse(decode(read(root, name))) }));
}

function completeReceipts(root: string): Record<string, any>[] {
  if (!fs.existsSync(path.join(root, '.qa-evidence'))) return [];
  return fs.readdirSync(owned(root, '.qa-evidence')).filter(name => /^\d{3}$/.test(name) && fs.existsSync(path.join(root, '.qa-evidence', name, 'receipt.json')))
    .map(name => JSON.parse(decode(read(root, `.qa-evidence/${name}/receipt.json`))))
    .filter(receipt => receipt.status === 'complete')
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
}
const completeCaptures = (root: string): string[] => completeReceipts(root).map(receipt => receipt.id);
const latestCompleteCapture = (root: string): string | undefined => completeCaptures(root).at(-1);

/** Required native probes the caller declared (GSTACK_QA_REQUIRED_PROBES, a JSON array of child commands) that no complete capture has run yet. Informational only. */
function requiredRemaining(root: string): { requiredRemaining?: string[] } {
  let required: unknown;
  try { required = JSON.parse(process.env.GSTACK_QA_REQUIRED_PROBES ?? 'null'); } catch { return {}; }
  if (!Array.isArray(required) || !required.every(item => typeof item === 'string')) return {};
  const run = new Set(completeReceipts(root).map(receipt => Array.isArray(receipt.argv) ? receipt.argv.join(' ') : ''));
  return { requiredRemaining: required.filter(command => !run.has(command)) };
}

const snapshotOf = (observed: unknown) => object(observed) && typeof observed.snapshot === 'string' ? observed.snapshot : undefined;

/**
 * Commands whose complete captures declared an older input snapshot than the
 * latest capture and were not rerun on the current snapshot. Materialize keeps
 * each one open (the verdict cannot pass), and it publishes only once, so
 * every capture names them while they can still be rerun.
 */
function staleCommands(root: string): string[][] {
  const observed = completeReceipts(root).flatMap(receipt => {
    try { return [{ argv: receipt.argv as string[], snapshot: snapshotOf(readQaCapture(root, receipt.id).observed) }]; } catch { return []; }
  });
  const current = observed.at(-1)?.snapshot;
  if (current === undefined) return [];
  const rerun = new Set(observed.filter(row => row.snapshot === current).map(row => JSON.stringify(row.argv)));
  const stale = new Map(observed.filter(row => row.snapshot !== undefined && !rerun.has(JSON.stringify(row.argv)))
    .map(row => [JSON.stringify(row.argv), row.argv]));
  return [...stale.values()];
}

async function capture(root: string, captureId: string, publicOutput: boolean, option: string, budget: string, command: string, args: string[], after?: { capture: string; hypothesis: string }) {
  id(captureId);
  if (!command || !['--deadline', '--timeout-ms'].includes(option)) throw new QaEvidenceError('Capture requires a deadline or finite command timeout');
  const previous = latestCompleteCapture(root);
  if (after && after.capture !== previous) throw new QaEvidenceError(previous ? `--after must name capture ${previous}, the latest complete capture` : 'The first capture takes no --after');
  if (after && !validHypothesis(after.hypothesis)) throw new QaEvidenceError('Invalid --hypothesis: need one causal sentence over 20 characters');
  if (!after && previous && !checkpointNotes(root).some(note => links(note, previous, captureId))) {
    throw new QaEvidenceError(`Checkpoint required before capture ${captureId}: rerun with the causal note for capture ${previous}: capture ROOT ${captureId} ${publicOutput ? '--public ' : ''}${option} ${budget} --after ${previous} --hypothesis 'what capture ${previous} taught you to test next' -- COMMAND ARGS. To stop exploring instead, run no further probe.`);
  }
  if (option === '--timeout-ms' && (!/^[1-9]\d*$/.test(budget) || !Number.isSafeInteger(Number(budget)) || Number(budget) > 2_147_483_647)) throw new QaEvidenceError('Invalid command timeout');
  let note: Record<string, unknown> | undefined;
  if (after) {
    const observation = readQaCapture(root, after.capture);
    note = { observationCapture: after.capture, observationArgv: observation.receipt.argv, observed: observation.observed,
      hypothesis: after.hypothesis, nextCapture: captureId, nextArgv: [command, ...args] };
    if (scan(JSON.stringify(note)).findings.some(finding => finding.tier === 'HIGH')) throw new QaEvidenceError('Sensitive intent cannot be published');
    if (fs.existsSync(owned(root, `exploration-${captureId}.json`))) throw new QaEvidenceError(`Checkpoint ${captureId} already exists; use a fresh capture ID`);
  }
  privateDirectory(root, '.qa-evidence');
  const directory = privateDirectory(root, `.qa-evidence/${captureId}`, true);
  const checkpointSha256 = note && publish(root, `exploration-${captureId}.json`, note);
  const deadline = option === '--deadline' ? owned(root, path.resolve(budget)) : path.join(directory, 'deadline.json');
  if (option === '--timeout-ms') startQaDeadline(deadline, (Number(budget) / 1000).toFixed(3));
  const startedAt = new Date().toISOString();
  const fds = { stdout: fs.openSync(path.join(directory, 'stdout'), 'wx', 0o600), stderr: fs.openSync(path.join(directory, 'stderr'), 'wx', 0o600) };
  const digests = { stdout: createHash('sha256'), stderr: createHash('sha256') };
  const lengths = { stdout: 0, stderr: 0 };
  const timing: Record<string, unknown>[] = [];
  let result = { exitCode: 2, signal: null as NodeJS.Signals | null, completed: false };
  let exitCode: number;
  try {
    const emit = (_stream: 'stdout' | 'stderr', value: Record<string, unknown>, completion?: typeof result) => {
      timing.push({ guard: 'qa-deadline', ...value });
      if (completion) result = completion;
    };
    exitCode = process.platform === 'win32'
      ? await runQaWindowsWorker(['run', deadline, '--', command, ...args], emit, path.resolve(import.meta.dir, '../bin/gstack-qa-deadline'), 'qa-deadline-receipt', fds)
      : await runQaDeadlineCommand(deadline, command, args, emit, {
      write: (stream, chunk) => {
        fs.writeFileSync(fds[stream], chunk);
        digests[stream].update(chunk);
        lengths[stream] += chunk.length;
      },
      complete: value => { result = value; },
    });
    for (const stream of ['stdout', 'stderr'] as const) {
      const stat = fs.fstatSync(fds[stream]);
      const current = fs.lstatSync(owned(root, `.qa-evidence/${captureId}/${stream}`));
      if (stat.nlink !== 1 || stat.dev !== current.dev || stat.ino !== current.ino) throw new QaEvidenceError('Capture output was replaced');
      if (process.platform === 'win32') {
        const bytes = read(root, `.qa-evidence/${captureId}/${stream}`);
        digests[stream].update(bytes);
        lengths[stream] = bytes.length;
      }
    }
    fs.fsyncSync(fds.stdout);
    fs.fsyncSync(fds.stderr);
  } finally {
    fs.closeSync(fds.stdout);
    fs.closeSync(fds.stderr);
  }
  const stdout = read(root, `.qa-evidence/${captureId}/stdout`), stderr = read(root, `.qa-evidence/${captureId}/stderr`);
  const streams = {
    stdout: { sha256: digests.stdout.digest('hex'), bytes: lengths.stdout },
    stderr: { sha256: digests.stderr.digest('hex'), bytes: lengths.stderr },
  };
  let status = result.completed && result.exitCode === exitCode ? 'complete' : 'incomplete';
  if (streams.stdout.sha256 !== hash(stdout) || streams.stderr.sha256 !== hash(stderr)) status = 'incomplete';
  if (status === 'complete') {
    try {
      if (scan(decode(stdout) + '\n' + decode(stderr) + '\n' + JSON.stringify([command, ...args])).findings.some(finding => finding.tier === 'HIGH')) status = 'sensitive';
    } catch { status = 'incomplete'; }
  }
  let observation: { sha256: string; bytes: number } | null = null;
  if (status === 'complete') {
    let value: unknown = decode(stdout);
    try { value = JSON.parse(value as string); } catch {}
    const bytes = JSON.stringify(value, null, 2) + '\n';
    fs.writeFileSync(owned(root, `.qa-evidence/${captureId}/observation.json`), bytes, { flag: 'wx', mode: 0o600 });
    observation = { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
  }
  const completedAt = new Date().toISOString();
  let remainingMs: number | undefined;
  if (option === '--deadline') try { remainingMs = qaDeadlineStatus(readQaDeadline(deadline)).remainingMs; } catch {}
  const receipt = { version: 1, id: captureId, cwd: process.cwd(), argv: [command, ...args], deadline, timing, startedAt,
    completedAt, exitCode, signal: result.signal, status, observation, publicOutput,
    ...streams };
  const sha256 = publish(root, `.qa-evidence/${captureId}/receipt.json`, receipt);
  const revalidate = status === 'complete' ? staleCommands(root) : [];
  return { action: 'capture', id: captureId, status, sha256, exitCode, signal: result.signal, publicOutput,
    startedAt, completedAt, durationMs: Date.parse(completedAt) - Date.parse(startedAt), ...(remainingMs === undefined ? {} : { remainingMs }),
    ...(checkpointSha256 ? { checkpoint: captureId, checkpointSha256, link: `[checkpoint ${captureId}](exploration-${captureId}.json)` } : {}),
    ...(status === 'complete' ? { next: `Another probe requires a checkpoint anchored on capture ${captureId}: add --after ${captureId} --hypothesis 'TEXT' before --. To stop exploring, run none.${revalidate.length
      ? ` Inputs changed since these commands ran; materialize runs once and keeps each one open (the verdict cannot pass) until it is rerun on current inputs: ${revalidate.map(argv => argv.join(' ')).join('; ')}.` : ''}` } : {}),
    ...(revalidate.length ? { revalidate: revalidate.map(argv => argv.join(' ')) } : {}),
    ...requiredRemaining(root) };
}

function checkpoint(root: string, checkpointId: string, source: string | Record<string, string>) {
  id(checkpointId);
  const bytes = typeof source === 'string' ? read(root, source) : Buffer.from(JSON.stringify(source));
  const intent = JSON.parse(decode(bytes));
  if (!exact(intent, ['capture', 'observationCommand', 'hypothesis', 'nextCommand'])
    || typeof intent.capture !== 'string' || typeof intent.observationCommand !== 'string' || !intent.observationCommand.trim()
    || !validHypothesis(intent.hypothesis)
    || typeof intent.nextCommand !== 'string' || !intent.nextCommand.trim()) throw new QaEvidenceError('Invalid causal intent: need exactly capture, observationCommand, hypothesis (one sentence over 20 characters) and nextCommand');
  if (scan(decode(bytes)).findings.some(finding => finding.tier === 'HIGH')) throw new QaEvidenceError('Sensitive intent cannot be published');
  const captured = readQaCapture(root, intent.capture);
  const value = { observationCommand: intent.observationCommand, observed: captured.observed, hypothesis: intent.hypothesis, nextCommand: intent.nextCommand };
  const sha256 = publish(root, `exploration-${checkpointId}.json`, value);
  return { action: 'checkpoint', id: checkpointId, status: 'complete', sha256, capture: intent.capture, captureSha256: captured.sha256, intentSha256: hash(bytes),
    link: `[checkpoint ${checkpointId}](exploration-${checkpointId}.json)`, exitCode: 0 };
}

/** Labels the verdict reads; an unrecognized label is rejected before publication so it can be corrected. */
const QA_CLASSIFICATIONS = ['pass', 'superseded', 'product-defect', 'fail', 'setup-blocked', 'blocked', 'inconclusive'];

function materialize(root: string, source: string) {
  const bytes = read(root, source);
  if (scan(decode(bytes)).findings.some(finding => finding.tier === 'HIGH')) throw new QaEvidenceError('Sensitive annotations cannot be published');
  const supplied = JSON.parse(decode(bytes));
  if (!object(supplied)) throw new QaEvidenceError('Invalid report annotations: need a JSON object');
  const notes = checkpointNotes(root);
  const measured: Record<string, string | undefined> = { revision: currentRevision(), runtime: `bun ${Bun.version}`, cwd: process.cwd() };
  for (const [key, value] of Object.entries(measured)) {
    if (value !== undefined && supplied[key] !== undefined && supplied[key] !== value) {
      throw new QaEvidenceError(`Invalid report annotations: ${key} must be ${JSON.stringify(value)}; omit it and Q fills it`);
    }
  }
  if (!measured.revision && supplied.revision === undefined) throw new QaEvidenceError('Invalid report annotations: revision is required when git rev-parse HEAD is unavailable');
  const annotations: Record<string, any> = {
    revision: measured.revision ?? supplied.revision,
    runtime: measured.runtime,
    cwd: measured.cwd,
    limits: typeof supplied.limits === 'string' ? [supplied.limits] : supplied.limits,
    evidence: supplied.evidence,
    learning: supplied.learning ?? notes.filter(({ name, ...note }) => learned(note)).map(note => note.name.slice(12, 15)),
    ...Object.fromEntries(Object.entries(supplied).filter(([key]) => !['revision', 'runtime', 'cwd', 'limits', 'evidence', 'learning'].includes(key))),
  };
  if (!exact(annotations, ['revision', 'runtime', 'cwd', 'limits', 'evidence', 'learning'])
    || !['revision', 'runtime', 'cwd'].every(key => typeof annotations[key] === 'string' && annotations[key].trim())
    || !Array.isArray(annotations.limits) || !annotations.limits.length || !annotations.limits.every((limit: unknown) => typeof limit === 'string' && limit.trim())
    || !Array.isArray(annotations.evidence) || !Array.isArray(annotations.learning)) throw new QaEvidenceError('Invalid report annotations: need limits (non-empty string array) and evidence (row array), no other keys; revision, runtime and cwd (non-empty strings) and learning (checkpoint ID array) are filled in when omitted');
  const captures = new Set<string>();
  const argv: string[] = [];
  const evidence = annotations.evidence.map((row: any) => {
    if (!exact(row, ['capture', 'command', 'contract', 'expected', 'classification'])
      || !Object.values(row).every(value => typeof value === 'string' && value.trim()) || captures.has(row.capture)) throw new QaEvidenceError('Invalid evidence annotation: each row needs exactly capture, command, contract, expected and classification as non-empty strings, with a unique capture');
    if (!QA_CLASSIFICATIONS.includes(row.classification)) throw new QaEvidenceError(`Invalid evidence annotation: capture ${row.capture} classification must be one of ${QA_CLASSIFICATIONS.join(', ')}; put the reason in limits or Markdown, not the label`);
    captures.add(row.capture);
    const captured = readQaCapture(root, row.capture);
    argv.push(JSON.stringify(captured.receipt.argv));
    return { command: row.command, contract: row.contract, expected: row.expected, classification: row.classification, observed: captured.observed };
  });
  const latestCapture = latestCompleteCapture(root);
  const currentSnapshot = latestCapture ? snapshotOf(readQaCapture(root, latestCapture).observed) : undefined;
  const superseded = currentSnapshot === undefined ? [] : annotations.evidence.filter((row: any, index: number) => {
    const snapshot = snapshotOf(evidence[index].observed);
    return snapshot !== undefined && snapshot !== currentSnapshot && row.classification !== 'superseded';
  }).map((row: any) => row.capture);
  if (superseded.length) throw new QaEvidenceError(`Superseded evidence: capture ${superseded.join(', ')} observed an older input snapshot than the latest capture ${latestCapture}; rerun the affected probe on current inputs, or classify the row "superseded" and keep its contract open`);
  const missing = completeCaptures(root).filter(capture => !captures.has(capture)
    && !annotations.limits.some((limit: string) => new RegExp(`\\b${capture}\\b`).test(limit)));
  if (missing.length) throw new QaEvidenceError(`Invalid report annotations: add an evidence row for capture ${missing.join(', ')} (every complete capture needs one, or name it in limits with why it is withheld)`);
  const learning = annotations.learning.map((name: unknown) => {
    if (typeof name !== 'string') throw new QaEvidenceError('Invalid checkpoint reference');
    const note = JSON.parse(decode(read(root, `exploration-${id(name)}.json`)));
    if (!exact(note, ['observationCommand', 'observed', 'hypothesis', 'nextCommand']) && !exact(note, MERGED_NOTE)) throw new QaEvidenceError('Invalid referenced checkpoint');
    if (!learned(note)) {
      throw new QaEvidenceError(`Invalid learning: checkpoint ${name} replays the same probe; name checkpoints whose next probe differs, or omit learning and Q selects them`);
    }
    const { observed, ...row } = note;
    return row;
  });
  const classes = annotations.evidence.map((row: any) => String(row.classification).toLowerCase());
  const open = [
    ...annotations.evidence.filter((row: any, index: number) => String(row.classification).toLowerCase() === 'superseded'
      && !annotations.evidence.some((other: any, rerun: number) => String(other.classification).toLowerCase() !== 'superseded' && argv[rerun] === argv[index]
        && (currentSnapshot === undefined || snapshotOf(evidence[rerun].observed) === currentSnapshot))).map((row: any) => `capture ${row.capture} superseded`),
    ...completeCaptures(root).filter(capture => !captures.has(capture)).map(capture => `capture ${capture} withheld`),
    ...(requiredRemaining(root).requiredRemaining ?? []).map(command => `required probe not run: ${command}`),
    ...(annotations.evidence.length ? [] : ['no evidence rows']),
  ];
  const verdict = {
    status: classes.some((value: string) => /fail|defect/.test(value)) ? 'fail'
      : classes.some((value: string) => /block/.test(value)) ? 'blocked'
        : open.length || classes.some((value: string) => !['pass', 'superseded'].includes(value)) ? 'inconclusive' : 'pass',
    open,
  };
  if (fs.existsSync(owned(root, 'evidence.json'))) throw new QaEvidenceError('evidence.json is already published for this report root; materialize runs once, so report its printed verdict');
  const sha256 = publish(root, 'evidence.json', { ...annotations, evidence, learning, verdict });
  return { action: 'materialize', status: 'complete', sha256, annotationsSha256: hash(bytes), exitCode: 0, verdict,
    reportLinks: notes.map(note => `[checkpoint ${note.name.slice(12, 15)}](${note.name})`),
    next: `Include every reportLinks entry in the Markdown report, and report the overall status as ${verdict.status}${verdict.open.length ? ` (open: ${verdict.open.join('; ')})` : ''}; this verdict is final for this report root.` };
}

const QA_EVIDENCE_USAGE = 'capture ROOT ID [--public] --deadline FILE|--timeout-ms MS [--after PREVIOUS_CAPTURE --hypothesis TEXT] -- COMMAND ARGS (--after publishes checkpoint ID linking PREVIOUS_CAPTURE to this probe; required after the first complete capture unless a checkpoint was published) | checkpoint ROOT ID CAPTURE OBSERVATION_COMMAND HYPOTHESIS NEXT_COMMAND | checkpoint ROOT ID INTENT_FILE | materialize ROOT ANNOTATIONS (annotations: {evidence: [{capture, command, contract, expected, classification: pass|superseded|product-defect|fail|setup-blocked|blocked|inconclusive}], limits: [..]}; revision, runtime, cwd and learning are filled in)';

export async function qaEvidenceMain(args: string[]): Promise<number> {
  return withQaReceiptOutput(false, 'qa-evidence-receipt', value => value.event === 'observation'
    ? JSON.stringify(value.observed) + '\n' : value.event === 'diagnostic' ? String(value.stderr)
      : '\nQA_EVIDENCE ' + JSON.stringify({ producer: 'gstack-qa-evidence', version: 1, ...value }) + '\n', async emit => {
    try {
      const [action, reportRoot, ...rest] = args;
      if (action === '--help' && args.length === 1) {
        emit('stdout', { action: 'help', status: 'complete', usage: QA_EVIDENCE_USAGE, exitCode: 0 });
        return 0;
      }
      const root = qaEvidenceRoot(reportRoot);
      let receipt: Record<string, any>;
      const publicOutput = action === 'capture' && rest[1] === '--public';
      if (publicOutput) rest.splice(1, 1);
      const after = action === 'capture' && rest[3] === '--after' && rest[5] === '--hypothesis' ? { capture: rest[4], hypothesis: rest[6] } : undefined;
      if (after) rest.splice(3, 4);
      if (action === 'capture' && rest.length >= 5 && rest[3] === '--') {
        receipt = await capture(root, rest[0], publicOutput, rest[1], rest[2], rest[4], rest.slice(5), after);
        if (publicOutput && receipt.status === 'complete') {
          const captured = readQaCapture(root, rest[0], receipt.sha256);
          emit('stdout', { event: 'observation', observed: captured.observed });
          if (captured.stderr) emit('stderr', { event: 'diagnostic', stderr: captured.stderr });
        }
      } else if (action === 'checkpoint' && rest.length === 2) receipt = checkpoint(root, rest[0], rest[1]);
      else if (action === 'checkpoint' && rest.length === 5) receipt = checkpoint(root, rest[0], { capture: rest[1], observationCommand: rest[2], hypothesis: rest[3], nextCommand: rest[4] });
      else if (action === 'materialize' && rest.length === 1) receipt = materialize(root, rest[0]);
      else throw new QaEvidenceError(`Usage: ${QA_EVIDENCE_USAGE}`);
      emit('stdout', receipt);
      return receipt.status === 'complete' ? receipt.exitCode : receipt.status === 'incomplete' ? receipt.exitCode || 2 : 2;
    } catch (error) {
      emit('stderr', { action: 'error', message: error instanceof QaEvidenceError ? error.message : 'Evidence operation failed' });
      return 2;
    }
  });
}
