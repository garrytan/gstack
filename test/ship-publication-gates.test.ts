import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { killGroup } from '../lib/pregate/supervise';
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
const PROSE_LINT = resolve(import.meta.dir, '../bin/gstack-prose-lint');

/** The two real bins the blocks call, at the installed path under a HOME of `root`. */
function installBins(root: string): void {
  const bin = join(root, '.claude/skills/gstack/bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, target] of [['gstack-post', POST], ['gstack-prose-lint', PROSE_LINT]] as const) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(target)} "$@"\n`, { mode: 0o755 });
  }
}
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
 * One deadline per case, under the runner's 30s per-test timeout. On Windows Free
 * Tests the first posting case in the file took 2.4-25.2s (40 runs) and four times
 * hit bun's timeout, which killed only the bash child: its descendants kept the root
 * as their working directory, so cleanup failed with EBUSY and hid the timeout. A
 * block still running at the deadline is killed with its whole tree, and the error
 * names the stage and what the earlier stages took.
 */
const CASE_DEADLINE_MS = 27_000;

/**
 * A repo whose origin is GitHub, a stub gh that records argv and stdin, and
 * the real gstack-post and gstack-prose-lint at the installed path the blocks call.
 */
function publicationRepo(root: string, deadlineMs = CASE_DEADLINE_MS) {
  const started = performance.now();
  const deadline = started + deadlineMs;
  const log = join(root, 'log');
  const stubs = join(root, 'stubs');
  const bin = join(root, '.claude/skills/gstack/bin');
  for (const dir of [log, stubs, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'gitconfig'), '');
  const gitEnv = { GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/o/r.git']]) {
    Bun.spawnSync(['git', ...args], { cwd: root, env: { ...process.env, ...gitEnv }, timeout: 10_000 });
  }
  installBins(root);
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
  const stages = [`setup ${Math.round(performance.now() - started)}ms`];
  const run = async (stage: string, script: string) => {
    const stageStart = performance.now();
    const child = Bun.spawn(['bash', '-c', script], {
      cwd: root, env: { ...process.env, ...gitEnv, HOME: root, PATH: `${stubs}:${process.env.PATH}`, DOCS_SECTION_FILE: join(root, 'section.md'), TMPDIR: root },
      stdout: 'pipe', stderr: 'pipe', detached: process.platform !== 'win32',
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const finished = Promise.all([child.exited, output]);
    const expired = await Promise.race([finished.then(() => false), Bun.sleep(Math.max(0, deadline - performance.now())).then(() => true)]);
    if (expired) {
      killGroup(child.pid, 'SIGKILL');
      await child.exited;
      throw new Error(`${stage} still running at the ${deadlineMs}ms case deadline after ${Math.round(performance.now() - stageStart)}ms; process tree killed; earlier stages: ${stages.join(', ')}`);
    }
    stages.push(`${stage} ${Math.round(performance.now() - stageStart)}ms`);
    const [stdout, stderr] = await output;
    return { exitCode: child.exitCode, stdout, stderr };
  };
  const calls = () => readdirSync(log).filter(f => f.endsWith('.args')).sort().map(f => ({
    args: readFileSync(join(log, f), 'utf8').split('\0').slice(0, -1),
    stdin: readFileSync(join(log, f.replace('.args', '.stdin')), 'utf8'),
  }));
  return { run, calls };
}

/** Compose the body with the real compose block and write the Step 18 title file. */
async function composed(root: string, opts: { title?: string; top?: string } = {}) {
  const repo = publicationRepo(root);
  writeFileSync(join(root, 'section.md'), '**Status:** current — no edits.');
  const compose = await repo.run('compose', writeDrafts(root, opts.top)(composeBlock));
  expect(compose.exitCode, compose.stderr.toString()).toBe(0);
  const bodyFile = /^PR_BODY_FILE: (\S+)$/m.exec(compose.stdout.toString())![1]!;
  writeFileSync(join(root, '.gstack/tmp/pr-title.abc123'), (opts.title ?? 'v1.2.3.4 fix: publication checks') + '\n');
  const fill = (block: string) => `PR_BODY_FILE=${JSON.stringify(bodyFile)}\n` +
    block.replace('<title-file-name>', 'pr-title.abc123').replaceAll('<pr-number>', '9').replace('<base>', 'main');
  return { ...repo, bodyFile, publish: (block: string) => repo.run('publish', fill(block)) };
}

// The posting cases drive a POSIX stub gh that gstack-post spawns; Windows CreateProcess cannot
// exec its shebang. gstack-post's argument-array and token logic run in-process on Windows in
// test/gstack-post.test.ts.
const postsThroughStubGh = (failure: string) => process.platform === 'win32' && failure === 'none';
for (const failure of ['none', 'body', 'title'] as const) {
  test.skipIf(postsThroughStubGh(failure))(`publication posts only scanned bytes through gstack-post: ${failure}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ship-post-'));
    try {
      const secret = 'AKIA' + '1234567890ABCDEF';
      const c = await composed(root, {
        top: failure === 'body' ? `## Summary\nkey ${secret}\n\n## Documentation` : undefined,
        title: failure === 'title' ? `v1.2.3.4 fix: ${secret}` : undefined,
      });
      const result = await c.publish(createBlock);
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

/** True when the pid is gone within a second of the kill. */
async function exitsSoon(pid: number) {
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); await Bun.sleep(20); } catch { return true; }
  }
  return false;
}

test('a block still running at the case deadline is killed with its whole tree before cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-post-deadline-'));
  try {
    const pidFile = join(root, 'holder.pid');
    const repo = publicationRepo(root, 1_500);
    await expect(repo.run('publish', `sh -c 'echo $$ > "${pidFile}"; exec sleep 30'\necho unreachable`))
      .rejects.toThrow(/^publish still running at the 1500ms case deadline after \d+ms; process tree killed; earlier stages: setup \d+ms$/);
    if (process.platform !== 'win32') expect(await exitsSoon(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A block that exits while a background child still holds its output is still running: the deadline covers
// the pipes too, not only bash's exit. POSIX only: on Windows the exited bash leaves no tree for taskkill /T.
test.skipIf(process.platform === 'win32')('a block whose background child holds its output past the deadline is killed too', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-post-pipe-'));
  try {
    const pidFile = join(root, 'holder.pid');
    const repo = publicationRepo(root, 1_500);
    await expect(repo.run('publish', `sleep 30 &\necho $! > "${pidFile}"`))
      .rejects.toThrow(/^publish still running at the 1500ms case deadline after \d+ms; process tree killed; earlier stages: setup \d+ms$/);
    expect(await exitsSoon(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('MEDIUM findings publish nothing until the block reruns with the printed token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-post-medium-'));
  try {
    const c = await composed(root, { top: '## Summary\nThanks jane.roe@acme-corp.io\n\n## Documentation' });
    const first = await c.publish(editBlock);
    expect(first.exitCode).toBe(2);
    expect(first.stdout.toString()).toContain('RULE: pii.email LINE: 2 PART: body');
    expect(c.calls()).toEqual([]);
    const token = /^TOKEN: (\S+)$/m.exec(first.stdout.toString())![1]!;
    const flagged = 'pr-body <pr-number> --body-file "${PR_BODY_FILE:?restore the composed body path}"';
    expect(editBlock).toContain(flagged);
    const then = await c.publish(editBlock.replace(flagged, `${flagged} --confirm ${token}`));
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
    installBins(root);
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
