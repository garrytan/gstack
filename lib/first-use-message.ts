/**
 * first-use-message — the play spec and the texts the first-use check prints (docs/first-use-check.md).
 * The play spec holds the ten parts every ask to play or try a build carries (the factory's R47):
 * the links, the device and setup (with the target the steps run on), what it is, how to start
 * (with the numbered try-it steps, each declaring what it writes), the controls, how long, what we
 * want to learn, how to report back, known quirks and the reply word. renderTryText() is the one
 * try-it text, frozen at start, opened by the owner's own quoted words: the checker follows it and
 * the owner gets it. renderPlayMessage() adds what the check found, printed after decide() passes;
 * renderBrief() is what the cold checker from the other model family is given, and nothing more.
 */
import { buildLabel, type Decision, type FirstUseError, type Manifest } from './first-use';

export interface PlayLink { url: string; label: string; login_gated?: boolean }
/** A numbered try-it step: what the owner does, and what it writes (`none` or what); a write on his real setup names his approval. */
export interface PlayStep { text: string; writes: string; approved_write?: string }
/** What one of the five day-one actions writes, in table order; on the owner's real setup each is required. */
export type ActionWrites = Omit<PlayStep, 'text'>;
/** Where the steps run: the owner's real setup, or a copy loaded with realistic data (the default), named exactly. */
export interface PlayTarget { kind: 'real' | 'realistic-copy'; name: string; data?: string }
export interface PlaySpec {
  links: PlayLink[]; device: string; setup: string; account: string; target: PlayTarget; what: string; start: string; steps: PlayStep[]; action_writes?: ActionWrites[];
  controls: string; minutes: number; learn: string; report: string; quirks: string; reply_word: string;
}
/** R47's ten parts in order, with the play-spec fields each one reads. */
export const PLAY_PARTS: Array<{ part: string; fields: Array<keyof PlaySpec> }> = [
  { part: 'The links, each checked live minutes before sending', fields: ['links'] },
  { part: 'Device and setup', fields: ['device', 'setup', 'account', 'target', 'action_writes'] },
  { part: 'What it is, in a sentence', fields: ['what'] },
  { part: 'How to start', fields: ['start', 'steps'] },
  { part: 'Controls', fields: ['controls'] },
  { part: 'How long to play', fields: ['minutes'] },
  { part: 'What we want to learn', fields: ['learn'] },
  { part: 'How to report back', fields: ['report'] },
  { part: 'Known quirks', fields: ['quirks'] },
  { part: 'Reply word', fields: ['reply_word'] },
];
const TEXT_FIELDS = ['device', 'setup', 'account', 'what', 'start', 'controls', 'learn', 'report', 'quirks', 'reply_word'] as const;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * A complete play spec, or the R47 parts it is missing. "none" is a fine answer for quirks and for a step's writes; an
 * empty field is not. A step that writes on the owner's real setup needs `approved_write` naming his approval, and on that
 * setup `action_writes` says what each of the five day-one actions writes, under the same rule.
 */
export function checkPlaySpec(raw: unknown): { spec: PlaySpec } | { error: FirstUseError } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bad = new Set<keyof PlaySpec>();
  for (const f of TEXT_FIELDS) if (!str(o[f])) bad.add(f);
  if (typeof o.reply_word === 'string' && !/^[A-Za-z][A-Za-z0-9-]{0,23}$/.test(o.reply_word.trim())) bad.add('reply_word');
  if (!Number.isInteger(o.minutes) || (o.minutes as number) < 1 || (o.minutes as number) > 240) bad.add('minutes');
  const links = Array.isArray(o.links) ? o.links as Array<Record<string, unknown>> : [];
  const linkOk = (l: Record<string, unknown>) => typeof l?.label === 'string' && !!l.label.trim() && typeof l.url === 'string' && /^https?:\/\/[^\s]+$/.test(l.url)
    && (l.login_gated === undefined || typeof l.login_gated === 'boolean');
  if (!links.length || !links.every(linkOk)) bad.add('links');
  const t = (o.target && typeof o.target === 'object' ? o.target : {}) as Record<string, unknown>;
  const kind = t.kind === undefined ? 'realistic-copy' : t.kind;
  if ((kind !== 'real' && kind !== 'realistic-copy') || !str(t.name) || (kind === 'realistic-copy' && !str(t.data))) bad.add('target');
  const steps = Array.isArray(o.steps) ? o.steps as Array<Record<string, unknown>> : [];
  if (!steps.length || !steps.every(s => !!str(s?.text) && !!str(s?.writes))) bad.add('steps');
  const acts = o.action_writes === undefined ? undefined : Array.isArray(o.action_writes) ? o.action_writes as Array<Record<string, unknown>> : [];
  if (acts ? acts.length !== 5 || !acts.every(a => !!str(a?.writes)) : kind === 'real') bad.add('action_writes');
  if (bad.size) {
    const parts = PLAY_PARTS.filter(p => p.fields.some(f => bad.has(f))).map(p => `${p.part} (${p.fields.filter(f => bad.has(f)).join(', ')})`);
    return { error: { code: 'FIRST_USE_PLAY_SPEC_INCOMPLETE', detail: `missing or invalid: ${parts.join('; ')}` } };
  }
  const writesUnapproved = (s: Record<string, unknown>) => !/^none$/i.test(str(s.writes)) && !str(s.approved_write);
  const unapproved = kind === 'real' ? [...steps.map((s, i) => (writesUnapproved(s) ? `step ${i + 1}` : '')), ...(acts ?? []).map((a, i) => (writesUnapproved(a) ? `day-one action ${i + 1}` : ''))].filter(Boolean) : [];
  if (unapproved.length) return { error: { code: 'FIRST_USE_PLAY_SPEC_INCOMPLETE', detail: `${unapproved.join(', ')} ${unapproved.length === 1 ? 'writes' : 'write'} on the owner's real setup with no approved_write naming his lettered approval; run it on a realistic copy, or get his approval for that write first` } };
  const writesOf = (s: Record<string, unknown>) => ({ writes: str(s.writes), ...(str(s.approved_write) ? { approved_write: str(s.approved_write) } : {}) });
  const spec: PlaySpec = {
    links: links.map(l => ({ url: l.url as string, label: (l.label as string).trim(), ...(l.login_gated ? { login_gated: true } : {}) })),
    minutes: o.minutes as number,
    target: { kind: kind as PlayTarget['kind'], name: str(t.name), ...(str(t.data) ? { data: str(t.data) } : {}) },
    steps: steps.map(s => ({ text: str(s.text), ...writesOf(s) })),
    ...(acts ? { action_writes: acts.map(writesOf) } : {}),
    ...Object.fromEntries(TEXT_FIELDS.map(f => [f, str(o[f])])) as Omit<PlaySpec, 'links' | 'minutes' | 'target' | 'steps' | 'action_writes'>,
  };
  return { spec };
}

const platformName = { ios: 'iOS', android: 'Android', web: 'web', macos: 'Mac', server: 'server' } as const;
export const targetLabel = (t: PlayTarget) => (t.kind === 'real' ? `${t.name} (your real setup)` : `${t.name} (a copy loaded with ${t.data})`);

type TryInput = Pick<Manifest, 'app' | 'build' | 'play' | 'quotes' | 'steps'>;
/** The try-it text, frozen at start: the owner's quoted words with what this version does with each, then R47's ten parts with the numbered steps. */
export function renderTryText(m: TryInput): string {
  const p = m.play;
  return [
    `**Try ${m.app}: ${buildLabel(m.build)}**`, '',
    '**What you asked for, and what this version does with it:**',
    ...m.quotes.map(q => `- ${q.who}: “${q.text}” → ${q.line}`), '',
    '1. **Links:**',
    ...p.links.map(l => `   - [${l.label}](${l.url})${l.login_gated ? ' (asks you to sign in)' : ''}`),
    `2. **Device and setup:** ${p.device}. ${p.setup} Account: ${p.account}. It runs on ${targetLabel(p.target)}.`,
    `3. **What it is:** ${p.what}`,
    `4. **How to start:** ${p.start} Then:`,
    ...m.steps.map(s => `   ${s.n}. ${s.kind === 'action' ? `Try: ${s.text}` : s.text}`),
    `5. **Controls:** ${p.controls}`,
    `6. **How long:** about ${p.minutes} minutes.`,
    `7. **What we want to learn:** ${p.learn}`,
    `8. **How to report back:** ${p.report} Give it a score from 1 to 10 and one line on what stood out.`,
    `9. **Known quirks:** ${p.quirks}`,
    `10. **Reply word:** ${p.reply_word}, then your score and your line, for example "${p.reply_word} 7, the first screen was slow".`,
    '',
  ].join('\n');
}

/** The try-it message: the frozen try-it text, then what the check found and the build the owner holds now. Call only after decide() passed. */
export function renderPlayMessage(d: Decision, now: Date = new Date()): string {
  const m = d.manifest!;
  const oldest = Math.min(...d.links.map(l => Date.parse(l.checked_at)));
  const ago = Math.max(0, Math.round((now.getTime() - oldest) / 60_000));
  const notice = [...d.verdicts.filter(v => v.verdict === 'thin').map(v => `- Step ${v.n} is thin: ${v.line}`),
    ...d.verdicts.filter(v => v.notice).map(v => `- At step ${v.n} you'll see: ${v.notice}`)];
  const held = /^none$/i.test(m.holding.build) ? 'none yet: this is your first build of it.'
    : `${m.holding.build}. Known defects in it: ${m.holding.defects}.`;
  return [
    m.try_text,
    `Every link was checked live at ${new Date(oldest).toISOString().slice(11, 16)} UTC, ${ago} min before this message.`, '',
    `**What you'll notice:**`, ...(notice.length ? notice : ['- nothing beyond the known quirks above']), '',
    `**The build on your device now:** ${held}`, '',
    `**Checked before it reached you:** an agent from another model family (${m.checker.model}) followed these exact steps on ${targetLabel(m.play.target)}, on a ${platformName[m.build.platform]} ${m.build.platform === 'ios' || m.build.platform === 'android' ? 'device' : 'setup'} like yours. One line per step:`,
    ...d.verdicts.map(v => `- ${v.n} (${v.verdict}): ${v.line}`),
    '',
  ].join('\n');
}

/** One POSIX shell word: single quotes, with each embedded single quote closed, escaped and reopened. */
export const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

const DRIVE: Record<Manifest['build']['platform'], (m: Manifest) => string> = {
  ios: m => phone(m), android: m => phone(m),
  web: () => 'open the first link in a browser on that kind of device',
  macos: m => (m.play.target.kind === 'real'
    ? "drive the owner's own Mac through the Aside CLI, preferably over Tailscale; use computer use only where the browser can't reach, and never while he is using the Mac"
    : `use the Mac named as the target (${m.play.target.name}); install this exact build (deploy ${m.build.deploy ?? m.build.testflight}) the way the steps say`),
  server: m => `work on ${m.play.target.name} over its shell or CLI as the steps say, with this exact build (deploy ${m.build.deploy ?? m.build.testflight}); save a terminal capture (.txt or .log) as evidence where a screenshot shows nothing`,
};
function phone(m: Manifest): string {
  const b = m.build;
  return `attach a ${platformName[b.platform]} phone (\`tools.capy.phone\` with action "attach", platform "${b.platform}" and the model closest to the device above), install this exact build on it (action "install" with build_id "${m.phone_build}", the mobile build service's build of commit ${b.commit.slice(0, 12)}, which ${b.testflight ? `TestFlight build ${b.testflight}` : `version ${b.deploy}`} ships; if it won't install, record step 1 broken), point it at ${m.play.target.name}, and drive its screen with \`tools.capy.computer.on({ machine_id })\``;
}

/** What the cold checker is given: the exact try-it text, the target and its rules, and the commands that record each step. */
export function renderBrief(m: Manifest, dir: string): string {
  const p = m.play;
  const by = `--by ${shellQuote(m.checker.model)}`, run = `--run ${shellQuote(dir)}`, fixed = `--account ${shellQuote(p.account)} --target ${shellQuote(p.target.name)} ${by}`;
  return [
    `# Cold first-use check: ${m.app}, ${buildLabel(m.build)}`, '',
    `You are trying this build for the first time, as its owner will. You run on ${m.checker.model}; the team that built it runs on ${m.builder.family} models, and you have not seen its plan, code, notes or messages. Do not read them: you get only what the owner gets, below.`, '',
    '## Where you run it, and the rules', '',
    `Run every step on ${targetLabel(p.target)}, with the owner's kind of device and account: ${p.device}. Account: ${p.account} (\`record\` takes the account and the target exactly). On Capy, ${DRIVE[m.build.platform](m)}.`, '',
    "- Never send anything as the owner (no messages, mail or posts), and never write to the owner's real setup: a step that writes runs on the copy, except one whose approved_write below names his approval.",
    "- Never raise a prompt, a permission dialog or a sign-in on the owner's own machine while he is at it.",
    `- What you read is sent to your model provider (${m.checker.family}); stay inside the steps.`, '',
    '## The exact message the owner will get', '',
    '~~~markdown', m.try_text.trimEnd(), '~~~', '',
    `## The ${m.steps.length} steps you check (frozen ${m.created_at.slice(0, 10)})`, '',
    ...m.steps.map(s => `${s.n}. ${s.kind === 'action' ? `Day-one action, from the owner's words (quote ${s.quote}): ${s.text}. It works when: ${s.check}` : s.text}. Writes: ${s.writes === 'unknown' ? 'unknown, so treat it as a write' : s.writes}${s.approved_write ? ` (approved: ${s.approved_write})` : ''}`), '',
    '## What to do', '',
    '1. Follow the message above word for word, from a cold start, with no help beyond it.',
    "2. For each step, capture a screenshot, a short video or a terminal capture that shows the result, then record a verdict and one line on what the owner would see. useful: it does what he asked, well. thin: it works but does little. wrong: it does something other than what he asked. broken: it fails. Add --needs-lookup when the step asks the owner for something an agent could look up or do, and --notice when a system notice or prompt appears that the message doesn't warn about:",
    '', '~~~bash', `gstack-first-use record ${run} --step N --verdict useful --line 'WHAT THE OWNER SEES' --evidence FILE --device 'DEVICE YOU USED' ${fixed}`,
    `gstack-first-use record ${run} --step N --verdict thin --line 'WHAT THE OWNER SEES' --evidence FILE --device 'DEVICE YOU USED' ${fixed} --notice 'THE NOTICE' --needs-lookup 'WHAT IT ASKED FOR'`, '~~~', '',
    '3. Predict the owner\'s score from 1 to 10 for this build, with one line on why:', '',
    '~~~bash', `gstack-first-use predict ${run} --score N --why 'ONE LINE' ${by}`, '~~~', '',
    '4. Report back: one line per step (its verdict and why), your predicted score, and the one thing most likely to disappoint the owner.',
    '',
  ].join('\n');
}
