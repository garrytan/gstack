/**
 * B1 static coverage: every rendered fence that runs `codex exec` or
 * `codex review` as a command routes the result through the shared validator
 * (lib/outside-review-result.ts) later in the same fence, and takes its
 * sandbox from `_GSTACK_CODEX_SANDBOX` (read-only unless GSTACK_CODEX_NO_SANDBOX=1);
 * every `codex exec` reads its prompt on stdin (E5).
 * Prose mentions of the commands are ignored: only command positions count.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sites-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** `codex exec|review` at the start of a shell command, optionally behind the timeout wrapper. */
const COMMAND = /(?:^|[;&|]\s*|\$\(\s*)(?:_gstack_codex_timeout_wrapper\s+\d+\s+)?codex\s+(?:exec|review)\b/;
const VALIDATOR = /outside-review-result\.ts\b/;

interface Site { file: string; line: string; fence: string; after: string }

function codexSites(markdown: string, file: string): Site[] {
  const sites: Site[] = [];
  for (const match of markdown.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const fence = match[1]!;
    const lines = fence.split('\n');
    lines.forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('#') || !COMMAND.test(code)) return;
      sites.push({ file, line: code, fence, after: lines.slice(i + 1).join('\n') });
    });
  }
  return sites;
}

function render(host: string): string[] {
  const out = path.join(TMP, host);
  const r = spawnSync('bun', ['run', 'scripts/gen-skill-docs.ts', '--host', host, '--out-dir', out], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`render ${host} failed: ${r.stderr}`);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) files.push(p);
    }
  };
  walk(out);
  return files;
}

describe('every rendered Codex invocation is classified by the shared validator', () => {
  const rendered = Object.fromEntries(['claude', 'codex'].map(host => [host, render(host).flatMap(f => codexSites(fs.readFileSync(f, 'utf8'), path.relative(TMP, f).split(path.sep).join('/')))]));

  test('the Claude render has the expected invocation sites', () => {
    const files = new Set(rendered.claude!.map(s => s.file.replace(/^claude\//, '')));
    for (const expected of ['codex/sections/review-mode.md', 'codex/sections/challenge-mode.md', 'codex/sections/consult-mode.md',
      'review/sections/adversarial.md', 'ship/sections/adversarial.md']) expect(files.has(expected)).toBe(true);
  });

  for (const host of ['claude', 'codex']) {
    test(`${host}: each codex exec/review command is followed by the validator in its fence`, () => {
      const missing = rendered[host]!.filter(site => !VALIDATOR.test(site.after)).map(s => `${s.file}: ${s.line}`);
      expect(missing).toEqual([]);
    });

    test(`${host}: E5 every codex exec reads its prompt on stdin, never argv`, () => {
      const argv = rendered[host]!.filter(site => /codex\s+exec\b/.test(site.line))
        .filter(site => !/codex\s+exec\s+(?:resume\s+\S+\s+)?-\s/.test(site.line) || /<\s*\/dev\/null/.test(site.line))
        .map(s => `${s.file}: ${s.line}`);
      expect(argv).toEqual([]);
    });

    test(`${host}: each codex exec/review command takes its sandbox from _GSTACK_CODEX_SANDBOX`, () => {
      const literal = rendered[host]!.filter(site => !site.line.includes('${_GSTACK_CODEX_SANDBOX:?}')).map(s => `${s.file}: ${s.line}`);
      expect(literal).toEqual([]);
    });
  }

  test('negative controls: prose is ignored, an unvalidated or literal-sandbox command is flagged', () => {
    const doc = [
      'Run `codex review` to review.',
      '```bash',
      '# codex exec in a comment',
      'echo "use codex exec later"',
      '_gstack_codex_timeout_wrapper 30 codex exec "x" -s read-only',
      '```',
    ].join('\n');
    const sites = codexSites(doc, 'planted.md');
    expect(sites.map(s => s.line)).toEqual(['_gstack_codex_timeout_wrapper 30 codex exec "x" -s read-only']);
    expect(VALIDATOR.test(sites[0]!.after)).toBe(false);
    expect(sites[0]!.line.includes('${_GSTACK_CODEX_SANDBOX:?}')).toBe(false);
    expect(codexSites('```bash\nX=$(codex exec "y")\n```', 'p.md')).toHaveLength(1);
  });
});
