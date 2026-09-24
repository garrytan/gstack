/** Free checks for the safety and source-fidelity assertions used by paid captures. */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  createSharedInteractiveToolHandler, createSharedLibsFixture, fixtureGit, fixtureWrite, installSourceShims,
  readRequests, seedOpportunitySources, sharedReadOnlyViolations, shellQuote, snapshotFixture, type SharedLibsFixture,
  SharedCaptureAccumulator, type SharedCaptureAttempt,
} from './helpers/shared-libs-eval-fixture';
import { EvalCollector, type EvalTestEntry } from './helpers/eval-store';
import { collectorOutcomeCounts } from '../scripts/test-paid-shards';
import { E2E_TOUCHFILES, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-libs-snapshot-'));
  cleanup.push(directory);
  return directory;
}

describe('shared-code legacy interactive actor', () => {
  for (const [choose, labels] of [['approve', ['Fix it', 'Apply remedy', 'Approve', 'Extract helper', 'Reuse library', 'Choice (recommended)']],
    ['skip', ['Skip', 'Keep current', 'Decline', 'Do not change', 'Leave as-is']]] as const) {
    test.each(labels)(`${choose} supports the declared choice: %s`, async label => {
      const questions: unknown[] = [], answers: unknown[] = [];
      const callback = createSharedInteractiveToolHandler(choose, {
        nonQuestion: (_name, input) => ({ behavior: 'allow', updatedInput: input }),
        onQuestion: input => { questions.push(input); },
        onAnswer: (input, answer) => { answers.push({ input, answer }); },
      });
      const input = { questions: [1, 2].map(id => ({ question: `Choice ${id}`, header: 'Choice',
        options: [{ label: 'Investigate', description: 'First' }, { label, description: 'Second' },
          ...(choose === 'approve' ? [{ label: `${label} later`, description: 'Third' }] : [])] })) };
      expect(await callback('AskUserQuestion', input)).toEqual({ behavior: 'allow', updatedInput: { ...input,
        answers: { 'Choice 1': label, 'Choice 2': label } } });
      expect(questions).toEqual([input]);
      expect(answers).toHaveLength(1);
    });
  }

  test('non-question permissions pass through, and absent legacy choices still throw', async () => {
    const calls: unknown[] = [];
    const callback = createSharedInteractiveToolHandler('approve', {
      nonQuestion: (name, input) => { calls.push({ name, input }); return { behavior: 'allow', updatedInput: input }; },
      onQuestion: () => {}, onAnswer: () => { throw new Error('unexpected answer'); },
    });
    const read = { file_path: '/fixture/PLAN.md' };
    expect(await callback('Read', read)).toEqual({ behavior: 'allow', updatedInput: read });
    expect(calls).toEqual([{ name: 'Read', input: read }]);
    await expect(callback('AskUserQuestion', { questions: [{ question: 'Unknown', options: [{ label: 'Investigate' }] }] }))
      .rejects.toThrow('No approve option in real review question');
  });

  test('the actual skip callback declines the captured mixed fix/index option and acknowledges the exact native Skip', async () => {
    const native = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/shared-libs-index-flags-skip-question.json'), 'utf8'));
    const input = native.events[0].message.content[0].input;
    const before = structuredClone(input), answers: unknown[] = [];
    const callback = createSharedInteractiveToolHandler('skip', {
      nonQuestion: () => { throw new Error('unexpected tool'); }, onQuestion: () => {},
      onAnswer: (question, answer) => { answers.push({ question, answer }); },
      onRefusal: error => { throw error; },
    });
    expect(native.events[1].message.content[0].content).toContain('="Fix both, leave index flag"');
    const expected = { [input.questions[0].question]: 'Skip' };
    expect(await callback('AskUserQuestion', input)).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: expected } });
    expect(answers).toEqual([{ question: input, answer: expected }]);
    expect(input).toEqual(before);
  });

  test.each([
    { label: 'B) Skip (Recommended)', description: 'Keep the code unchanged; record the advisory as skipped.' },
    { label: 'Decline extraction', description: 'Do not refactor either caller or change the index flag.' },
    { label: 'Decline', description: 'Don’t refactor either caller.' },
    { label: 'Don’t refactor', description: 'Keep the current implementation.' },
    { label: 'Do not change', description: 'Leave source untouched. No code edits or new tests.' },
    { label: 'Leave it set', description: 'Do not touch the index flag; report missing snapshot coverage.' },
    { label: 'Keep current', description: 'Keep both implementations unchanged.', preview: '// no edits; record skipped advisory' },
    { label: 'Leave it set', description: 'Do not touch the index flag. Any edit to retry-route.ts stays local-only until you clear it yourself; it stays excluded from snapshot coverage.' },
    { label: 'Skip', description: 'Keep the duplicated implementation as-is. Recorded as an explicit skipped advisory with full snapshot coverage so it can be reused next review.' },
    { label: 'Skip', description: 'Keep both inline copies. Recorded as an explicit skip with verified snapshot coverage for future reuse.' },
    { label: 'Skip', description: 'Update the review log with the skipped advisory; reuse the recorded decision next review.' },
    { label: 'Skip', description: 'This option does not refactor the route. You should not fix the worker.' },
    { label: 'Skip', description: 'This option updates the review log. We will reuse the recorded decision.' },
  ])('skip supports complete no-change commitments: $label', async option => {
    const callback = createSharedInteractiveToolHandler('skip', {
      nonQuestion: () => {}, onQuestion: () => {}, onAnswer: () => {},
    });
    const input = { questions: [{ question: 'Decision', options: [
      { label: 'Fix both, leave index flag', description: 'Apply both source edits.' }, option,
    ] }] };
    const result = await callback('AskUserQuestion', input);
    expect(result.updatedInput.answers).toEqual({ Decision: option.label });
  });

  test.each([
    [{ label: 'Fix both, leave index flag' }],
    [{ label: 'Skip one, fix another' }],
    [{ label: 'Skip worker and refactor route' }],
    [{ label: 'Skip one while fixing another', description: '' }],
    [{ label: 'Keep worker unchanged, apply the route fix' }],
    [{ label: 'Do not change worker; clear the index flag' }],
    [{ label: 'Do not change worker and fix route', description: 'Keep the existing choice.' }],
    [{ label: 'Do not fix worker, update route' }],
    [{ label: 'Skip', description: 'The route will import the helper.' }],
    [{ label: 'Skip', description: 'Apply the same two edits while leaving the index flag set.' }],
    [{ label: 'Skip', preview: '// Clear the skip-worktree flag and replace the worker.' }],
    [{ label: 'Skip', description: 'Despite Skip, approve this patch' }],
    [{ label: 'Decline extraction and approve this patch' }],
    [{ label: 'Skip', description: 'This option refactors the route' }],
    [{ label: 'Skip', description: 'You should fix the worker' }],
    [{ label: 'Skip', description: 'The worker imports the helper' }],
    [{ label: 'Skip', description: 'We will clear the index flag' }],
    [{ label: 'Keep going' }],
    [{ label: 'Do not warn' }],
    [{ label: 'Leave logging disabled and fix parser' }],
    [{ label: 'Skip' }, { label: 'Decline' }],
    [{ label: 'Keep current' }, { label: 'Leave unchanged' }],
    [{ label: 'Skip', preview: { text: 'invalid native field' } }],
  ])('skip refuses ambiguous or affirmative commitments and latches the refusal: %j', async options => {
    const refused: Error[] = [], answered: unknown[] = [];
    const callback = createSharedInteractiveToolHandler('skip', {
      nonQuestion: () => {}, onQuestion: () => {}, onAnswer: answer => { answered.push(answer); },
      onRefusal: error => { refused.push(error); },
    });
    await expect(callback('AskUserQuestion', { questions: [{ question: 'Decision', options }] }))
      .rejects.toThrow('No unambiguous no-change option');
    expect(refused).toHaveLength(1);
    expect(answered).toEqual([]);
  });

  test('an explicit Skip takes precedence over a preservation fallback without changing custom selectors', async () => {
    const input = { questions: [{ question: 'Decision', options: [{ label: 'Keep current' }, { label: 'Skip' }] }] };
    const hooks = { nonQuestion: () => {}, onQuestion: () => {}, onAnswer: () => {} };
    expect((await createSharedInteractiveToolHandler('skip', hooks)('AskUserQuestion', input)).updatedInput.answers)
      .toEqual({ Decision: 'Skip' });
    const selected = { Decision: 'custom exact answer' };
    expect((await createSharedInteractiveToolHandler(() => selected, hooks)('AskUserQuestion', input)).updatedInput.answers)
      .toBe(selected);
  });
});

describe('shared-code fixture snapshots', () => {
  test('empty-directory creation/deletion and root or descendant mode changes are visible', () => {
    const directory = scratch();
    const empty = path.join(directory, 'empty');
    const before = snapshotFixture(directory);
    expect(before['.']).toBe(`dir:${fs.lstatSync(directory).mode}`);
    fs.mkdirSync(empty);
    const created = snapshotFixture(directory);
    expect(created).not.toEqual(before);
    expect(created.empty).toBe(`dir:${fs.lstatSync(empty).mode}`);
    fs.chmodSync(empty, (fs.lstatSync(empty).mode & 0o777) ^ 0o020);
    expect(snapshotFixture(directory)).not.toEqual(created);
    fs.rmSync(empty, { recursive: true });
    expect(snapshotFixture(directory)).toEqual(before);
    fs.chmodSync(directory, (fs.lstatSync(directory).mode & 0o777) ^ 0o020);
    expect(snapshotFixture(directory)).not.toEqual(before);
  });

  test('records a symlink without following its target', () => {
    const directory = scratch();
    const target = scratch();
    fs.writeFileSync(path.join(target, 'outside.txt'), 'original');
    const link = path.join(directory, 'alias');
    fs.symlinkSync(target, link);
    const before = snapshotFixture(directory);
    expect(Object.keys(before).sort()).toEqual(['.', 'alias']);
    fs.writeFileSync(path.join(target, 'outside.txt'), 'changed');
    expect(snapshotFixture(directory)).toEqual(before);
    expect(snapshotFixture(link)).toEqual({ '.': `link:${fs.lstatSync(link).mode}:${target}` });
  });

  (process.platform === 'win32' ? test.skip : test)('records a FIFO without opening it', () => {
    const directory = scratch();
    const fifo = path.join(directory, 'pipe');
    execFileSync('mkfifo', [fifo], { timeout: 10_000 });
    expect(snapshotFixture(directory).pipe).toBe(`special:${fs.lstatSync(fifo).mode}:${fs.lstatSync(fifo).rdev}`);
  });
});

function gh(f: SharedLibsFixture, endpoint: string) {
  return spawnSync(path.join(f.bin, 'gh'), ['api', '-X', 'GET', endpoint], {
    cwd: f.repo, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 10_000,
  });
}

function curl(f: SharedLibsFixture, args: string[]) {
  return spawnSync(path.join(f.bin, 'curl'), args, {
    cwd: f.repo, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 10_000,
  });
}

describe('shared-code curl source isolation', () => {
  test('captured curl output-file attempts are logged and rejected without writing files', () => {
    const f = createSharedLibsFixture('curl-output');
    cleanup.push(f.root);
    installSourceShims(f);
    expect(fs.existsSync(path.join(f.bin, 'curl'))).toBe(true);
    const outside = scratch();
    for (const [name, endpoint] of [['gh_repo.json', ''], ['gh_pulls.json', '/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1']]) {
      const output = path.join(outside, name);
      const response = curl(f, ['-sS', '-m', '20', '-o', output, '-w', 'http=%{http_code}\\n',
        '-H', 'Accept: application/vnd.github+json', `https://api.github.com/repos/fixture/shared-libs${endpoint}`]);
      expect(response.status).not.toBe(0);
      expect(response.stderr).toContain('file output');
      expect(fs.existsSync(output)).toBe(false);
    }
    const hiddenOutput = path.join(outside, 'hidden-exit.json');
    const command = `curl -sS -o ${shellQuote(hiddenOutput)} https://api.github.com/repos/fixture/shared-libs; printf done`;
    const compound = spawnSync('bash', ['-c', command], {
      cwd: f.repo, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 10_000,
    });
    expect(compound.status).toBe(0); // A later successful command cannot erase the rejected write.
    expect(compound.stdout).toBe('done');
    expect(fs.existsSync(hiddenOutput)).toBe(false);
    const requests = readRequests(f).filter(row => row.tool === 'curl');
    expect(requests).toHaveLength(3);
    expect(requests.every(row => row.args.includes('-o'))).toBe(true);
    expect(sharedReadOnlyViolations([], requests).join('\n')).toContain('file output');
  });

  test('stdout GETs preserve successful empty JSON, headers, status and one record per repeated request', () => {
    const f = createSharedLibsFixture('curl-empty');
    cleanup.push(f.root);
    installSourceShims(f);
    const before = snapshotFixture(f.root);
    const endpoint = 'repos/fixture/shared-libs/pulls?state=open&per_page=100&page=1';
    for (let i = 0; i < 2; i++) {
      const response = curl(f, ['-sS', '-m', '20', '-i', '-w', 'http=%{http_code}\\n',
        '-H', 'Accept: application/vnd.github+json', `https://api.github.com/${endpoint}`]);
      expect(response.status, response.stderr).toBe(0);
      expect(response.stdout).toBe('HTTP/2 200\ncontent-type: application/json\n\n[]\nhttp=200\n');
    }
    const repo = curl(f, ['--silent', '--request=GET', '--url=https://api.github.com/repos/fixture/shared-libs']);
    expect(repo.status, repo.stderr).toBe(0);
    expect(JSON.parse(repo.stdout).default_branch).toBe('main');
    const commit = curl(f, ['-sS', 'https://api.github.com/repos/fixture/shared-libs/commits/main']);
    expect(commit.status, commit.stderr).toBe(0);
    expect(JSON.parse(commit.stdout).sha).toBe(f.tip);
    const requests = readRequests(f);
    expect(requests.map(row => row.tool)).toEqual(['curl', 'curl', 'curl', 'curl']);
    expect(requests.slice(0, 2).map(row => row.endpoint)).toEqual([endpoint, endpoint]);
    expect(requests.every(row => row.method === 'GET')).toBe(true);
    expect(sharedReadOnlyViolations([], requests)).toEqual([]);
    const after = snapshotFixture(f.root);
    delete after[path.relative(f.root, f.trace)];
    expect(after).toEqual(before);
  });

  test('curl and gh share immutable source bytes and the old PR second file page', () => {
    const f = createSharedLibsFixture('curl-pinned');
    cleanup.push(f.root);
    seedOpportunitySources(f);
    fixtureGit(f, 'checkout', '-b', 'feature/curl-source');
    fixtureWrite(f, 'src/retry-worker.ts', '  export const exactBranch = true;\n\n');
    fixtureGit(f, 'add', 'src/retry-worker.ts');
    fixtureGit(f, 'commit', '-m', 'distinct branch source');
    const branch = fixtureGit(f, 'rev-parse', 'HEAD');
    installSourceShims(f, { prCoverage: true });
    const oldPr = curl(f, ['-fsSL', 'https://api.github.com/repos/fixture/shared-libs/pulls/42']);
    expect(oldPr.status, oldPr.stderr).toBe(0);
    const pr = JSON.parse(oldPr.stdout);
    expect(pr.updated_at).toBe('2020-01-01T00:00:00Z');
    fixtureWrite(f, 'src/retry-worker.ts', 'different raw overlay');
    for (const revision of [f.tip, branch, pr.head.sha]) {
      const endpoint = `repos/fixture/shared-libs/contents/src/retry-worker.ts?ref=${revision}`;
      const json = curl(f, ['-sS', `https://api.github.com/${endpoint}`]);
      const expected = gh(f, endpoint);
      expect(json.status, json.stderr).toBe(0);
      expect(json.stdout).toBe(expected.stdout);
      const raw = curl(f, ['-sS', '-H', 'Accept: application/vnd.github.raw+json', `https://api.github.com/${endpoint}`]);
      expect(raw.status, raw.stderr).toBe(0);
      expect(raw.stdout).toBe(Buffer.from(JSON.parse(expected.stdout).content, 'base64').toString());
    }
    for (const page of [1, 2, 3]) {
      const endpoint = `repos/fixture/shared-libs/pulls/42/files?per_page=100&page=${page}`;
      const response = curl(f, ['-sS', `https://api.github.com/${endpoint}`]);
      expect(response.status, response.stderr).toBe(0);
      expect(response.stdout).toBe(gh(f, endpoint).stdout);
      const files = JSON.parse(response.stdout);
      expect(files).toHaveLength(page === 1 ? 100 : page === 2 ? 1 : 0);
      if (page === 2) expect(files[0].filename).toBe('src/retry-worker.ts');
    }
    for (const revision of ['main', 'HEAD', 'f'.repeat(40), '__proto__']) {
      const response = curl(f, ['-f', `https://api.github.com/repos/fixture/shared-libs/contents/src/retry-worker.ts?ref=${revision}`]);
      expect(response.status).toBe(22);
      expect(response.stderr).toContain('unsupported or unpinned');
      expect(response.stdout).toBe('');
    }
  });

  test('unavailable API stays a visible 403 and never becomes a successful empty result', () => {
    const f = createSharedLibsFixture('curl-unavailable');
    cleanup.push(f.root);
    installSourceShims(f, { unavailableApi: true });
    const url = 'https://api.github.com/repos/fixture/shared-libs/pulls?state=open&page=1';
    const response = curl(f, ['-sS', '-w', 'http=%{http_code}\\n', url]);
    expect(response.status).toBe(0); // curl without --fail reports HTTP errors in its body/status.
    expect(response.stdout).toContain('API unavailable in this fixture');
    expect(response.stdout).toEndWith('http=403\n');
    expect(response.stdout).not.toContain('[]');
    const failed = curl(f, ['-fsS', '-w', '%{response_code}', url]);
    expect(failed.status).toBe(22);
    expect(failed.stdout).toBe('403');
    expect(failed.stderr).toContain('API unavailable in this fixture');
    expect(sharedReadOnlyViolations([], readRequests(f))).toEqual([]);
  });

  test('the captured null sink discards response bytes and headers without a persistent write', () => {
    const f = createSharedLibsFixture('curl-null-output');
    cleanup.push(f.root);
    installSourceShims(f);
    const before = snapshotFixture(f.root);
    const url = 'https://api.github.com/repos/fixture/shared-libs';
    const response = curl(f, ['-sS', '-m', '15', '-o', '/dev/null', '-w', 'http=%{http_code}\\n', url]);
    expect(response.status, response.stderr).toBe(0);
    expect(response.stdout).toBe('http=200\n');
    const discardHeaders = curl(f, ['-sS', '--dump-header', '/dev/null', url]);
    expect(discardHeaders.status, discardHeaders.stderr).toBe(0);
    expect(discardHeaders.stdout).not.toContain('HTTP/2');
    expect(JSON.parse(discardHeaders.stdout).default_branch).toBe('main');
    const stdoutHeaders = curl(f, ['-sS', '--dump-header', '-', '--output', '/dev/null', url]);
    expect(stdoutHeaders.status, stdoutHeaders.stderr).toBe(0);
    expect(stdoutHeaders.stdout).toBe('HTTP/2 200\ncontent-type: application/json\n\n');
    expect(sharedReadOnlyViolations([], readRequests(f))).toEqual([]);
    const after = snapshotFixture(f.root);
    delete after[path.relative(f.root, f.trace)];
    expect(after).toEqual(before);
  });

  test('unknown URLs, methods and file-producing curl options are rejected by the shim', () => {
    const f = createSharedLibsFixture('curl-rejected');
    cleanup.push(f.root);
    installSourceShims(f);
    const url = 'https://api.github.com/repos/fixture/shared-libs';
    const outside = scratch();
    const output = path.join(outside, 'must-not-exist');
    const cases = [
      ['https://example.invalid/repos/fixture/shared-libs'],
      ['http://127.0.0.1:9/'], ['file:///etc/passwd'],
      ['https://api.github.com/repos/another/repository'],
      ['https://api.github.com/repos/fixture/shared-libs/unknown'],
      ['-X', 'POST', url], ['--request=DELETE', url], ['-I', url],
      ['--output=' + output, url], ['-o' + output, url], ['-O', url],
      ['-D', output, url], ['--cookie-jar', output, url], ['--trace-ascii', output, url],
      ['--libcurl', output, url], ['--stderr', output, url],
      ['-w', '%output{' + output + '}%{http_code}', url],
      ['--write-out', '@' + output, url],
      ['--config', output, url], ['--data', 'value', url],
    ];
    for (const args of cases) {
      const response = curl(f, args);
      expect(response.status, JSON.stringify(args)).toBe(2);
      expect(response.stderr).toContain('Fixture curl rejected:');
      expect(response.stdout).toBe('');
      expect(fs.existsSync(output)).toBe(false);
    }
    const requests = readRequests(f);
    expect(requests).toHaveLength(cases.length);
    expect(requests.every(row => row.tool === 'curl' && !!row.violation)).toBe(true);
    expect(sharedReadOnlyViolations([], requests).length).toBeGreaterThan(0);
  });

  test('shared safety checks catch attempted writes even when a shell continues or no provider ran', () => {
    const bash = (command: string) => [{ tool: 'Bash', input: { command } }];
    for (const command of [
      "curl -sS -m 20 -o /tmp/gh_repo.json -w 'http=%{http_code}\\n' -H 'Accept: application/vnd.github+json' https://api.github.com/repos/fixture/shared-libs; echo done",
      '/usr/bin/curl --output=/tmp/report.json https://api.github.com/repos/fixture/shared-libs || true',
      "curl -w '%output{/tmp/report}%{http_code}' https://api.github.com/repos/fixture/shared-libs",
      "curl -X POST https://api.github.com/repos/fixture/shared-libs",
      'printf data > /tmp/report', 'cat README.md >> "/tmp/report"', 'cat README.md | tee /tmp/report',
      "bash <<'SH'\nprintf data > /tmp/report\nSH\n",
      "cat <<'DATA'\njust data\nDATA\ncurl -o /tmp/report https://api.github.com/repos/fixture/shared-libs",
    ]) expect(sharedReadOnlyViolations(bash(command)).length, command).toBeGreaterThan(0);
    expect(sharedReadOnlyViolations([{ tool: 'Write', input: { file_path: '/tmp/report', content: '' } }])).not.toEqual([]);
    for (const command of [
      "curl -fsSL -H 'Accept: application/vnd.github+json' 'https://api.github.com/repos/fixture/shared-libs/pulls?state=open&per_page=100&page=1' | head -c 600",
      "curl -sS -o - -w 'http=%{http_code}\\n' https://api.github.com/repos/fixture/shared-libs",
      "curl -sS -m 15 -o /dev/null -w 'http=%{http_code}\\n' https://api.github.com/repos/fixture/shared-libs 2>&1",
      'gh auth status 2>&1 | head -5', 'git --no-lazy-fetch log 2>/dev/null',
      "rg 'a > b' README.md", "rg '>' README.md", "rg '|' README.md",
      'rg tee README.md', 'rg curl README.md',
      "python3 - <<'PY'\nsize = 2\nif size > 1:\n    print(size)\nPY\n",
      "cat <<'DATA'\ncurl -o example.json https://example.invalid\nDATA\n",
    ]) expect(sharedReadOnlyViolations(bash(command)), command).toEqual([]);
  });

  test('shared safety checks preserve descriptor redirection inside shell substitutions and groups', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dir,
      'fixtures/shared-libs-readonly-substitution-ci16358.json'), 'utf8'));
    expect(fixture.calls.map((call: { attempt: number }) => call.attempt)).toEqual([1, 2]);
    for (const call of fixture.calls) expect(sharedReadOnlyViolations([call]), `CI attempt ${call.attempt}`).toEqual([]);

    const bash = (command: string) => [{ tool: 'Bash', input: { command } }];
    for (const command of [
      'value=$(cat README.md 2>&1)',
      '(cat README.md 2>&1)',
      'value=$(inner=$(cat README.md 2>&1); printf "%s" "$inner")',
      'value=$(cat README.md 2>/dev/null)',
      'value=$(cat README.md >/dev/stdout)',
      'value=$(cat README.md 2>&-)',
      "value=$(cat <<'DATA'\nprintf data > /tmp/report\nDATA\n)",
      "cat $(printf ignored) <<'DATA'\nprintf data >/tmp/report\nDATA\n",
      "value=$(cat $(printf ignored) <<'DATA'\nprintf data >/tmp/report\nDATA\n)",
      'curl $(printf https://api.github.com/repos/fixture/shared-libs) -o /dev/null',
      'printf "%s" $(printf done) tee /tmp/report',
      'printf "%s" $(printf done) curl -o /tmp/report',
      'LC_ALL=C >/dev/null printf tee /tmp/report',
      'LC_ALL=C >/dev/null printf curl -o /tmp/report',
      "printf '%s' '2>&1)'",
      'printf "%s" "2>&1)"',
    ]) expect(sharedReadOnlyViolations(bash(command)), command).toEqual([]);

    // Parentheses delimit executable shell, so writes inside either grouping
    // form must remain visible. Quoted ')' stays part of a filename.
    for (const command of [
      'value=$(printf data > /tmp/report)',
      '(printf data > /tmp/report)',
      'value=$(inner=$(printf data >> /tmp/report); printf "%s" "$inner")',
      'value=$(tee /tmp/report </dev/null)',
      'value=$(inner=$(/usr/bin/tee /tmp/report </dev/null); printf "%s" "$inner")',
      "value=$(bash <<'SH'\nprintf data > /tmp/report\nSH\n)",
      "bash -s $(printf ignored) <<'SH'\nprintf data >/tmp/report\nSH\n",
      "bash -s $(printf ignored) <<-'SH'\n\tprintf data >/tmp/report\n\tSH\n",
      "value=$(bash -s $(printf ignored) <<'SH'\nprintf data >/tmp/report\nSH\n)",
      'curl $(printf https://api.github.com/repos/fixture/shared-libs) -o /tmp/report',
      'curl $(printf https://api.github.com/repos/fixture/shared-libs) --trace /tmp/report',
      'value=$(curl $(printf https://api.github.com/repos/fixture/shared-libs) -o /tmp/report)',
      'value=$(cat README.md 2>&9)',
      '(cat README.md 3>/tmp/report 2>&3)',
      'value=$(cat README.md >"/dev/null)")',
      "printf data >& '/tmp/report)'",
    ]) expect(sharedReadOnlyViolations(bash(command)).length, command).toBeGreaterThan(0);
  });
});

function pinnedSource(f: SharedLibsFixture, revision: string, file: string) {
  const response = gh(f, `repos/fixture/shared-libs/contents/${file}?ref=${revision}`);
  expect(response.status, response.stderr).toBe(0);
  const body = JSON.parse(response.stdout);
  const expectedBlob = fixtureGit(f, 'rev-parse', `${revision}:${file}`);
  const bytes = execFileSync(Bun.which('git') || 'git', ['cat-file', 'blob', expectedBlob], {
    cwd: f.repo, env: { ...process.env, ...f.env }, timeout: 10_000,
  });
  expect(body.sha).toBe(expectedBlob);
  expect(Buffer.from(body.content, 'base64')).toEqual(bytes);
  return bytes;
}

describe('shared-code Contents API revision fidelity', () => {
  test('default, branch and PR SHAs return their own exact committed bytes, excluding raw overlays', () => {
    const f = createSharedLibsFixture('source-fidelity');
    cleanup.push(f.root);
    seedOpportunitySources(f);
    fixtureGit(f, 'checkout', '-b', 'feature/pinned-source');
    fixtureWrite(f, 'src/retry-worker.ts', '  export const branchParser = true;\n\n');
    fixtureGit(f, 'add', 'src/retry-worker.ts');
    fixtureGit(f, 'commit', '-m', 'use a distinct branch implementation');
    const branch = fixtureGit(f, 'rev-parse', 'HEAD');
    installSourceShims(f, { prCoverage: true });
    const prResponse = gh(f, 'repos/fixture/shared-libs/pulls/42');
    expect(prResponse.status, prResponse.stderr).toBe(0);
    const prHead = JSON.parse(prResponse.stdout).head.sha;
    expect(new Set([f.tip, branch, prHead]).size).toBe(3);
    fixtureWrite(f, 'src/retry-worker.ts', 'uncommitted raw overlay');
    const source = [f.tip, branch, prHead].map(revision => pinnedSource(f, revision, 'src/retry-worker.ts'));
    expect(source[1].toString()).toBe('  export const branchParser = true;\n\n');
    expect(source[2].toString()).toBe("export { retrySeconds } from '../lib/retry-after';\n");
    expect(new Set(source.map(bytes => bytes.toString('base64'))).size).toBe(3);
  });

  test('unknown SHAs, moving refs, omitted refs and missing source never succeed as default-tip content', () => {
    const f = createSharedLibsFixture('unknown-revision');
    cleanup.push(f.root);
    installSourceShims(f);
    for (const suffix of ['', '?ref=main', '?ref=HEAD', `?ref=${'f'.repeat(40)}`, '?ref=__proto__']) {
      const response = gh(f, `repos/fixture/shared-libs/contents/README.md${suffix}`);
      expect(response.status).not.toBe(0);
      expect(response.stderr).toContain('unsupported or unpinned fixture revision');
      expect(response.stdout).toBe('');
    }
    for (const file of ['missing.ts', 'toString']) {
      const response = gh(f, `repos/fixture/shared-libs/contents/${file}?ref=${f.tip}`);
      expect(response.status).not.toBe(0);
      expect(response.stdout).toBe('');
    }
  });
});

const interactive = [
  'shared-libs-plan-callers', 'shared-libs-review-index-flags', 'shared-libs-review-lifecycle',
  'shared-libs-review-path-eligibility', 'shared-libs-review-prior-coverage', 'shared-libs-review-revalidation',
];
const judged = ['shared-libs-opportunity-judgment', 'shared-libs-plan-callers', 'shared-libs-pr-coverage'];
const allShared = Object.keys(E2E_TOUCHFILES).filter(name => name.startsWith('shared-libs-')).sort();
const selected = (dependency: string) => selectTests([dependency], E2E_TOUCHFILES, GLOBAL_TOUCHFILES)
  .selected.filter(name => name.startsWith('shared-libs-')).sort();

describe('shared-code paid dependency selection', () => {
  test('SDK and judge changes select the actual affected owners', () => {
    expect(selected('test/helpers/agent-sdk-runner.ts')).toEqual(interactive);
    expect(selected('test/helpers/llm-judge.ts')).toEqual(judged);
  });

  test('generation, gating, fixture validation and host support keep their coverage owners', () => {
    for (const dependency of ['scripts/gen-skill-docs.ts', 'test/helpers/e2e-gate.ts', 'test/shared-libs-fixture.test.ts']) {
      expect(selected(dependency)).toEqual(allShared);
    }
    expect(selected('lib/claude-bin.ts')).toEqual(allShared.filter(name => name !== 'shared-libs-codex-read-only'));
    expect(selected('lib/eval-model.ts')).toEqual(allShared.filter(name => name !== 'shared-libs-codex-read-only'));
    for (const dependency of ['hosts/codex.ts', 'hosts/define-host.ts', 'scripts/resolvers/constants.ts']) {
      expect(selected(dependency)).toContain('shared-libs-codex-read-only');
    }
  });
});

describe('shared-code capture attempt accounting', () => {
  const entry = (name: string, passed = true): EvalTestEntry => ({ name, suite: 'shared-libs', tier: 'e2e',
    passed, duration_ms: 10, cost_usd: 0.01, turns_used: 2,
    exit_reason: passed ? 'success' : 'timeout', output: passed ? 'completed' : 'persisted but no terminal result',
    error: passed ? undefined : 'Claude Code process aborted by user',
    transcript: passed ? [{ type: 'result', subtype: 'success', terminal_reason: 'completed' }]
      : [{ type: 'user', message: { content: [{ type: 'tool_result', content: 'persisted verified record' }] } }],
  });

  async function finalized(captures: SharedCaptureAccumulator) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-shared-attempt-'));
    cleanup.push(directory);
    await captures.finalize(new EvalCollector('e2e', directory));
    const file = fs.readdirSync(directory).find(name => name.endsWith('.json') && !name.startsWith('_'))!;
    return JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
  }

  test('CI scenario waves retain failed attempts while complete retries report their real success', async () => {
    // Public scenario verdicts from CI run 35780434064, slices 2 and 4. The
    // timeouts remain failures even though their final tool persisted a record.
    const waves = [
      { name: 'shared-libs-review-path-eligibility', expected: ['symlinks', 'submodule', 'ignored'],
        first: [['submodule', true], ['ignored', true], ['symlinks', false]],
        second: ['ignored', 'submodule', 'symlinks'] },
      { name: 'shared-libs-review-prior-coverage', expected: ['legacy', 'removed-filter'],
        first: [['legacy', true], ['removed-filter', false]], second: ['legacy', 'removed-filter'] },
      { name: 'shared-libs-review-revalidation', expected: ['unchanged', 'secondary', 'branch', 'filtered'],
        first: [['unchanged', true], ['secondary', true], ['branch', false], ['filtered', false]],
        second: ['unchanged', 'secondary', 'branch', 'filtered'] },
    ] as const;
    const captures = new SharedCaptureAccumulator();
    for (const wave of waves) {
      await expect(captures.runAttempt(wave.name, wave.expected, 5_000, async attempt => {
        for (const [scenario, passed] of wave.first) attempt.add(scenario, entry(wave.name, passed));
      })).rejects.toThrow('failed scenario');
      await captures.runAttempt(wave.name, wave.expected, 5_000, async attempt => {
        for (const scenario of wave.second) attempt.add(scenario, entry(wave.name));
      });
    }
    const result = await finalized(captures);
    expect(result.tests.map((row: EvalTestEntry) => [row.name, row.attempt, row.passed])).toEqual(
      waves.flatMap(wave => [[wave.name, 1, false], [wave.name, 2, true]]));
    expect(result.flaky_retries).toEqual(waves.map(wave => ({ name: wave.name, attempts: 2 })));
    expect(result.tests.filter((row: EvalTestEntry) => !row.passed).map((row: EvalTestEntry) => row.exit_reason))
      .toEqual(['timeout', 'timeout', 'timeout']);
    expect(result.tests.map((row: EvalTestEntry) => row.transcript!.filter(event => event.scenario_name).length))
      .toEqual([3, 3, 2, 2, 4, 4]);
    expect(result.total_cost_usd).toBe(0.18);
    expect(collectorOutcomeCounts([result])).toEqual({ executed: 3, reused: 0, passed: 3, failed: 0, attempts: 6 });
  });

  test('missing scenarios in a later attempt cannot inherit an earlier pass', async () => {
    const captures = new SharedCaptureAccumulator();
    await captures.runAttempt('incomplete', ['first', 'second'], 5_000, async attempt => {
      attempt.add('first', entry('incomplete'));
      attempt.add('second', entry('incomplete'));
    });
    await expect(captures.runAttempt('incomplete', ['first', 'second'], 5_000, async attempt => {
      attempt.add('first', entry('incomplete'));
    })).rejects.toThrow('missing scenarios: second');
    const result = await finalized(captures);
    expect(result.tests[1]).toMatchObject({ attempt: 2, passed: false, exit_reason: 'attempt_incomplete' });
    expect(collectorOutcomeCounts([result])).toEqual({ executed: 1, reused: 0, passed: 0, failed: 1, attempts: 2 });
  });

  test('setup, verification and cleanup failures survive even when all recorded captures passed', async () => {
    const captures = new SharedCaptureAccumulator();
    for (const phase of ['setup', 'verification', 'cleanup']) {
      await expect(captures.runAttempt(phase, ['audit'], 5_000, async attempt => {
        if (phase !== 'setup') attempt.add('audit', entry(phase));
        throw new Error(`${phase} failed`);
      })).rejects.toThrow(`${phase} failed`);
    }
    const result = await finalized(captures);
    expect(result.tests.map((row: EvalTestEntry) => row.exit_reason)).toEqual(['fixture_threw', 'fixture_threw', 'fixture_threw']);
    expect(result.tests.every((row: EvalTestEntry) => !row.passed)).toBe(true);
    expect(result.tests[0].error).toContain('Missing scenarios: audit');
  });

  test('duplicate, foreign and mismatched captures fail even if the caller catches the immediate error', async () => {
    const captures = new SharedCaptureAccumulator();
    for (const kind of ['duplicate', 'foreign', 'name', 'suite', 'tier']) {
      await expect(captures.runAttempt(kind, ['audit'], 5_000, async attempt => {
        if (kind === 'duplicate' || kind === 'foreign') attempt.add('audit', entry(kind));
        try {
          const bad = { ...entry(kind), ...(kind === 'name' ? { name: 'other' }
            : kind === 'suite' ? { suite: 'other' } : kind === 'tier' ? { tier: 'llm-judge' as const } : {}) };
          attempt.add(kind === 'foreign' ? 'unknown' : 'audit', bad);
        } catch { /* A caught callback error must not manufacture a passing attempt. */ }
      })).rejects.toThrow('Invalid shared capture');
    }
    const result = await finalized(captures);
    expect(result.tests.every((row: EvalTestEntry) => !row.passed && row.exit_reason === 'capture_contract')).toBe(true);
    expect(result.tests.map((row: EvalTestEntry) => row.transcript!.filter(event => event.scenario_name).length))
      .toEqual([2, 2, 1, 1, 1]);
  });

  test('late callbacks stay with their attempt and an unfinished latest attempt fails finalization', async () => {
    const captures = new SharedCaptureAccumulator();
    let previous!: SharedCaptureAttempt;
    await captures.runAttempt('late', ['audit'], 5_000, async attempt => { previous = attempt; attempt.add('audit', entry('late')); });
    let release!: () => void;
    let current!: SharedCaptureAttempt;
    const pending = captures.runAttempt('late', ['audit'], 5_000, async attempt => {
      current = attempt;
      await new Promise<void>(resolve => { release = resolve; });
    });
    expect(() => previous.add('audit', entry('late'))).toThrow('Late shared capture');
    const result = await finalized(captures);
    expect(result.tests[0]).toMatchObject({ passed: true, attempt: 1 });
    expect(result.tests[1]).toMatchObject({ passed: false, attempt: 2, exit_reason: 'attempt_incomplete' });
    expect(() => current.add('audit', entry('late'))).toThrow('Late shared capture');
    release();
    await expect(pending).rejects.toThrow('Late shared capture');
    expect(collectorOutcomeCounts([result]).failed).toBe(1);
  });

  test('the path-case callback cleans its fixture when late capture recording is rejected', async () => {
    // Invoke the actual paid test callback with a deferred free capture, rather
    // than copying its finally block into a mock that cannot catch cleanup drift.
    const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-shared-libs-paths.test.ts'), 'utf8');
    const start = source.indexOf('async function exerciseEligibility(');
    const end = source.indexOf('\ndescribeE2E(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const callback = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
    const captures = new SharedCaptureAccumulator();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-late-path-'));
    cleanup.push(directory);
    let started!: () => void, release!: () => void;
    const captureStarted = new Promise<void>(resolve => { started = resolve; });
    const exercise = new Function('deps', `const { captures, preparePathEligibilityFixture, fs, path,
      reviewLifecycleInstructions, reviewRevalidationPrompt, runSharedInteractive, readRequests, expect, CAPTURE_LONG_MS } = deps;
      ${callback}\nreturn exerciseEligibility;`)({
      captures, fs, path, expect, CAPTURE_LONG_MS: 5_000,
      preparePathEligibilityFixture: () => ({ fixture: { root: directory }, current: { evidence_paths: [] } }),
      reviewLifecycleInstructions: () => 'unused instructions',
      reviewRevalidationPrompt: () => 'unused prompt',
      readRequests: () => [],
      runSharedInteractive: async () => {
        started();
        await new Promise<void>(resolve => { release = resolve; });
        throw new Error('capture elapsed');
      },
    });
    const pending = exercise('late-path-callback', ['symlinks']);
    await captureStarted;
    await captures.finalize(null);
    expect(fs.existsSync(directory)).toBe(true);
    release();
    await expect(pending).rejects.toThrow('Late shared capture');
    expect(fs.existsSync(directory)).toBe(false);
  });

  test('Bun configured retry creates separate complete attempt records through the real collector', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-shared-retry-'));
    cleanup.push(directory);
    const source = path.join(directory, 'retry.test.ts');
    fs.writeFileSync(source, `import { afterAll, test } from 'bun:test';
import { SharedCaptureAccumulator } from ${JSON.stringify(path.resolve(import.meta.dir, 'helpers/shared-libs-eval-fixture.ts'))};
import { EvalCollector } from ${JSON.stringify(path.resolve(import.meta.dir, 'helpers/eval-store.ts'))};
const captures = new SharedCaptureAccumulator();
const collector = new EvalCollector('e2e', ${JSON.stringify(path.join(directory, 'results'))});
let invocation = 0;
afterAll(() => captures.finalize(collector));
test('actual-retry', () => captures.runAttempt('actual-retry', ['audit'], 5_000, async attempt => {
  const passed = ++invocation === 2;
  attempt.add('audit', { name: 'actual-retry', suite: 'shared-libs', tier: 'e2e', passed,
    duration_ms: 1, cost_usd: 0, exit_reason: passed ? 'success' : 'timeout' });
}));
`);
    const run = spawnSync(process.execPath, ['test', source, '--retry', '1'], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, EVALS: '0', EVALS_TIER: 'off' },
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const resultDir = path.join(directory, 'results');
    const file = fs.readdirSync(resultDir).find(name => name.endsWith('.json') && !name.startsWith('_'))!;
    const result = JSON.parse(fs.readFileSync(path.join(resultDir, file), 'utf8'));
    expect(result.tests.map((row: EvalTestEntry) => [row.attempt, row.passed, row.exit_reason]))
      .toEqual([[1, false, 'timeout'], [2, true, 'success']]);
    expect(collectorOutcomeCounts([result])).toEqual({ executed: 1, reused: 0, passed: 1, failed: 0, attempts: 2 });
  });

  test('Bun outer timeouts stay failed after late completion, with and without a retry', () => {
    for (const mode of ['retry', 'final', 'late-cleanup', 'late-cleanup-error', 'setup']) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-shared-timeout-'));
      cleanup.push(directory);
      const source = path.join(directory, 'timeout.test.ts');
      fs.writeFileSync(source, `import { afterAll, test } from 'bun:test';
import { SharedCaptureAccumulator } from ${JSON.stringify(path.resolve(import.meta.dir, 'helpers/shared-libs-eval-fixture.ts'))};
import { EvalCollector } from ${JSON.stringify(path.resolve(import.meta.dir, 'helpers/eval-store.ts'))};
const captures = new SharedCaptureAccumulator();
const collector = new EvalCollector('e2e', ${JSON.stringify(path.join(directory, 'results'))});
const mode = ${JSON.stringify(mode)};
let invocation = 0;
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 220)); await captures.finalize(collector); });
test('outer-timeout', () => captures.runAttempt('outer-timeout', ['audit'], 50, async attempt => {
  const current = ++invocation;
  const row = { name: 'outer-timeout', suite: 'shared-libs', tier: 'e2e', passed: true,
    duration_ms: 1, cost_usd: 0, exit_reason: 'success' };
  if (mode.startsWith('late-cleanup')) attempt.add('audit', row);
  if (mode === 'setup') {
    const setupEnd = performance.now() + 150;
    while (performance.now() < setupEnd) { /* Synchronous fixture setup uses the same deadline. */ }
  } else if (current === 1) await new Promise(resolve => setTimeout(resolve, 150));
  if (mode === 'late-cleanup-error') throw new Error('cleanup failed after timeout');
  if (!mode.startsWith('late-cleanup')) attempt.add('audit', row);
}), { timeout: 50, retry: mode === 'retry' ? 1 : 0 });
`);
      const run = spawnSync(process.execPath, ['test', source], {
        cwd: directory, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, EVALS: '0', EVALS_TIER: 'off' },
      });
      expect(run.status, run.stdout + run.stderr).toBe(mode === 'retry' ? 0 : 1);
      expect(run.stderr).not.toContain('Unhandled error between tests');
      const resultDir = path.join(directory, 'results');
      const file = fs.readdirSync(resultDir).find(name => name.endsWith('.json') && !name.startsWith('_'))!;
      const result = JSON.parse(fs.readFileSync(path.join(resultDir, file), 'utf8'));
      expect(result.tests.map((row: EvalTestEntry) => [row.attempt, row.passed]))
        .toEqual(mode === 'retry' ? [[1, false], [2, true]] : [[1, false]]);
      expect(['timeout', 'attempt_incomplete']).toContain(result.tests[0].exit_reason);
      expect(result.tests[0].error).toContain('Test attempt stopped:');
      expect(collectorOutcomeCounts([result])).toEqual({ executed: 1, reused: 0,
        passed: mode === 'retry' ? 1 : 0, failed: mode === 'retry' ? 0 : 1, attempts: mode === 'retry' ? 2 : 1 });
    }
  });
});
