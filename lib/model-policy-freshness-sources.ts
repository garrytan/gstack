import { createHash } from 'node:crypto';
import { marked, type Tokens } from 'marked';

export const FRESHNESS_SOURCES = [
  { id: 'anthropic-models', url: 'https://platform.claude.com/docs/en/models/overview.md' },
  { id: 'anthropic-lifecycle', url: 'https://platform.claude.com/docs/en/about-claude/model-deprecations.md' },
  { id: 'openai-models', url: 'https://developers.openai.com/api/docs/models.md' },
  { id: 'openai-lifecycle', url: 'https://developers.openai.com/api/docs/deprecations.md' },
] as const;
export type SourceId = typeof FRESHNESS_SOURCES[number]['id'];
export const FRESHNESS_BOUNDS = { responseMs: 30_000, responseBytes: 2 * 1024 * 1024, redirects: 3, checkMs: 180_000, publicationMs: 60_000, issueBytes: 60_000 } as const;
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type LifecycleRow = { modelId: string; state: 'active' | 'legacy' | 'deprecated' | 'removed'; deadline: string | null; supportFloor: string | null };
export type ParsedSource = { recommendations?: { frontier: string; smart: string }; lineup?: string[]; lifecycle?: LifecycleRow[] };
export type SourceReceipt = { id: SourceId; url: string; finalUrl: string; sha256: string; bytes: number; parsed: ParsedSource };
export type SourceResult = { id: SourceId; receipt: SourceReceipt; error?: never } | { id: SourceId; error: string; receipt?: never };
export const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

export async function withinDeadline<T>(task: Promise<T>, milliseconds: number, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller?.abort(); reject(new Error('deadline-exceeded')); }, milliseconds);
  });
  try { return await Promise.race([task, expiry]); } finally { clearTimeout(timer!); }
}

function allowedUrl(value: string): boolean {
  return FRESHNESS_SOURCES.some(source => source.url === value)
    || value === 'https://developers.openai.com/api/docs/deprecations';
}

export async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > FRESHNESS_BOUNDS.responseBytes) {
    await response.body?.cancel(); throw new Error('response-too-large');
  }
  if (!response.body) throw new Error('empty-response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > FRESHNESS_BOUNDS.responseBytes) throw new Error('response-too-large');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data;
}

export async function fetchOfficialSource(id: SourceId, fetcher: Fetcher = fetch, parentSignal?: AbortSignal): Promise<{ text: string; finalUrl: string; bytes: number }> {
  const source = FRESHNESS_SOURCES.find(source => source.id === id)!;
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const task = async () => {
    let url: string = source.url;
    for (let redirects = 0; ; redirects++) {
      if (!allowedUrl(url)) throw new Error('redirect-not-allowlisted');
      const response = await fetcher(url, { redirect: 'manual', signal, headers: { Accept: 'text/markdown, text/plain' } });
      if (response.status >= 300 && response.status <= 399) {
        await response.body?.cancel();
        if (redirects >= FRESHNESS_BOUNDS.redirects) throw new Error('redirect-limit');
        const location = response.headers.get('location');
        if (!location) throw new Error('redirect-without-location');
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`http-${response.status}`); }
      const data = await readBoundedResponse(response);
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), finalUrl: url, bytes: data.length };
    }
  };
  return withinDeadline(task(), FRESHNESS_BOUNDS.responseMs, controller);
}

function section(text: string, title: string): string {
  const tokens = marked.lexer(text);
  if (tokens.filter(token => token.type === 'heading' && token.text === title).length !== 1) throw new Error(`missing-or-ambiguous-section:${title}`);
  const start = tokens.findIndex(token => token.type === 'heading' && token.text === title);
  if (start < 0) throw new Error(`missing-section:${title}`);
  const heading = tokens[start] as { depth: number };
  const end = tokens.findIndex((token, index) => index > start && token.type === 'heading' && token.depth <= heading.depth);
  return tokens.slice(start + 1, end < 0 ? undefined : end).map(token => token.raw).join('');
}

function tables(text: string): string[][][] {
  return marked.lexer(text).flatMap(token => {
    if (token.type !== 'table') return [];
    const table = token as Tokens.Table;
    return [[table.header.map(cell => cell.text), ...table.rows.map(row => row.map(cell => cell.text))]];
  });
}

function modelId(text: string): string {
  const id = text.replace(/^`|`$/g, '').trim();
  if (!/^[a-z][a-z0-9.-]{0,119}$/.test(id)) throw new Error('invalid-model-id');
  return id;
}

export function lifecycleDate(value: string): string | null {
  if (/^(N\/A|To be announced|-)$/i.test(value.trim())) return null;
  const normalized = value.trim().replace(/\p{Dash_Punctuation}/gu, '-');
  if (/^\d{4}-\d\d-\d\d$/.test(normalized)) {
    const date = new Date(`${normalized}T00:00:00.000Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== normalized) throw new Error('malformed-lifecycle-date');
    return normalized;
  }
  const match = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) (\d{1,2}), (\d{4})$/.exec(value.trim());
  if (!match) throw new Error('malformed-lifecycle-date');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1].slice(0, 3));
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== Number(match[2])) throw new Error('malformed-lifecycle-date');
  return date.toISOString().slice(0, 10);
}

function anthropicModels(text: string): ParsedSource {
  const compare = section(text, 'Compare models');
  const table = tables(compare).find(table => table[0][0] === 'Feature');
  if (!table || table[0].length < 3) throw new Error('missing-comparison-table');
  const ids = table.find(row => row[0] === 'Claude API ID')?.slice(1).map(modelId);
  const pages = table.find(row => row[0] === 'Model page')?.slice(1);
  if (!ids || !pages || ids.length !== pages.length) throw new Error('missing-api-id-row');
  if (new Set(ids).size !== ids.length || !pages.every(page => /\]\(https:\/\/platform\.claude\.com\/docs\/en\/models\/[a-z0-9-]+\/overview\)/.test(page))) throw new Error('ambiguous-comparison-models');
  const prose = marked.lexer(compare).filter(token => token.type === 'paragraph').map(token => token.raw).join('\n');
  const smartLinks = [...prose.matchAll(/start with \[[^\]]+\]\(([^)]+)\) for most workloads/gi)];
  const frontierLinks = [...prose.matchAll(/Use \[[^\]]+\]\(([^)]+)\) for demanding reasoning/gi)];
  if (smartLinks.length !== 1 || frontierLinks.length !== 1) throw new Error('unrecognized-recommendation-structure');
  const smart = smartLinks[0][1];
  const frontier = frontierLinks[0][1];
  const resolve = (url?: string): string => {
    const index = pages.findIndex(page => /\]\(([^)]+)\)/.exec(page)?.[1] === url);
    if (!url || index < 0) throw new Error('unrecognized-recommendation-structure');
    return ids[index];
  };
  return { recommendations: { frontier: resolve(frontier), smart: resolve(smart) }, lineup: ids };
}

function openaiModels(text: string): ParsedSource {
  const featured = section(text, 'Featured models');
  const links = [...featured.matchAll(/^- \[[^\]]+\]\(\/api\/docs\/models\/([a-z0-9.-]+)\.md\): (.+)$/gm)];
  const choose = (pattern: RegExp): string => {
    const found = links.filter(link => pattern.test(link[2]));
    if (found.length !== 1) throw new Error('unrecognized-recommendation-structure');
    return modelId(found[0][1]);
  };
  const catalog = section(text, 'Browse our full catalog of models');
  const lineup = [...catalog.matchAll(/^- \[[^\]]+\]\(\/api\/docs\/models\/([a-z0-9.-]+)\.md\): /gm)].map(match => modelId(match[1]));
  if (!lineup.length) throw new Error('missing-model-catalog');
  const recommendations = { frontier: choose(/^Start here for complex reasoning and coding\.$/i), smart: choose(/^Balance intelligence and cost\.$/i) };
  if (!Object.values(recommendations).every(id => lineup.includes(id))) throw new Error('recommendation-not-in-catalog');
  return { recommendations, lineup };
}

function anthropicLifecycle(text: string): ParsedSource {
  const table = tables(section(text, 'Model status')).find(table => table[0][0] === 'API model name');
  if (!table || table[0].join('|') !== 'API model name|Current state|Deprecated|Tentative retirement date' || table.length < 2) throw new Error('missing-lifecycle-table');
  const lifecycle = table.slice(1).map(row => {
    const states: Record<string, LifecycleRow['state']> = { Active: 'active', Legacy: 'legacy', Deprecated: 'deprecated', Retired: 'removed' };
    const state = states[row[1]];
    if (!state || row.length !== 4) throw new Error('unrecognized-lifecycle-state');
    lifecycleDate(row[2]);
    const floor = row[3].startsWith('Not sooner than ');
    const date = lifecycleDate(row[3].replace(/^Not sooner than /, ''));
    if (floor && (state === 'deprecated' || state === 'removed')) throw new Error('contradictory-lifecycle-floor');
    return { modelId: modelId(row[0]), state, deadline: floor ? null : date, supportFloor: floor ? date : null };
  });
  return { lifecycle };
}

function openaiLifecycle(text: string): ParsedSource {
  const upcoming = section(text, 'Upcoming deprecations');
  const allTables = tables(text);
  const modelTables = allTables.filter(table => table[0][0] === 'Shutdown date' && /^(?:Model (?:\/ system|family \/ snapshot|snapshot)|Deprecated model|Legacy model)$/.test(table[0][1]));
  if (!upcoming || !modelTables.length) throw new Error('missing-deprecation-tables');
  const lifecycle = modelTables.flatMap(table => table.slice(1).flatMap(row => {
    if (/^(?:Videos API|Assistants API|OpenAI-Beta: |New fine-tuning training on )/.test(row[1]) || row[1].startsWith('`/')) return [];
    if (!row[1].startsWith('`')) throw new Error('unrecognized-deprecated-model-cell');
    const floor = row[0].startsWith('at earliest ');
    const date = lifecycleDate(row[0].replace(/^at earliest /, ''));
    if (!date) throw new Error('missing-shutdown-date');
    const ids = [...row[1].matchAll(/`([a-z0-9.-]+)`/g)].map(match => modelId(match[1]));
    if (!ids.length) throw new Error('unrecognized-deprecated-model-cell');
    return ids.map(modelId => ({ modelId, state: 'deprecated' as const, deadline: floor ? null : date, supportFloor: floor ? date : null }));
  }));
  return { lifecycle };
}

export function parseOfficialSource(id: SourceId, text: string): ParsedSource {
  if (new TextEncoder().encode(text).length > FRESHNESS_BOUNDS.responseBytes) throw new Error('response-too-large');
  const parsers = { 'anthropic-models': anthropicModels, 'anthropic-lifecycle': anthropicLifecycle, 'openai-models': openaiModels, 'openai-lifecycle': openaiLifecycle };
  return parsers[id](text);
}

export function parseOfficialSourceBounded(id: SourceId, text: string, signal: AbortSignal, createWorker: () => Worker = () => new Worker(new URL('./model-policy-freshness-parser-worker.ts', import.meta.url).href)): Promise<ParsedSource> {
  if (signal.aborted) return Promise.reject(new Error('deadline-exceeded'));
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    const cleanup = () => { signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new Error('deadline-exceeded')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; parsed: ParsedSource; error: string }>) => {
      cleanup();
      if (event.data.ok) resolve(event.data.parsed); else reject(new Error(event.data.error));
    };
    worker.onerror = () => { cleanup(); reject(new Error('parser-worker-unavailable')); };
    try { worker.postMessage({ id, text }); } catch { cleanup(); reject(new Error('parser-worker-unavailable')); }
  });
}

export async function collectFreshnessSources(fetcher: Fetcher = fetch, createWorker?: () => Worker): Promise<SourceResult[]> {
  const controller = new AbortController();
  const completed: Partial<Record<SourceId, SourceResult>> = {};
  const tasks = Promise.all(FRESHNESS_SOURCES.map(async source => {
    let result: SourceResult;
    try {
      const fetched = await fetchOfficialSource(source.id, fetcher, controller.signal);
      const parsed = await parseOfficialSourceBounded(source.id, fetched.text, controller.signal, createWorker);
      result = { id: source.id, receipt: { id: source.id, url: source.url, finalUrl: fetched.finalUrl, sha256: sha256(fetched.text), bytes: fetched.bytes, parsed } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'source-unavailable';
      result = { id: source.id, error: /^[a-z0-9: /.-]{1,160}$/i.test(reason) ? reason : 'source-unavailable' };
    }
    completed[source.id] = result;
    return result;
  }));
  try { return await withinDeadline(tasks, FRESHNESS_BOUNDS.checkMs, controller); }
  catch { return FRESHNESS_SOURCES.map(source => completed[source.id] ?? { id: source.id, error: 'complete-check-deadline-exceeded' }); }
}
