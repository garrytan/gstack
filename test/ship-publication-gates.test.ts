import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectMentions } from './helpers/prompt-structure';

const template = readFileSync(new URL('../ship/sections/pr-body.md.tmpl', import.meta.url), 'utf8');

/** The agent writes the body drafts with its file-write tool; the block reads them by printed name. */
function writeDrafts(root: string, top = '## Summary\n\n## Documentation', rest = '## Test plan\n- [x] bun test: pass'): (block: string) => string {
  mkdirSync(join(root, '.gstack/tmp'), { recursive: true });
  writeFileSync(join(root, '.gstack/tmp/pr-body-top.abc123'), top);
  writeFileSync(join(root, '.gstack/tmp/pr-body-rest.abc123'), rest);
  return block => block.replace('<body-top-file-name>', 'pr-body-top.abc123').replace('<body-rest-file-name>', 'pr-body-rest.abc123');
}
const POST = resolve(import.meta.dir, '../bin/gstack-post');
const fenceAfter = (marker: string) => {
  const at = template.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = template.indexOf('```bash\n', at) + 8;
  return template.slice(open, template.indexOf('\n```', open));
};
const composeBlock = template.match(/```bash\n(: "\$\{DOCS_SECTION_FILE:[\s\S]*?)\n```/)?.[1]!;
const editBlock = fenceAfter('**Existing open PR/MR**');
const createBlock = fenceAfter('**No open PR/MR:**');

/**
 * A repo whose origin is GitHub, a stub gh that records argv and stdin, and
 * the real gstack-post at the installed path the blocks call.
 */
function publicationRepo(root: string) {
  const log = join(root, 'log');
  const stubs = join(root, 'stubs');
  const bin = join(root, '.claude/skills/gstack/bin');
  for (const dir of [log, stubs, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'gitconfig'), '');
  const gitEnv = { GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
    Bun.spawnSync(['git', ...args], { cwd: root, env: { ...process.env, ...gitEnv }, timeout: 10_000 });
  }
  writeFileSync(join(bin, 'gstack-post'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(POST)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(stubs, 'gh'), `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo PRIVATE; exit 0 ;;
  "pr view") cat "${log}/title" 2>/dev/null; exit 0 ;;
esac
n=$(ls "${log}" | grep -c args)
for a in "$@"; do printf '%s\\0' "$a"; done > "${log}/$n.args"
cat > "${log}/$n.stdin"
for a in "$@"; do case "$a" in --title=*) printf '%s\\n' "\${a#--title=}" > "${log}/title" ;; esac; done
[ "$1 $2" = "pr create" ] && echo "https://github.com/o/r/pull/9"
exit 0
`, { mode: 0o755 });
  const run = (script: string) => Bun.spawnSync(['bash', '-c', script], {
    cwd: root, env: { ...process.env, ...gitEnv, HOME: root, PATH: `${stubs}:${process.env.PATH}`, DOCS_SECTION_FILE: join(root, 'section.md'), TMPDIR: root },
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  const calls = () => readdirSync(log).filter(f => f.endsWith('.args')).sort().map(f => ({
    args: readFileSync(join(log, f), 'utf8').split('\0').slice(0, -1),
    stdin: readFileSync(join(log, f.replace('.args', '.stdin')), 'utf8'),
  }));
  return { run, calls };
}

/** Compose the body with the real compose block and write the Step 18 title file. */
function composed(root: string, opts: { title?: string; top?: string } = {}) {
  const repo = publicationRepo(root);
  writeFileSync(join(root, 'section.md'), '**Status:** current — no edits.');
  const compose = repo.run(writeDrafts(root, opts.top)(composeBlock));
  expect(compose.exitCode, compose.stderr.toString()).toBe(0);
  const bodyFile = /^PR_BODY_FILE: (\S+)$/m.exec(compose.stdout.toString())![1]!;
  writeFileSync(join(root, '.gstack/tmp/pr-title.abc123'), (opts.title ?? 'v1.2.3.4 fix: publication checks') + '\n');
  const fill = (block: string) => `PR_BODY_FILE=${JSON.stringify(bodyFile)}\n` +
    block.replace('<title-file-name>', 'pr-title.abc123').replaceAll('<pr-number>', '9').replace('<base>', 'main');
  return { ...repo, bodyFile, publish: (block: string) => repo.run(fill(block)) };
}

// The posting cases drive a POSIX stub gh that gstack-post spawns; Windows CreateProcess cannot
// exec its shebang. gstack-post's argument-array and token logic run in-process on Windows in
// test/gstack-post.test.ts.
const postsThroughStubGh = (failure: string) => process.platform === 'win32' && failure === 'none';
for (const failure of ['none', 'body', 'title'] as const) {
  test.skipIf(postsThroughStubGh(failure))(`publication posts only scanned bytes through gstack-post: ${failure}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ship-post-'));
    try {
      const secret = 'AKIA' + '1234567890ABCDEF';
      const c = composed(root, {
        top: failure === 'body' ? `## Summary\nkey ${secret}\n\n## Documentation` : undefined,
        title: failure === 'title' ? `v1.2.3.4 fix: ${secret}` : undefined,
      });
      const result = c.publish(createBlock);
      if (failure === 'none') {
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain('https://github.com/o/r/pull/9');
        expect(c.calls()).toEqual([{ args: ['pr', 'create', '--base=main', '--title=v1.2.3.4 fix: publication checks', '--body-file=-'], stdin: readFileSync(c.bodyFile, 'utf8') }]);
      } else {
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toContain(`HIGH RULE: aws.access_key LINE: ${failure === 'body' ? 2 : 1} PART: ${failure}`);
        expect(c.calls()).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test.skipIf(process.platform === 'win32')('MEDIUM findings publish nothing until the block reruns with the printed token', () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-post-medium-'));
  try {
    const c = composed(root, { top: '## Summary\nThanks jane.roe@acme-corp.io\n\n## Documentation' });
    const first = c.publish(editBlock);
    expect(first.exitCode).toBe(2);
    expect(first.stdout.toString()).toContain('RULE: pii.email LINE: 2 PART: body');
    expect(c.calls()).toEqual([]);
    const token = /^TOKEN: (\S+)$/m.exec(first.stdout.toString())![1]!;
    const flagged = 'pr-body <pr-number> --body-file "${PR_BODY_FILE:?restore the composed body path}"';
    expect(editBlock).toContain(flagged);
    const then = c.publish(editBlock.replace(flagged, `${flagged} --confirm ${token}`));
    expect(then.exitCode, then.stderr.toString()).toBe(0);
    const calls = c.calls();
    expect(calls.map(call => call.args)).toEqual([
      ['pr', 'edit', '9', '--body-file=-'],
      ['pr', 'edit', '9', '--title=v1.2.3.4 fix: publication checks'],
    ]);
    expect(calls[0]!.stdin).toBe(readFileSync(c.bodyFile, 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publication composes the saved documentation section unchanged and refuses to compose without it', () => {
  const block = composeBlock;
  const compose = block.slice(block.indexOf('PR_BODY_FILE=$(mktemp'), block.indexOf('echo "PR_BODY_FILE:'));
  const root = mkdtempSync(join(tmpdir(), 'ship-compose-'));
  try {
    const section = '**Status:** current — no edits.\n\n- Diagram drift: none (no diagrams in any doc).';
    writeFileSync(join(root, 'section.md'), section);
    const run = (file: string) => Bun.spawnSync(['bash', '-c', `${writeDrafts(root)(compose)}cat -- "$PR_BODY_FILE"`], {
      cwd: root, env: { ...process.env, HOME: root, DOCS_SECTION_FILE: file }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    const composed = run(join(root, 'section.md'));
    expect(composed.exitCode).toBe(0);
    expect(composed.stdout.toString()).toBe(`## Summary\n\n## Documentation\n${section}\n## Test plan\n- [x] bun test: pass\n`);
    expect(existsSync(join(root, '.gstack/tmp/pr-body-top.abc123'))).toBe(false);
    expect(existsSync(join(root, '.gstack/tmp/pr-body-rest.abc123'))).toBe(false);
    const missing = run(join(root, 'absent.md'));
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout.toString()).toBe('');
    rmSync(join(root, '.gstack/tmp'), { recursive: true, force: true });
    const unwritten = Bun.spawnSync(['bash', '-c', `${compose.replace('<body-top-file-name>', 'never-written').replace('<body-rest-file-name>', 'never-written')}cat -- "$PR_BODY_FILE"`], {
      cwd: root, env: { ...process.env, HOME: root, DOCS_SECTION_FILE: join(root, 'section.md') }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    expect(unwritten.exitCode).toBe(1);
    expect(unwritten.stdout.toString()).toBe('');
    expect(unwritten.stderr.toString()).toContain('the body was never written');
    const unset = Bun.spawnSync(['bash', '-c', block], {
      cwd: root, env: { ...process.env, HOME: root, DOCS_SECTION_FILE: '' },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    expect(unset.exitCode).not.toBe(0);
    expect(unset.stderr.toString()).toContain('Restore the saved Step 14.5 section file path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publication reports unavailable triage separately from an empty successful fetch', () => {
  const section = template.slice(template.indexOf('## Greptile Review'), template.indexOf('## Scope Drift'));
  expect(section).toContain('Greptile triage: UNAVAILABLE (dispatch failed)');
  expect(section).toContain('actual reason');
  expect(section).toContain('complete');
  expect(section).toContain('no_pr');
});

test('publication refreshes the open review and title without treating lookup failure as absence', () => {
  const lookup = template.slice(0, template.indexOf('### Resolve Linked Spec'));
  expect(lookup.replace(/\s+/g, ' ')).toContain('Errors or ambiguous matches STOP publication');
  expectMentions(lookup.replace(/\s+/g, ' '), [['fresh body', 'before', 'publishing']], 'lookup.replace(/\s+/g,  )');
  expect(lookup).not.toContain('Ship control flow');
  expect(lookup).not.toContain('|| echo "NO_PR"');
  expect(lookup).not.toContain('|| echo "NO_MR"');
  expectMentions(template, [['blocks', 'error', 'exit']], 'template');
  expect(template).toContain('public-strict policy');
});
