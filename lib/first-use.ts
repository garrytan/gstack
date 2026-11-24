/**
 * first-use — the cold first-use check for a first version or app build (docs/first-use-check.md).
 * Before a build reaches its owner as "ready to try", an agent from another model family follows
 * the exact try-it message the owner will get, step by step, on the real target (the owner's own
 * setup, or a copy loaded with realistic data that the play spec names), and writes a verdict and
 * one line per step: useful, thin, wrong or broken. The steps are the play spec's numbered steps,
 * then the first five things the plan's day-one table says the owner will do, each citing the
 * owner's own quoted words (GST-3608). This module keeps the record: an immutable start manifest
 * (the owner's quotes, the frozen steps and their hash, the try-it text, the play spec, the build
 * fingerprint, the build the owner holds now with its known defects, the builder's and the
 * checker's model families), one write-once file per step result with its evidence copied in and
 * hashed, dated link receipts, the checker's predicted score and the owner's scores and words.
 * decide() reads it back and refuses the try-it message unless every step was played on this
 * build and target, none is wrong, broken or asks the owner for something an agent could look up,
 * no day-one action is thin, every link was live within 15 minutes, the frozen rows and quotes
 * are unchanged and a prediction exists. The record lives in the owner's private user-level Capy
 * Drive folder on Capy (never the public repository), else under the gstack state root.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lineText, parseDayOne, parseOwnerWords, quoteGaps, quoteWhen } from './autoplan-owner-text';
import { resolveStateRoot } from './state-root';
import { checkPlaySpec, renderTryText, type PlaySpec } from './first-use-message';

export const FIRST_USE_ACTIONS = 5;
export const LINK_FRESH_MS = 15 * 60 * 1000;
export const EVIDENCE_MAX_BYTES = 100 * 1024 * 1024;
export const NOTE_MAX = 240;
export const EVIDENCE_KINDS: Record<string, 'screenshot' | 'video' | 'text'> = {
  '.png': 'screenshot', '.jpg': 'screenshot', '.jpeg': 'screenshot', '.gif': 'screenshot', '.webp': 'screenshot', '.heic': 'screenshot',
  '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.txt': 'text', '.log': 'text',
};
export const VERDICTS = ['useful', 'thin', 'wrong', 'broken'] as const;
export type Verdict = typeof VERDICTS[number];
export const PLATFORMS = ['ios', 'android', 'web', 'macos', 'server'] as const;
export type FirstUseCode = 'FIRST_USE_PLAN_UNREADY' | 'FIRST_USE_PLAY_SPEC_INCOMPLETE' | 'FIRST_USE_SAME_FAMILY' | 'FIRST_USE_NO_PRIVATE_DRIVE' | 'FIRST_USE_RECORD_INVALID' | 'FIRST_USE_REFUSED';
export interface FirstUseError { code: FirstUseCode; detail: string }
type Result<T> = T | { error: FirstUseError };
const fail = (code: FirstUseCode, detail: string) => ({ error: { code, detail } });

export interface FrozenQuote { n: number; who: string; when: string; text: string; line: string }
export interface FrozenAction { n: number; action: string; frequency: string; feature: string; route: string; first_build: string; check: string; source: string; quote: number }
/** One step of the try-it message: a play-spec step, or one of the five day-one actions (which cite a quote). */
export interface FrozenStep { n: number; kind: 'step' | 'action'; text: string; writes: string; approved_write?: string; check?: string; quote?: number }
export interface BuildId { platform: typeof PLATFORMS[number]; commit: string; testflight?: string; deploy?: string }
export interface Holding { build: string; defects: string }
export interface Manifest {
  schema_version: 2; kind: 'first-use-manifest'; app: string; created_at: string;
  source: { path: string; rows_sha256: string }; quotes: FrozenQuote[]; actions: FrozenAction[]; steps: FrozenStep[];
  try_text: string; try_sha256: string; build: BuildId & { fingerprint: string }; phone_build?: string; play: PlaySpec; holding: Holding;
  builder: { model: string; family: string }; checker: { model: string; family: string };
}
export interface StepResult {
  schema_version: 2; kind: 'first-use-result'; step: number; step_text: string; step_kind: FrozenStep['kind']; build_fingerprint: string; at: string;
  verdict: Verdict; line: string; needs_lookup?: string; notice?: string;
  evidence: { file: string; sha256: string; bytes: number; kind: 'screenshot' | 'video' | 'text' };
  device: string; account: string; target: string; by: { model: string; family: string };
}
/** Who a check speaks for: the owner-equivalent account from the play spec and the build's device class. */
export interface Audience { account: string; device_class: BuildId['platform'] }
export const audienceOf = (m: Manifest): Audience => ({ account: m.play.account, device_class: m.build.platform });
const sameAudience = (a: Partial<Audience> | undefined, b: Audience) => a?.account === b.account && a?.device_class === b.device_class;
export interface LinkReceipt { schema_version: 1; kind: 'first-use-link'; url: string; build_fingerprint: string; audience: Audience; checked_at: string; status: number; login_gated: boolean; verdict: 'live' | 'down'; error?: string }
export interface Prediction { schema_version: 1; kind: 'first-use-prediction'; score: number; why: string; by: { model: string; family: string }; at: string; build_fingerprint: string }
export interface OwnerScore { schema_version: 1; kind: 'first-use-owner-score'; score: number; words: string; by: string; at: string; build_fingerprint: string }

const FAMILY_WORDS: Array<[string, RegExp]> = [
  ['anthropic', /\b(claude|opus|sonnet|haiku|fable)\b/],
  ['openai', /\b(gpt|codex|chatgpt)\b/],
  ['google', /\bgemini\b/],
  ['xai', /\bgrok\b/],
  ['meta', /\b(llama|muse)\b/],
  ['deepseek', /\bdeepseek\b/],
  ['moonshotai', /\bkimi\b/],
  ['qwen', /\bqwen\b/],
];
/**
 * A model's family: a known provider before the slash (`openai/gpt-6.2-sol` is openai), a bare family name, or a known
 * model word, which also wins over a routing prefix (`openrouter/anthropic/claude-…` is anthropic); else the unknown
 * provider before the slash, or undefined.
 */
export function modelFamily(model: string): string | undefined {
  const s = model.trim().toLowerCase();
  if (!s) return undefined;
  const slash = s.indexOf('/');
  const prefix = slash > 0 ? s.slice(0, slash) : s;
  if (FAMILY_WORDS.some(([f]) => f === prefix)) return prefix;
  return FAMILY_WORDS.find(([, re]) => re.test(s))?.[0] ?? (slash > 0 ? prefix : undefined);
}

/** Checker free text as one plain line: Markdown links keep their text, HTML tags and line breaks go, at most NOTE_MAX characters. */
export const plainLine = (t: string | undefined): string => (t ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

/**
 * What the check freezes from the plan: every quote under `### Owner's words` (each with its time and line) and the first
 * five rows of the `### Day one` table, each citing `owner words <n>` for a real quote. The hash covers the rows and the
 * text of every quote, so editing or renumbering a cited quote changes it. The format is pinned by test/first-use.test.ts.
 */
export function freezeActions(planText: string): Result<{ actions: FrozenAction[]; quotes: FrozenQuote[]; rows_sha256: string }> {
  const day = parseDayOne(planText);
  if (day.status === 'none') return fail('FIRST_USE_PLAN_UNREADY', 'the plan has no ### Day one table');
  if (day.status === 'malformed') return fail('FIRST_USE_PLAN_UNREADY', day.reason ?? 'the day-one table is malformed');
  if (day.rows.length < FIRST_USE_ACTIONS) return fail('FIRST_USE_PLAN_UNREADY', `the day-one table has ${day.rows.length} row${day.rows.length === 1 ? '' : 's'}; the check needs ${FIRST_USE_ACTIONS}`);
  const words = parseOwnerWords(planText);
  if (words.status === 'none' || !words.quotes.length) return fail('FIRST_USE_PLAN_UNREADY', "the plan has no ### Owner's words section: quote each message of the owner's that states the job, with its time and a line each");
  if (words.status === 'malformed') return fail('FIRST_USE_PLAN_UNREADY', `### Owner's words is malformed: ${words.reason}`);
  const gaps = words.quotes.filter(q => quoteGaps(q).length);
  if (gaps.length) return fail('FIRST_USE_PLAN_UNREADY', `owner quote ${gaps.map(q => `${q.n} needs ${quoteGaps(q).join(' and ')}`).join('; ')}`);
  const rows = day.rows.slice(0, FIRST_USE_ACTIONS);
  const blank = rows.map((r, i) => [r.frequency, r.source, r.feature, r.route, r.first_build, r.check].some(c => !c.trim()) ? i + 1 : 0).filter(Boolean);
  if (blank.length) return fail('FIRST_USE_PLAN_UNREADY', `day-one row ${blank.join(', ')} has an empty cell; every column of the first ${FIRST_USE_ACTIONS} rows needs a value`);
  const assumed = rows.map((r, i) => r.assumed ? i + 1 : 0).filter(Boolean);
  if (assumed.length) return fail('FIRST_USE_PLAN_UNREADY', `day-one row ${assumed.join(', ')} is still marked assumed`);
  const cited = rows.map(r => Number(/^\W*owner words\s+(\d+)\b/i.exec(r.source)?.[1] ?? 0));
  const uncited = cited.map((n, i) => (words.quotes.some(q => q.n === n) ? 0 : i + 1)).filter(Boolean);
  if (uncited.length) return fail('FIRST_USE_PLAN_UNREADY', `day-one row ${uncited.join(', ')} cites none of the owner's quotes: its source must read "owner words <n>" (a row the owner confirmed at the gate cites his answer, added to Owner's words)`);
  const quotes = words.quotes.map(q => ({ n: q.n, who: q.who, when: quoteWhen(q), text: q.text, line: lineText(q) }));
  const actions = rows.map((r, i) => ({ n: i + 1, action: r.action, frequency: r.frequency, feature: r.feature, route: r.route, first_build: r.first_build, check: r.check, source: r.source, quote: cited[i]! }));
  return { actions, quotes, rows_sha256: sha256(JSON.stringify({ actions, quotes })) };
}

/** Validates a build id; the fingerprint is the hash of platform, commit and the TestFlight build or deploy version. */
export function buildFingerprint(b: Partial<BuildId>): Result<BuildId & { fingerprint: string }> {
  if (!(PLATFORMS as readonly string[]).includes(b.platform ?? '')) return fail('FIRST_USE_RECORD_INVALID', `--platform must be ${PLATFORMS.join(', ')}`);
  if (!/^[0-9a-f]{40}$/.test(b.commit ?? '')) return fail('FIRST_USE_RECORD_INVALID', '--commit must be the full 40-character commit the build was made from');
  const tf = b.testflight?.trim(), dep = b.deploy?.trim();
  if (!!tf === !!dep) return fail('FIRST_USE_RECORD_INVALID', 'give exactly one of --testflight <build number> or --deploy <version>');
  const id: BuildId = { platform: b.platform!, commit: b.commit!, ...(tf ? { testflight: tf } : { deploy: dep }) };
  return { ...id, fingerprint: sha256(JSON.stringify([id.platform, id.commit, id.testflight ?? '', id.deploy ?? ''])).slice(0, 16) };
}
export const buildLabel = (b: BuildId) => `${b.commit.slice(0, 12)}, ${b.testflight ? `TestFlight build ${b.testflight}` : `deploy ${b.deploy}`}`;

/**
 * Where records live: GSTACK_FIRST_USE_DIR; on Capy (GSTACK_CAPY=1) the one `~/.capy/drive/user-*` folder's
 * `first-use/` (none or several refuses, never the throwaway machine folder); elsewhere `<state root>/first-use`.
 */
export function recordRoot(env: NodeJS.ProcessEnv = process.env): Result<{ root: string }> {
  if (env.GSTACK_FIRST_USE_DIR) return { root: path.resolve(env.GSTACK_FIRST_USE_DIR) };
  if (env.GSTACK_CAPY !== '1') return { root: path.join(resolveStateRoot(env), 'first-use') };
  const drive = path.join(env.HOME || os.homedir(), '.capy', 'drive');
  let found: string[] = [];
  try { found = fs.readdirSync(drive).filter(d => d.startsWith('user-') && fs.statSync(path.join(drive, d)).isDirectory()).sort(); } catch { /* no drive mounted */ }
  if (found.length !== 1) return fail('FIRST_USE_NO_PRIVATE_DRIVE', found.length ? `${found.length} user-level drive folders (${found.join(', ')})` : `no user-level drive folder under ${drive}`);
  return { root: path.join(drive, found[0]!, 'first-use') };
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '');
const writeOnce = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
};
const readJson = <T>(file: string): T | undefined => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; } };

/** The build the owner holds now and its known defects: `none` for a first build, else a label and a list or `none`. */
function checkHolding(h: Partial<Holding> | undefined): Result<{ holding: Holding }> {
  const build = plainLine(h?.build), defects = plainLine(h?.defects);
  if (!build || !defects) return fail('FIRST_USE_RECORD_INVALID', 'name the build the owner holds now and its known defects: --holding "<build label>|none" --holding-defects "<each known defect>|none"');
  return { holding: { build, defects } };
}

export interface StartInput { root: string; app: string; planPath: string; build: Partial<BuildId>; phoneBuild?: string; play: unknown; holding: Partial<Holding>; builder: string; checker: string; now?: Date }
/** Freezes the owner's quotes, the steps and the try-it text, and writes the run's manifest once; returns the run directory. */
export function startRun(o: StartInput): Result<{ dir: string; manifest: Manifest }> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.app)) return fail('FIRST_USE_RECORD_INVALID', '--app must be a lowercase slug like ghome');
  let planText: string;
  try { planText = fs.readFileSync(o.planPath, 'utf8'); } catch { return fail('FIRST_USE_PLAN_UNREADY', `cannot read ${o.planPath}`); }
  const frozen = freezeActions(planText);
  if ('error' in frozen) return frozen;
  const play = checkPlaySpec(o.play);
  if ('error' in play) return play;
  const build = buildFingerprint(o.build);
  if ('error' in build) return build;
  const phone = build.platform === 'ios' || build.platform === 'android';
  if (phone && !/^[0-9A-Za-z]{26}$/.test(o.phoneBuild ?? '')) return fail('FIRST_USE_RECORD_INVALID', `a ${build.platform} check installs on a cloud phone, which takes only a build from Capy's mobile build service: give --phone-build <its 26-character build id> for commit ${build.commit.slice(0, 12)}, not a TestFlight or store number`);
  const holding = checkHolding(o.holding);
  if ('error' in holding) return holding;
  const builder = modelFamily(o.builder), checker = modelFamily(o.checker);
  if (!builder || !checker) return fail('FIRST_USE_SAME_FAMILY', `unknown model family for ${!builder ? `--builder ${o.builder}` : `--checker ${o.checker}`}`);
  if (builder === checker) return fail('FIRST_USE_SAME_FAMILY', `builder and checker are both ${builder}`);
  const now = o.now ?? new Date();
  const steps: FrozenStep[] = [
    ...play.spec.steps.map((s, i) => ({ n: i + 1, kind: 'step' as const, text: s.text, writes: s.writes, ...(s.approved_write ? { approved_write: s.approved_write } : {}) })),
    ...frozen.actions.map((a, i) => ({ n: play.spec.steps.length + i + 1, kind: 'action' as const, text: a.action, ...(play.spec.action_writes?.[i] ?? { writes: 'unknown' }), check: a.check, quote: a.quote })),
  ];
  const base = { schema_version: 2 as const, kind: 'first-use-manifest' as const, app: o.app, created_at: now.toISOString(),
    source: { path: path.resolve(o.planPath), rows_sha256: frozen.rows_sha256 }, quotes: frozen.quotes, actions: frozen.actions, steps,
    build, ...(phone ? { phone_build: o.phoneBuild } : {}), play: play.spec, holding: holding.holding, builder: { model: o.builder, family: builder }, checker: { model: o.checker, family: checker } };
  const try_text = renderTryText(base);
  const manifest: Manifest = { ...base, try_text, try_sha256: sha256(try_text) };
  const dir = path.join(o.root, o.app, `${stamp(now)}-${build.fingerprint.slice(0, 8)}`);
  try { writeOnce(path.join(dir, 'manifest.json'), manifest); } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${dir}/manifest.json: ${(e as Error).message}`); }
  return { dir, manifest };
}

export function readManifest(dir: string): Result<{ manifest: Manifest }> {
  const m = readJson<Omit<Manifest, 'schema_version'> & { schema_version: number }>(path.join(dir, 'manifest.json'));
  if (m?.kind === 'first-use-manifest' && m.schema_version === 1) return fail('FIRST_USE_RECORD_INVALID', `${dir} is a schema-1 run from before the try-it steps and the owner's quotes were checked; start a new run`);
  if (!m || m.schema_version !== 2 || m.kind !== 'first-use-manifest' || !Array.isArray(m.steps) || !m.build?.fingerprint) return fail('FIRST_USE_RECORD_INVALID', `no readable manifest.json in ${dir}`);
  if ((m.build.platform === 'ios' || m.build.platform === 'android') && !/^[0-9A-Za-z]{26}$/.test(m.phone_build ?? '')) return fail('FIRST_USE_RECORD_INVALID', `${dir} is a ${m.build.platform} run with no --phone-build, so its checker can't install the build on a cloud phone; start a new run with --phone-build`);
  return { manifest: m as Manifest };
}

/** The checker's own model, from its own family: the builder never grades its own build. */
function checkerOf(m: Manifest, by: string): Result<{ by: { model: string; family: string } }> {
  const family = modelFamily(by);
  if (!family || family !== m.checker.family) return fail('FIRST_USE_SAME_FAMILY', `--by ${by} is ${family ?? 'an unknown family'}; this run's checker is ${m.checker.family} (${m.checker.model})`);
  return { by: { model: by, family } };
}

export interface RecordInput { dir: string; step: number; verdict: string; line: string; evidence: string; device: string; account: string; target: string; by: string; needsLookup?: string; notice?: string; now?: Date }
/** One write-once result for one frozen step; the evidence file is copied into the run and hashed. */
export function recordResult(o: RecordInput): Result<{ file: string; result: StepResult }> {
  const read = readManifest(o.dir);
  if ('error' in read) return read;
  const m = read.manifest;
  const step = m.steps.find(s => s.n === o.step);
  if (!step) return fail('FIRST_USE_RECORD_INVALID', `--step must be 1 to ${m.steps.length}`);
  if (!(VERDICTS as readonly string[]).includes(o.verdict)) return fail('FIRST_USE_RECORD_INVALID', `--verdict must be ${VERDICTS.join(', ')}`);
  const line = plainLine(o.line);
  if (!line) return fail('FIRST_USE_RECORD_INVALID', '--line needs one line on what the owner would see at this step');
  if (!o.device.trim()) return fail('FIRST_USE_RECORD_INVALID', 'name the --device you played on');
  if (o.account.trim() !== m.play.account) return fail('FIRST_USE_RECORD_INVALID', `play on the owner-equivalent account and pass it exactly: --account "${m.play.account}"`);
  if (o.target.trim() !== m.play.target.name) return fail('FIRST_USE_RECORD_INVALID', `play on the play spec's target and pass it exactly: --target "${m.play.target.name}"`);
  const who = checkerOf(m, o.by);
  if ('error' in who) return who;
  const ev = copyEvidence(o.dir, o.step, o.evidence);
  if ('error' in ev) return ev;
  const now = o.now ?? new Date();
  const lookup = plainLine(o.needsLookup), notice = plainLine(o.notice);
  const result: StepResult = {
    schema_version: 2, kind: 'first-use-result', step: o.step, step_text: step.text, step_kind: step.kind, build_fingerprint: m.build.fingerprint, at: now.toISOString(),
    verdict: o.verdict as Verdict, line, ...(lookup ? { needs_lookup: lookup } : {}), ...(notice ? { notice } : {}),
    evidence: ev.evidence, device: o.device.trim(), account: o.account.trim(), target: o.target.trim(), by: who.by,
  };
  const file = path.join(o.dir, 'results', `${o.step}-${stamp(now)}-${crypto.randomBytes(3).toString('hex')}.json`);
  try { writeOnce(file, result); } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${file}: ${(e as Error).message}`); }
  return { file, result };
}

function copyEvidence(dir: string, n: number, src: string): Result<{ evidence: StepResult['evidence'] }> {
  const kind = EVIDENCE_KINDS[path.extname(src).toLowerCase()];
  if (!kind) return fail('FIRST_USE_RECORD_INVALID', `evidence must be a screenshot, a short video or a terminal capture (${Object.keys(EVIDENCE_KINDS).join(' ')})`);
  let st: fs.Stats;
  try { st = fs.lstatSync(src); } catch { return fail('FIRST_USE_RECORD_INVALID', `no evidence file at ${src}`); }
  if (!st.isFile()) return fail('FIRST_USE_RECORD_INVALID', 'the evidence must be a regular file, not a link or directory');
  if (st.size === 0 || st.size > EVIDENCE_MAX_BYTES) return fail('FIRST_USE_RECORD_INVALID', `the evidence is ${st.size} bytes (1 to ${EVIDENCE_MAX_BYTES})`);
  const bytes = fs.readFileSync(src);
  const digest = sha256(bytes);
  const file = path.join('evidence', `${n}-${digest.slice(0, 16)}${path.extname(src).toLowerCase()}`);
  try {
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    if (!fs.existsSync(path.join(dir, file))) fs.writeFileSync(path.join(dir, file), bytes, { flag: 'wx' });
  } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${path.join(dir, file)}: ${(e as Error).message}`); }
  return { evidence: { file, sha256: digest, bytes: bytes.length, kind } };
}

export type Fetcher = (url: string) => Promise<{ status: number }>;
export const liveFetcher: Fetcher = async url => {
  const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status };
};

/**
 * Checks every play link once for the run's audience (the owner-equivalent account and device class) and writes a
 * dated receipt per link bound to that audience; a login-gated link passes on 401 or 403 only when the play spec marks it.
 */
export async function checkLinks(dir: string, as: Partial<Audience>, fetcher: Fetcher = liveFetcher, now: () => Date = () => new Date()): Promise<Result<{ receipts: LinkReceipt[] }>> {
  const read = readManifest(dir);
  if ('error' in read) return read;
  const m = read.manifest, audience = audienceOf(m);
  if (!sameAudience(as, audience)) return fail('FIRST_USE_RECORD_INVALID', `check links as the owner-equivalent audience: --account "${audience.account}" --device-class ${audience.device_class}`);
  const receipts: LinkReceipt[] = [];
  for (const [i, link] of m.play.links.entries()) {
    let status = 0, error: string | undefined;
    try { status = (await fetcher(link.url)).status; } catch (e) { error = (e as Error).message || String(e); }
    const gated = !!link.login_gated;
    const live = (status >= 200 && status < 400) || (gated && (status === 401 || status === 403));
    const at = now();
    const receipt: LinkReceipt = { schema_version: 1, kind: 'first-use-link', url: link.url, build_fingerprint: m.build.fingerprint, audience, checked_at: at.toISOString(), status, login_gated: gated, verdict: live ? 'live' : 'down', ...(error ? { error } : {}) };
    const file = path.join(dir, 'links', `${stamp(at)}-${i + 1}-${crypto.randomBytes(3).toString('hex')}.json`);
    try { writeOnce(file, receipt); } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${file}: ${(e as Error).message}`); }
    receipts.push(receipt);
  }
  return { receipts };
}

const score = (s: string) => /^(10|[1-9])$/.test(s.trim()) ? Number(s.trim()) : undefined;

/** The checker's predicted owner score, written once per run. */
export function predict(o: { dir: string; score: string; why: string; by: string; now?: Date }): Result<{ prediction: Prediction }> {
  const read = readManifest(o.dir);
  if ('error' in read) return read;
  const n = score(o.score);
  if (n === undefined || !o.why.trim()) return fail('FIRST_USE_RECORD_INVALID', 'predict needs --score 1-10 and --why <one line>');
  const who = checkerOf(read.manifest, o.by);
  if ('error' in who) return who;
  const prediction: Prediction = { schema_version: 1, kind: 'first-use-prediction', score: n, why: plainLine(o.why), by: who.by, at: (o.now ?? new Date()).toISOString(), build_fingerprint: read.manifest.build.fingerprint };
  try { writeOnce(path.join(o.dir, 'prediction.json'), prediction); } catch { return fail('FIRST_USE_RECORD_INVALID', 'this run already has a predicted score; start a new run to predict again'); }
  return { prediction };
}

/** The owner's own score and exact words, appended (the newest counts); kept beside the prediction in the private record. */
export function ownerScore(o: { dir: string; score: string; words: string; by: string; now?: Date }): Result<{ owner: OwnerScore }> {
  const read = readManifest(o.dir);
  if ('error' in read) return read;
  const n = score(o.score);
  if (n === undefined || !o.words.trim() || !o.by.trim()) return fail('FIRST_USE_RECORD_INVALID', 'score needs --score 1-10, --words "<the owner’s exact words>" and --by <who relayed them>');
  const now = o.now ?? new Date();
  const owner: OwnerScore = { schema_version: 1, kind: 'first-use-owner-score', score: n, words: o.words, by: o.by.trim(), at: now.toISOString(), build_fingerprint: read.manifest.build.fingerprint };
  const file = path.join(o.dir, 'owner', `${stamp(now)}-${crypto.randomBytes(3).toString('hex')}.json`);
  try { writeOnce(file, owner); } catch (e) { return fail('FIRST_USE_RECORD_INVALID', `cannot write ${file}: ${(e as Error).message}`); }
  return { owner };
}

function readDir<T>(dir: string): { rows: T[]; unreadable: string[] } {
  const rows: T[] = [], unreadable: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* none yet */ }
  for (const f of names) { const r = readJson<T>(path.join(dir, f)); if (r) rows.push(r); else unreadable.push(f); }
  return { rows, unreadable };
}
const newest = <T extends { at?: string; checked_at?: string }>(rows: T[]) => [...rows].sort((a, b) => (a.at ?? a.checked_at ?? '').localeCompare(b.at ?? b.checked_at ?? '')).at(-1);

export interface StepVerdict { n: number; kind: FrozenStep['kind']; text: string; verdict: Verdict; line: string; notice?: string }
export interface Decision { ok: boolean; reasons: string[]; manifest?: Manifest; passed: number; verdicts: StepVerdict[]; links: LinkReceipt[]; prediction?: Prediction; owner?: OwnerScore }
/**
 * Whether this run clears the build about to be sent: the same build, unchanged day-one rows and quotes, a newest result
 * with intact evidence for every step on the play spec's target, none wrong, broken or needing something an agent could
 * look up, no thin day-one action (each comes from the owner's words), a live receipt under 15 minutes old for every play
 * link, and a predicted score. A thin play step or a notice the owner would see passes and is named in the message.
 */
export function decide(dir: string, build: Partial<BuildId>, now: Date = new Date()): Decision {
  const read = readManifest(dir);
  if ('error' in read) return { ok: false, reasons: [read.error.detail], passed: 0, verdicts: [], links: [] };
  const m = read.manifest, reasons: string[] = [];
  const current = buildFingerprint(build);
  if ('error' in current) reasons.push(current.error.detail);
  else if (current.fingerprint !== m.build.fingerprint) reasons.push(`build_mismatch: this run checked ${buildLabel(m.build)}, not ${buildLabel(current)}`);
  let planText: string | undefined;
  try { planText = fs.readFileSync(m.source.path, 'utf8'); } catch { reasons.push(`source_missing: ${m.source.path}`); }
  if (planText !== undefined) {
    const again = freezeActions(planText);
    if ('error' in again) reasons.push(`source_changed: ${again.error.detail}`);
    else if (again.rows_sha256 !== m.source.rows_sha256) reasons.push('source_changed: the day-one rows or the owner\'s quotes changed since the check started; start a new run');
  }
  if (m.builder.family === m.checker.family) reasons.push('same_family');
  if (sha256(m.try_text) !== m.try_sha256) reasons.push('try_text_changed: the frozen try-it text no longer matches its hash; start a new run');
  const results = readDir<StepResult>(path.join(dir, 'results'));
  if (results.unreadable.length) reasons.push(`record_unreadable: results/${results.unreadable.join(', results/')}`);
  let passed = 0;
  const verdicts: StepVerdict[] = [];
  for (const s of m.steps) {
    const r = newest(results.rows.filter(x => x.step === s.n && x.build_fingerprint === m.build.fingerprint && x.by?.family === m.checker.family
      && x.account === m.play.account && x.target === m.play.target.name));
    if (!r) { reasons.push(`step_${s.n}_not_played`); continue; }
    let bytes: Buffer | undefined;
    try { bytes = fs.readFileSync(path.join(dir, r.evidence.file)); } catch { /* missing */ }
    if (!bytes || bytes.length !== r.evidence.bytes || sha256(bytes) !== r.evidence.sha256) { reasons.push(`step_${s.n}_evidence_stale`); continue; }
    verdicts.push({ n: s.n, kind: s.kind, text: s.text, verdict: r.verdict, line: r.line, ...(r.notice ? { notice: r.notice } : {}) });
    if (r.verdict === 'wrong' || r.verdict === 'broken') { reasons.push(`step_${s.n}_${r.verdict}: ${r.line}`); continue; }
    if (r.verdict !== 'useful' && r.verdict !== 'thin') { reasons.push(`step_${s.n}_verdict_unknown: ${String(r.verdict)}`); continue; }
    if (r.needs_lookup) { reasons.push(`step_${s.n}_needs_lookup: ${r.needs_lookup} (an agent looks it up or does it; the owner is never asked)`); continue; }
    if (r.verdict === 'thin' && s.kind === 'action') { reasons.push(`step_${s.n}_thin: ${r.line} (a day-one action comes from the owner's own words)`); continue; }
    passed++;
  }
  const receipts = readDir<LinkReceipt>(path.join(dir, 'links'));
  const links: LinkReceipt[] = [];
  for (const link of m.play.links) {
    const r = newest(receipts.rows.filter(x => x.url === link.url && x.build_fingerprint === m.build.fingerprint && sameAudience(x.audience, audienceOf(m))));
    if (!r) { reasons.push(`link_unchecked: ${link.url} (as ${m.play.account} on ${m.build.platform})`); continue; }
    links.push(r);
    if (r.verdict !== 'live') reasons.push(`link_down: ${link.url} (status ${r.status || r.error || 'none'})`);
    else if (now.getTime() - Date.parse(r.checked_at) > LINK_FRESH_MS) reasons.push(`link_stale: ${link.url} was checked at ${r.checked_at}, over 15 minutes ago`);
  }
  const prediction = readJson<Prediction>(path.join(dir, 'prediction.json'));
  if (!prediction) reasons.push('no_predicted_score');
  const owner = newest(readDir<OwnerScore>(path.join(dir, 'owner')).rows);
  return { ok: reasons.length === 0, reasons, manifest: m, passed, verdicts, links, prediction, owner };
}
