/**
 * /ship section parts (GSTA-167 calls plan C5, in code): the driver's phase programs end with
 * `gstack-ship-parts next`, which returns the section text the next phase's steps use, verbatim,
 * split at headings, each byte once per run, before its first use, within the room the program has
 * left under its 32 KB return. The parent never reads these sections in a call of its own.
 *
 * PARTS is in run order. A part runs from its heading line to the next start heading listed for the
 * same file, its `until` heading, or the end of the file; a part with no heading starts at byte 0,
 * so review-army.md, adversarial.md, documentation.md and review/checklist.md are returned whole.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ROOT = path.resolve(import.meta.dir, '..');
export const PART_MAX = 24 * 1024;
export const ROOM_DEFAULT = 32000;

type PartSpec = { id: string; file: string; from: string | null; until?: string; phase: number };

const RA = 'ship/sections/review-army.md';
const ADV = 'ship/sections/adversarial.md';
const DOCS = 'ship/sections/documentation.md';
export const WHOLE = [RA, ADV, DOCS, 'review/checklist.md'];

export const PARTS: PartSpec[] = [
  { id: 'review-9', file: RA, from: null, phase: 3 },
  { id: 'review-9.1', file: RA, from: '## Step 9.1: Review Army — Specialist Dispatch', phase: 3 },
  { id: 'review-red-team', file: RA, from: '### Red Team dispatch (conditional)', phase: 3 },
  { id: 'review-9.2.1', file: RA, from: '### Step 9.2.1: Exploratory QA (before Fix-First)', phase: 3 },
  { id: 'plan-8.1-8.2', file: 'ship/sections/plan-completion.md', from: '## Step 8.1: Plan Verification', until: '## Prior Learnings', phase: 4 },
  { id: 'review-calibration', file: RA, from: '## Confidence Calibration', phase: 4 },
  { id: 'review-core', file: RA, from: '### Core checklist', phase: 4 },
  { id: 'checklist', file: 'review/checklist.md', from: null, phase: 4 },
  { id: 'checklist-pass-2', file: 'review/checklist.md', from: '### Pass 2 — INFORMATIONAL', phase: 4 },
  { id: 'review-design', file: RA, from: '## Design Review (conditional, diff-scoped)', phase: 4 },
  { id: 'review-9.2', file: RA, from: '### Step 9.2: Collect and merge findings', phase: 4 },
  { id: 'review-9.3', file: RA, from: '### Step 9.3: Cross-review finding dedup', phase: 4 },
  { id: 'review-9.4', file: RA, from: '## Step 9.4: Fix-First and persistence', phase: 4 },
  { id: 'adversarial-11', file: ADV, from: null, phase: 4 },
  { id: 'adversarial-native', file: ADV, from: '### Claude adversarial subagent (on `DISPATCH: adversarial-native`)', phase: 4 },
  { id: 'adversarial-codex', file: ADV, from: '### Codex adversarial challenge (runs whenever `CODEX_MODE` is `ready` or `unverified`)', phase: 4 },
  { id: 'adversarial-structured', file: ADV, from: '### Codex structured review (large diffs only, 200+ lines)', phase: 4 },
  { id: 'adversarial-finish', file: ADV, from: '### Persist the review result', phase: 4 },
  { id: 'adversarial-learnings', file: ADV, from: '## Capture Learnings', phase: 4 },
  { id: 'documentation', file: DOCS, from: null, phase: 6 },
];

export type Part = { id: string; file: string; phase: number; start: number; end: number; text: string };

/** Byte offset of a heading line outside code fences, or -1. */
function headingAt(buf: Buffer, heading: string): number {
  let fence = false;
  let at = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    else if (!fence && line === heading) return at;
    at += Buffer.byteLength(line) + 1;
  }
  return -1;
}

export function resolveParts(root = ROOT): Part[] {
  const bufs = new Map<string, Buffer>();
  const read = (f: string) => {
    if (!bufs.has(f)) bufs.set(f, fs.readFileSync(path.join(root, f)));
    return bufs.get(f)!;
  };
  const find = (f: string, h: string) => {
    const at = headingAt(read(f), h);
    if (at < 0) throw new Error(`PARTS_MANIFEST: heading "${h}" not found in ${f}; update lib/ship-parts.ts with the section`);
    return at;
  };
  const starts = PARTS.map(p => (p.from === null ? 0 : find(p.file, p.from)));
  return PARTS.map((p, i) => {
    const buf = read(p.file);
    const later = PARTS.map((q, j) => (q.file === p.file && starts[j] > starts[i] ? starts[j] : Infinity));
    const end = Math.min(buf.length, ...later, p.until ? find(p.file, p.until) : Infinity);
    return { id: p.id, file: p.file, phase: p.phase, start: starts[i], end, text: buf.subarray(starts[i], end).toString('utf8') };
  });
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export const block = (p: Part) =>
  `PART: ${p.id} file=${p.file} phase=${p.phase} bytes=${p.end - p.start} sha256=${sha(p.text)}\n${p.text}${p.text.endsWith('\n') ? '' : '\n'}PART_END: ${p.id}\n`;

/** The next parts in run order that fit `room` bytes, and the parts due by `phase` that did not fit. */
export function nextParts(parts: Part[], returned: readonly string[], phase: number, room: number) {
  const out: Part[] = [];
  let used = 0;
  for (const p of parts) {
    if (returned.includes(p.id)) continue;
    const b = Buffer.byteLength(block(p));
    if (used + b > room) break;
    out.push(p);
    used += b;
  }
  const given = new Set([...returned, ...out.map(p => p.id)]);
  return {
    out,
    due: parts.filter(p => p.phase <= phase && !given.has(p.id)).map(p => p.id),
    left: parts.filter(p => !given.has(p.id)).length,
  };
}

const HELP = `gstack-ship-parts — the section text /ship's next phase uses, verbatim, each byte once (GSTA-167 C5)

  next --run <run dir> --phase <n> [--room <bytes>] [--resend]   print the next parts that fit, in run order
  list                                                 every part with its phase and size

Each phase program ends with \`next --phase <its phase + 1>\` and --room set to 32000 less the
program's other output; the room covers the whole output, the PARTS: and NEXT: lines included.
\`NEXT: parts\` means a part due by that phase did not fit: run \`next\` alone before the phase.
A batch is \`sent\` until the next \`next\` call promotes it to returned; after a return that never
reached the parent, \`next --resend\` sends that batch again. State: <run dir>/parts/state.json.
`;

export function shipParts(argv: readonly string[], root = ROOT): { text: string; exit: number } {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') return { text: HELP, exit: cmd ? 0 : 2 };
  if (cmd !== 'next' && cmd !== 'list') return { text: `unknown command: ${cmd}\n${HELP}`, exit: 2 };
  let parts: Part[];
  try { parts = resolveParts(root); } catch (e) { return { text: `STOP: ${(e as Error).message}\n`, exit: 3 }; }
  if (cmd === 'list') return { text: parts.map(p => `${p.id} phase=${p.phase} bytes=${p.end - p.start} file=${p.file}`).join('\n') + '\n', exit: 0 };
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const run = flag('--run');
  const phase = Number(flag('--phase'));
  const room = flag('--room') === undefined ? ROOM_DEFAULT : Number(flag('--room'));
  if (!run || !Number.isInteger(phase) || !Number.isFinite(room)) return { text: 'next needs --run <dir> and --phase <n>; --room is a byte count\n', exit: 2 };
  const state = path.join(run, 'parts', 'state.json');
  let saved: { returned: string[]; sent?: string[] } = { returned: [] };
  try {
    if (fs.existsSync(state)) saved = JSON.parse(fs.readFileSync(state, 'utf8'));
    if (!Array.isArray(saved.returned) || (saved.sent !== undefined && !Array.isArray(saved.sent))) throw new Error('returned and sent must be id lists');
  } catch (e) {
    return { text: `STOP: ${state} is not a parts state file (${(e as Error).message}); delete it and rerun to start the run's parts again\n`, exit: 3 };
  }
  const returned = rest.includes('--resend') ? saved.returned : [...saved.returned, ...(saved.sent ?? [])];
  const trailer = (ids: string[], due: string[], left: number) => {
    const lines = [`PARTS: phase=${phase} returned=${ids.join(',') || 'none'} due=${due.join(',') || 'none'} left=${left}`];
    if (due.length) lines.push(`NEXT: parts (run \`gstack-ship-parts next --run ${quote(run)} --phase ${phase}\` alone before Phase ${phase})`);
    return lines.join('\n') + '\n';
  };
  const open = parts.filter(p => !returned.includes(p.id)).map(p => p.id);
  const { out, due, left } = nextParts(parts, returned, phase, room - Buffer.byteLength(trailer(open, open, open.length)));
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, JSON.stringify({ returned, sent: out.map(p => p.id) }, null, 2) + '\n');
  return { text: out.map(block).join('') + trailer(out.map(p => p.id), due, left), exit: 0 };
}
