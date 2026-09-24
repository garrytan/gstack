import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { generateCompareHtml } from '../design/src/compare';

const root = path.resolve(import.meta.dir, '..');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'design-consult-contract-'));
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  const scratch = path.join(dir, 'scratch');
  for (const sub of [repo, bin, scratch]) mkdirSync(sub);
  const calls = path.join(dir, 'calls');
  const preload = path.join(dir, 'offline.ts');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  const pathname = new URL(String(url)).pathname;
  if (!['/v1/responses', '/v1/chat/completions'].includes(pathname)) throw new Error('Unexpected request');
  appendFileSync(process.env.CALLS!, pathname + '\\n');
  if (process.env.MODE === 'unavailable') return new Response('unavailable', { status: 503 });
  if (pathname === '/v1/responses') return Response.json({ id: 'fixture-response', output: [{ type: 'image_generation_call', result: 'aW1hZ2U=' }] });
  const content = process.env.MODE === 'check' ? 'FAIL: illegible title' : JSON.stringify({ colors: [{ name: 'accent', hex: '#123456', usage: 'action' }], typography: [], spacing: ['8px'], layout: ['columns'], mood: 'calm' });
  return Response.json({ choices: [{ message: { content } }] });
};
`);
  const image = path.join(repo, 'approved.png');
  writeFileSync(image, 'fixture image');
  const design = path.join(bin, 'design');
  writeFileSync(design, `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file --preload ${quote(preload)} ${quote(path.join(root, 'design/src/cli.ts'))} "$@"\n`, { mode: 0o700 });
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$GIT_CLAIM_ALL" = 1 ] || [ "$PWD" = "$FIXTURE_REPO" ]; then printf '%s\\n' "$FIXTURE_REPO"; else exit 128; fi
`, { mode: 0o700 });
  writeFileSync(path.join(bin, 'mktemp'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_SCRATCH"\n', { mode: 0o700 });
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: dir, GSTACK_HOME: path.join(dir, 'state'),
    OPENAI_API_KEY: 'fixture-not-a-real-key', CALLS: calls, FIXTURE_REPO: repo, FIXTURE_SCRATCH: scratch,
    D: design, APPROVED_IMAGE: image,
  };
  const sessions: string[] = [];
  const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(design, args, {
    cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15_000,
  });
  return { dir, repo, env, image, calls, run, sessions, cleanup: () => {
    for (const session of sessions) rmSync(session, { force: true });
    rmSync(dir, { recursive: true, force: true });
  } };
}

test('actual CLI variants have no session; generation supplies the session required by iteration', () => {
  const f = fixture();
  try {
    const variants = f.run(['variants', '--brief', 'Readable civic dashboard', '--count', '1', '--output-dir', f.dir]);
    expect(variants.status, variants.stderr).toBe(0);
    const variantResult = JSON.parse(variants.stdout);
    expect(variantResult.paths).toEqual([path.join(f.dir, 'variant-A.png')]);
    expect(variantResult).not.toHaveProperty('sessionFile');
    const callCount = readFileSync(f.calls, 'utf8').split('\n').length;
    const missing = f.run(['iterate', '--feedback', 'Larger title', '--output', path.join(f.dir, 'missing.png')]);
    expect(missing.status).not.toBe(0);
    expect(readFileSync(f.calls, 'utf8').split('\n')).toHaveLength(callCount);
    const generated = f.run(['generate', '--brief', 'Readable civic dashboard', '--output', f.image]);
    expect(generated.status, generated.stderr).toBe(0);
    const { sessionFile } = JSON.parse(generated.stdout);
    f.sessions.push(sessionFile);
    expect(existsSync(sessionFile)).toBe(true);
    const iterated = f.run(['iterate', '--session', sessionFile, '--feedback', 'Larger title', '--output', path.join(f.dir, 'refined.png')]);
    expect(iterated.status, iterated.stderr).toBe(0);
    expect(JSON.parse(iterated.stdout).sessionFile).toBe(sessionFile);
    expect(JSON.parse(readFileSync(sessionFile, 'utf8')).feedbackHistory).toEqual(['Larger title']);
  } finally { f.cleanup(); }
});

test('actual CLI quality check distinguishes failure from skipped coverage despite exit zero', () => {
  const f = fixture();
  try {
    const failed = f.run(['check', '--image', f.image, '--brief', 'Readable title'], { MODE: 'check' });
    expect(failed.status, failed.stderr).toBe(0);
    expect(JSON.parse(failed.stdout)).toEqual({ pass: false, issues: 'illegible title' });
    const unavailable = f.run(['check', '--image', f.image, '--brief', 'Readable title'], { MODE: 'unavailable' });
    expect(unavailable.status, unavailable.stderr).toBe(0);
    expect(JSON.parse(unavailable.stdout)).toEqual({ pass: true, issues: 'Vision check unavailable — skipped' });
  } finally { f.cleanup(); }
});

test('the extraction recipe prevents the actual CLI automatic DESIGN.md write and refuses a Git-bound scratch directory', () => {
  const f = fixture();
  try {
    const projectDesign = path.join(f.repo, 'DESIGN.md');
    const original = '# Existing design\n\nKeep this decision.\n';
    writeFileSync(projectDesign, original);
    const direct = f.run(['extract', '--image', f.image]);
    expect(direct.status, direct.stderr).toBe(0);
    expect(readFileSync(projectDesign, 'utf8')).toContain('## Extracted Design Language');
    writeFileSync(projectDesign, original);
    const section = readFileSync(path.join(root, 'design-consultation/sections/proposal-and-preview.md.tmpl'), 'utf8');
    const recipe = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].find(match => match[1].includes('_EXTRACT_DIR='))?.[1];
    expect(recipe).toBeDefined();
    const isolated = spawnSync('bash', ['-c', recipe!], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 15_000 });
    expect(isolated.status, isolated.stderr).toBe(0);
    expect(JSON.parse(isolated.stdout).colors[0].hex).toBe('#123456');
    expect(readFileSync(projectDesign, 'utf8')).toBe(original);
    const calls = readFileSync(f.calls, 'utf8');
    const refused = spawnSync('bash', ['-c', recipe!], {
      cwd: f.repo, env: { ...f.env, GIT_CLAIM_ALL: '1' }, encoding: 'utf8', timeout: 15_000,
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('Extraction refused');
    expect(readFileSync(f.calls, 'utf8')).toBe(calls);
    expect(readFileSync(projectDesign, 'utf8')).toBe(original);
  } finally { f.cleanup(); }
});

test('the actual comparison board callback emits regenerateAction without requiring remixSpec', () => {
  const f = fixture();
  try {
    const html = generateCompareHtml([f.image]);
    const callback = html.match(/  function submitRegenerate\(detail\) \{[\s\S]*?\n  \}/)?.[0];
    expect(callback).toBeDefined();
    const sent: unknown[] = [];
    const elements = { 'feedback-result': { textContent: '' }, status: { textContent: '' } };
    const invoke = runInNewContext(`${callback}\nsubmitRegenerate`, {
      document: { getElementById: (id: keyof typeof elements) => elements[id] },
      collectFeedback: () => ({ preferred: 'A', ratings: { A: 4 }, comments: {}, overall: null }),
      postFeedback: (value: unknown) => { sent.push(value); return { then: () => {} }; },
    });
    for (const action of ['different', 'match', 'more_like_A', "A's layout with B's colors"]) {
      invoke(action);
      const result = JSON.parse(elements['feedback-result'].textContent);
      expect(result).toEqual({ preferred: 'A', ratings: { A: 4 }, comments: {}, overall: null, regenerated: true, regenerateAction: action });
      expect(sent.at(-1)).toEqual(result);
      expect(result).not.toHaveProperty('remixSpec');
      expect(elements.status.textContent).toBe('regenerate');
    }
  } finally { f.cleanup(); }
});
