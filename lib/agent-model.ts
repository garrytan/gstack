import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigKeyWithRoot, type StateRootEnv } from './state-root';

/**
 * The agent role: the model a user wants gstack's working agents (lanes,
 * subagents, reviewers) to run on. It is a preference the user sets, never a
 * policy gstack ships, and it is read apart from the strict model policy so a
 * bad value here never stops plan-review, implementation or eval-arms picks.
 * Precedence: a one-job request, then agent_model in config.yaml (this
 * machine), then agent_model in the file GSTACK_PREFERENCES_FILE names (the
 * Capy skill folder's preferences.yaml, kept across machines), then host.
 */

export const AGENT_MODEL_KEY = 'agent_model' as const;
export const PREFERENCES_FILE_MAX_BYTES = 4096;
const DOCS = 'https://github.com/garrytan/gstack/blob/main/docs/model-policy.md#your-model-preference';

/** Family names a preference may use. When gstack's tier catalog lists a family, its entry here is the same model (test/agent-model.test.ts). */
export const MODEL_FAMILIES = Object.freeze([
  { family: 'opus', provider: 'anthropic', model: 'claude-opus-5-5' },
  { family: 'fable', provider: 'anthropic', model: 'claude-fable-5-1' },
  { family: 'sonnet', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { family: 'haiku', provider: 'anthropic', model: 'claude-haiku-5-5' },
  { family: 'astra', provider: 'openai', model: 'gpt-6-astra' },
  { family: 'sol', provider: 'openai', model: 'gpt-6.1-sol' },
  { family: 'luna', provider: 'openai', model: 'gpt-6-luna' },
  { family: 'terra', provider: 'openai', model: 'gpt-6.1-terra' },
].map(f => Object.freeze(f)));

export const AGENT_MODEL_EXEMPTIONS = Object.freeze([
  'a cross-family outside voice (gstack-models resolve --role plan-review)',
  'a model under test in an eval (gstack-models resolve --role eval-arms, /eval-plan arms)',
]);

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;

export type AgentModelSourceKind = 'request' | 'config' | 'preferences' | 'default';

export interface AgentModelSelection {
  role: 'agent';
  status: 'selected' | 'host';
  provider: string | null;
  model: string | null;
  /** Provider-qualified id, the form a Capy model field takes; null in host mode (omit the model field). */
  id: string | null;
  family: string | null;
  value: string;
  source: { kind: AgentModelSourceKind; path: string | null };
  sources: { config: string | null; configPath: string | null; preferences: string | null; preferencesPath: string | null };
  warnings: string[];
  exemptions: readonly string[];
}

export class AgentModelError extends Error {
  constructor(readonly problem: string, readonly cause: string, readonly repair: string[]) {
    super(problem);
  }
  toJSON() {
    return { reason: 'invalid_agent_model', problem: this.problem, cause: this.cause, key: AGENT_MODEL_KEY, repair: this.repair, docs: DOCS };
  }
}

function printable(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

function sanitize(value: string): string {
  return printable(value).slice(0, 200);
}

type Parsed = { kind: 'host' } | { kind: 'model'; provider: string; model: string; family: string | null };

/** host | a family name | <provider>/<model>. Syntax only; bin/gstack-config holds the same grammar. */
export function parseAgentModel(raw: string): Parsed | null {
  const value = raw.trim();
  if (value.toLowerCase() === 'host') return { kind: 'host' };
  const family = MODEL_FAMILIES.find(f => f.family === value.toLowerCase());
  if (family) return { kind: 'model', provider: family.provider, model: family.model, family: family.family };
  const slash = value.indexOf('/');
  if (slash < 0) return null;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (!PROVIDER_PATTERN.test(provider) || !MODEL_PATTERN.test(model)) return null;
  return { kind: 'model', provider, model, family: null };
}

function invalid(value: string, where: string, repair: string[]): AgentModelError {
  return new AgentModelError(
    `agent_model '${sanitize(value)}' in ${where} is not a model gstack can use`,
    `use host, a family (${MODEL_FAMILIES.map(f => f.family).join(', ')}) or a provider-qualified id such as anthropic/claude-opus-5-5`,
    repair,
  );
}

/** Read agent_model from a preferences file: `key: value` lines, # comments, at most 4 KB. Unknown keys warn; a duplicate agent_model is an error. */
export function readPreferencesFile(file: string): { value: string | null; warnings: string[] } {
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { value: null, warnings: [`${file} is not a file; ignored`] };
    const bytes = stat.size > PREFERENCES_FILE_MAX_BYTES ? null : fs.readFileSync(file);
    if (!bytes || bytes.length > PREFERENCES_FILE_MAX_BYTES) return { value: null, warnings: [`${file} is over ${PREFERENCES_FILE_MAX_BYTES} bytes; ignored`] };
    text = bytes.toString('utf-8').replace(/^\uFEFF/, '');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { value: null, warnings: code === 'ENOENT' ? [] : [`${file} is unreadable (${code ?? 'unknown error'}); ignored`] };
  }
  const warnings: string[] = [];
  let value: string | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const m = /^([a-z][a-z0-9_]*):(.*)$/.exec(line);
    if (!m) { warnings.push(`${file}:${i + 1} is not a 'key: value' line; ignored`); return; }
    if (m[1] !== AGENT_MODEL_KEY) { warnings.push(`${file}:${i + 1} sets '${sanitize(m[1])}', which gstack does not read from preferences; ignored`); return; }
    if (value !== null) throw new AgentModelError(`${file} sets agent_model twice`, 'keep one agent_model line', [`edit ${file}`]);
    value = m[2].replace(/\s#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
  });
  return { value: value === '' ? null : value, warnings };
}

export function resolveAgentModel(opts: { env?: StateRootEnv; platform?: NodeJS.Platform; request?: string } = {}): AgentModelSelection {
  const env = opts.env ?? process.env;
  const reading = readConfigKeyWithRoot('agent_model', env, opts.platform ?? process.platform);
  const configPath = reading.root ? path.join(reading.root, 'config.yaml') : null;
  const preferencesPath = env.GSTACK_PREFERENCES_FILE?.trim() || null;
  let prefs: { value: string | null; warnings: string[] } = { value: null, warnings: [] };
  try {
    if (preferencesPath) prefs = readPreferencesFile(preferencesPath);
  } catch (error) {
    if (!(error instanceof AgentModelError) || (opts.request === undefined && reading.value === null)) throw error;
    prefs = { value: null, warnings: [`${error.problem}; ignored because a higher-priority source is set`] };
  }
  const candidates: Array<{ kind: AgentModelSourceKind; value: string | null; path: string | null; repair: string[] }> = [
    { kind: 'request', value: opts.request ?? null, path: null, repair: ['pass --request host, a family or <provider>/<model>'] },
    { kind: 'config', value: reading.value, path: configPath, repair: ['gstack-config set agent_model <host|family|provider/model>', 'gstack-config unset agent_model'] },
    { kind: 'preferences', value: prefs.value, path: preferencesPath, repair: [`edit agent_model in ${preferencesPath}`] },
  ];
  const winner = candidates.find(c => c.value !== null);
  const base = {
    role: 'agent' as const,
    sources: { config: reading.value, configPath, preferences: prefs.value, preferencesPath },
    warnings: prefs.warnings,
    exemptions: AGENT_MODEL_EXEMPTIONS,
  };
  if (!winner) {
    return { ...base, status: 'host', provider: null, model: null, id: null, family: null, value: 'host', source: { kind: 'default', path: null } };
  }
  const parsed = parseAgentModel(winner.value!);
  if (!parsed) throw invalid(winner.value!, winner.kind === 'request' ? 'this request' : winner.path ?? winner.kind, winner.repair);
  const source = { kind: winner.kind, path: winner.path };
  if (parsed.kind === 'host') return { ...base, status: 'host', provider: null, model: null, id: null, family: null, value: 'host', source };
  return { ...base, status: 'selected', provider: parsed.provider, model: parsed.model, id: `${parsed.provider}/${parsed.model}`, family: parsed.family, value: winner.value!.trim(), source };
}

export function renderAgentModel(s: AgentModelSelection): string[] {
  const from = s.source.kind === 'default' ? 'no preference set'
    : s.source.kind === 'request' ? 'requested for this job, not saved'
      : `from agent_model in ${s.source.path}, ${s.source.kind === 'config' ? 'this machine' : 'the preferences file'}`;
  const lines = [s.status === 'host'
    ? `agent: host - keep the running agent's own model and omit the model field (${from})`
    : `agent: ${s.id}${s.family ? ` (${s.family})` : ''} - ${from}`].map(printable);
  lines.push(printable(`  config.yaml agent_model: ${s.sources.config ?? 'unset'}; preferences agent_model: ${s.sources.preferences ?? 'unset'}${s.sources.preferencesPath ? ` (${s.sources.preferencesPath})` : ' (GSTACK_PREFERENCES_FILE unset)'}`));
  lines.push(`  exempt: ${s.exemptions.join('; ')}`);
  lines.push('  change it on this machine: gstack-config set agent_model <host|family|provider/model>; keep it across Capy machines: agent_model in the skill folder\'s preferences.yaml');
  for (const w of s.warnings) lines.push(`  warning: ${sanitize(w)}`);
  return lines;
}
