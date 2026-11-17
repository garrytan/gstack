/**
 * first-use-message — the play spec and the two texts the first-use check prints
 * (docs/first-use-check.md). The play spec holds the ten parts every ask to play
 * or try a build carries (the factory's R47): the links, the device and setup,
 * what it is, how to start, the controls, how long, what we want to learn, how
 * to report back, known quirks and the reply word. renderPlayMessage() is the
 * only "try this build" text, printed after decide() passes; renderBrief() is
 * what the cold checker from the other model family is given, and nothing more.
 */
import { buildLabel, type Decision, type FirstUseError, type Manifest } from './first-use';

export interface PlayLink { url: string; label: string; login_gated?: boolean }
export interface PlaySpec {
  links: PlayLink[]; device: string; setup: string; account: string; what: string; start: string;
  controls: string; minutes: number; learn: string; report: string; quirks: string; reply_word: string;
}
/** R47's ten parts in order, with the play-spec fields each one reads. */
export const PLAY_PARTS: Array<{ part: string; fields: Array<keyof PlaySpec> }> = [
  { part: 'The links, each checked live minutes before sending', fields: ['links'] },
  { part: 'Device and setup', fields: ['device', 'setup', 'account'] },
  { part: 'What it is, in a sentence', fields: ['what'] },
  { part: 'How to start', fields: ['start'] },
  { part: 'Controls', fields: ['controls'] },
  { part: 'How long to play', fields: ['minutes'] },
  { part: 'What we want to learn', fields: ['learn'] },
  { part: 'How to report back', fields: ['report'] },
  { part: 'Known quirks', fields: ['quirks'] },
  { part: 'Reply word', fields: ['reply_word'] },
];
const TEXT_FIELDS = ['device', 'setup', 'account', 'what', 'start', 'controls', 'learn', 'report', 'quirks', 'reply_word'] as const;

/** A complete play spec, or the R47 parts it is missing. "none" is a fine answer for quirks; an empty field is not. */
export function checkPlaySpec(raw: unknown): { spec: PlaySpec } | { error: FirstUseError } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bad = new Set<keyof PlaySpec>();
  for (const f of TEXT_FIELDS) if (typeof o[f] !== 'string' || !(o[f] as string).trim()) bad.add(f);
  if (typeof o.reply_word === 'string' && !/^[A-Za-z][A-Za-z0-9-]{0,23}$/.test(o.reply_word.trim())) bad.add('reply_word');
  if (!Number.isInteger(o.minutes) || (o.minutes as number) < 1 || (o.minutes as number) > 240) bad.add('minutes');
  const links = Array.isArray(o.links) ? o.links as Array<Record<string, unknown>> : [];
  const linkOk = (l: Record<string, unknown>) => typeof l?.label === 'string' && !!l.label.trim() && typeof l.url === 'string' && /^https?:\/\/[^\s]+$/.test(l.url)
    && (l.login_gated === undefined || typeof l.login_gated === 'boolean');
  if (!links.length || !links.every(linkOk)) bad.add('links');
  if (bad.size) {
    const parts = PLAY_PARTS.filter(p => p.fields.some(f => bad.has(f))).map(p => `${p.part} (${p.fields.filter(f => bad.has(f)).join(', ')})`);
    return { error: { code: 'FIRST_USE_PLAY_SPEC_INCOMPLETE', detail: `missing or invalid: ${parts.join('; ')}` } };
  }
  const spec: PlaySpec = {
    links: links.map(l => ({ url: l.url as string, label: (l.label as string).trim(), ...(l.login_gated ? { login_gated: true } : {}) })),
    minutes: o.minutes as number,
    ...Object.fromEntries(TEXT_FIELDS.map(f => [f, (o[f] as string).trim()])) as Omit<PlaySpec, 'links' | 'minutes'>,
  };
  return { spec };
}

const hhmm = (iso: string) => iso.slice(11, 16);
const platformName = { ios: 'iOS', android: 'Android', web: 'web' } as const;

/** The "try this build" message: R47's ten parts, then what the cold check covered. Call only after decide() passed. */
export function renderPlayMessage(d: Decision, now: Date = new Date()): string {
  const m = d.manifest!, p = m.play;
  const checked = d.links.map(l => Date.parse(l.checked_at));
  const oldest = Math.min(...checked);
  const ago = Math.max(0, Math.round((now.getTime() - oldest) / 60_000));
  return [
    `**Try ${m.app}: ${buildLabel(m.build)}**`, '',
    `1. **Links** (each checked live at ${new Date(oldest).toISOString().slice(11, 16)} UTC, ${ago} min before this message):`,
    ...p.links.map(l => `   - [${l.label}](${l.url})${l.login_gated ? ' (asks you to sign in)' : ''}`),
    `2. **Device and setup:** ${p.device}. ${p.setup} Account: ${p.account}.`,
    `3. **What it is:** ${p.what}`,
    `4. **How to start:** ${p.start}`,
    `5. **Controls:** ${p.controls}`,
    `6. **How long:** about ${p.minutes} minutes.`,
    `7. **What we want to learn:** ${p.learn}`,
    `8. **How to report back:** ${p.report} Give it a score from 1 to 10 and one line on what stood out.`,
    `9. **Known quirks:** ${p.quirks}`,
    `10. **Reply word:** ${p.reply_word}, then your score and your line, for example "${p.reply_word} 7, the first screen was slow".`,
    '',
    `Checked before it reached you: an agent from another model family (${m.checker.model}) played this exact build cold on a ${platformName[m.build.platform]} cloud device and did the first ${m.actions.length} things you'll do on day one. All ${d.passed} worked, with a screenshot or video of each:`,
    ...m.actions.map(a => `- ${a.action}`),
    '',
  ].join('\n');
}

/** One POSIX shell word: single quotes, with each embedded single quote closed, escaped and reopened. */
export const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** What the cold checker is given: the build, the device and account, the play message parts and the frozen actions, with the commands that record each. */
export function renderBrief(m: Manifest, dir: string): string {
  const p = m.play, b = m.build;
  const install = b.platform === 'web'
    ? 'open the first link in a browser on that device'
    : `attach a ${platformName[b.platform]} phone (\`tools.capy.phone\` with action "attach", platform "${b.platform}" and the model closest to the device above), install this exact build on it (action "install"; ${b.testflight ? `TestFlight build ${b.testflight}` : `version ${b.deploy}`}), and drive its screen with \`tools.capy.computer.on({ machine_id })\``;
  const by = `--by ${shellQuote(m.checker.model)}`, run = `--run ${shellQuote(dir)}`;
  return [
    `# Cold first-use check: ${m.app}, ${buildLabel(b)}`, '',
    `You are playing this build for the first time, as its owner will. You run on ${m.checker.model}; the team that built it runs on ${m.builder.family} models, and you have not seen its plan, code, notes or messages. Do not read them: you get only what the owner gets, below.`, '',
    '## Device and account', '',
    `Use the same kind of device and account as the owner: ${p.device}. ${p.setup} Account: ${p.account} (play only on this kind of account; \`record\` takes it exactly). On Capy, ${install}.`, '',
    '## What the owner is told', '',
    `- What it is: ${p.what}`, `- Links: ${p.links.map(l => `${l.label} ${l.url}`).join('; ')}`, `- How to start: ${p.start}`, `- Controls: ${p.controls}`,
    `- How long: about ${p.minutes} minutes`, `- Known quirks: ${p.quirks}`, '',
    `## The ${m.actions.length} things the owner will do on day one (frozen ${m.created_at.slice(0, 10)})`, '',
    ...m.actions.map(a => `${a.n}. ${a.action} (${a.frequency || 'how often unstated'}). Way in: ${a.route || 'not stated'}. It works when: ${a.check}`), '',
    '## What to do', '',
    '1. Do each action as the owner would, from a cold start, with no help beyond the text above.',
    '2. Capture a screenshot or a short video that shows the result, then record it. A pass means the owner would see it work on the first try; anything else is a fail, and the note says what happened:',
    '', '```bash', `gstack-first-use record ${run} --action N --verdict pass --evidence FILE --device 'DEVICE YOU USED' --account ${shellQuote(p.account)} ${by}`,
    `gstack-first-use record ${run} --action N --verdict fail --evidence FILE --device 'DEVICE YOU USED' --account ${shellQuote(p.account)} ${by} --note 'WHAT HAPPENED'`, '```', '',
    '3. Predict the owner\'s score from 1 to 10 for this build, with one line on why:', '',
    '```bash', `gstack-first-use predict ${run} --score N --why 'ONE LINE' ${by}`, '```', '',
    '4. Report back: one line per action (pass or fail and why), your predicted score, and the one thing most likely to disappoint the owner.',
    '',
  ].join('\n');
}

