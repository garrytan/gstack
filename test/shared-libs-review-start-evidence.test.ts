/** Public start/read/finish subsequences, not retrospective passing lifecycle evidence. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { hasTrustedReviewStartRead } from './helpers/shared-libs-review-start-evidence';

// Exact public native events from CI merge264f48d7/head16358ef, slice4,
// attempts1(filtered) and2(unchanged). Thinking/narration are never read here.
// The later subsequences are cancelled replays' completed unchanged scenarios:
// their observers failed, so they remain failed historical evidence.
const captured = JSON.parse(readFileSync(path.join(import.meta.dir, 'fixtures/shared-libs-review-start-public.json'), 'utf8'));

function replay(index = 0) { return structuredClone(captured[index]) as any; }
function inspection(run: any) { return run.events[2].message.content[0]; }
function inspected(run: any) { return run.events[3].message.content[0]; }
function changeRecord(run: any, field: string, value: unknown) {
  inspected(run).content = inspected(run).content.split('\n').map((line: string) => {
    if (!line.startsWith('{"skill":"review","repo"')) return line;
    return JSON.stringify({ ...JSON.parse(line), [field]: value });
  }).join('\n');
}

describe('trusted review-start observations', () => {
  test.each(captured.map((run: any, index: number) => [index, run.capture ?? `CI/${run.attempt}/${run.scenario}`]))(
    'complete public read-form inventory %i (%s) preserves observation only', index => {
      const run = replay(Number(index));
      expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
    });

  test.each([0, 1])('captured find/cat read %i is accepted although the input lacks the dotted directory', index => {
    const run = replay(index);
    expect(inspection(run).input.command).not.toContain('.review-starts');
    expect(inspected(run).content).toContain('.review-starts');
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
  });

  test('actual quoted find substitution reads the current start record', () => {
    const run = replay(2);
    expect(inspection(run).input.command).toContain('cat "$(find ');
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
  });

  test('actual relative read after cd observes the same current start record', () => {
    const run = replay(3);
    expect(inspection(run).input.command).toContain('cat state/projects/fixture-shared-libs/.review-starts/');
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
  });

  for (const paths of [path.posix, path.win32]) {
    for (const tool of ['cat', 'head', 'tail', 'sed', 'jq', 'Read']) {
      test(`${paths === path.posix ? 'POSIX' : 'Windows'} ${tool} resolves source paths and spaces`, () => {
        const run = replay(3);
        const root = paths === path.posix ? '/fixture root' : 'D:\\fixture root';
        run.expected.repo = paths.join(root, 'repo');
        run.expected.directory = paths.join(root, 'state', 'projects', 'fixture-shared-libs', '.review-starts');
        changeRecord(run, 'repo', run.expected.repo);
        inspected(run).content = inspected(run).content.split('\n').find((line: string) => line.startsWith('{"skill"'));
        const file = paths.join(run.expected.directory, '201f687a-e805-45ff-985a-549398376e67.json');
        const relative = paths.relative(run.expected.repo, file);
        const fromRoot = paths.relative(root, file);
        const dotted = `${paths.dirname(file)}${paths.sep}..${paths.sep}.review-starts${paths.sep}${paths.basename(file)}`;
        const prefix = ({ cat: 'cat', head: 'head -n 1', tail: 'tail -n 1', sed: "sed -n '1p'", jq: "jq -c '.'" } as any)[tool];
        const operands = [file, relative, dotted];
        for (const operand of operands) {
          inspection(run).name = tool === 'Read' ? 'Read' : 'Bash';
          inspection(run).input = tool === 'Read' ? { file_path: operand } : { command: `${prefix} '${operand}'` };
          expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
        }
        if (tool === 'Read') return;
        for (const cd of [`cd '${root}'`, 'cd ..', `cd -- '..' && cd '${paths.join('repo', '..')}'`]) {
          inspection(run).input.command = `${cd}; ${prefix} '${fromRoot}'`;
          expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
        }
      });
    }
  }

  test.each(['relative name', 'relative path', 'dot path', 'nested quotes', 'unquoted', 'absolute dotted'])('discovery roots use the reader cwd: %s', form => {
    const run = replay(3);
    const filename = '201f687a-e805-45ff-985a-549398376e67.json';
    const root = path.posix.dirname(run.expected.repo);
    const relative = path.posix.relative(root, run.expected.directory);
    let scope = `'${relative}'`, predicate = `-name '${filename}'`;
    if (form === 'relative path') { scope = '.'; predicate = `-path '*/.review-starts/${filename}'`; }
    if (form === 'dot path') { scope = `'./${relative}'`; predicate = `-path './${relative}/${filename}'`; }
    if (form === 'nested quotes') { scope = `"${relative}"`; predicate = `-name "${filename}"`; }
    if (form === 'absolute dotted') scope = `'${run.expected.directory}/../.review-starts'`;
    const find = `find ${scope} ${predicate} | head -1`;
    inspection(run).input.command = `cd '${root}'; cat ${form === 'unquoted' ? `$(${find})` : `"$(${find})"`}`;
    inspected(run).content = inspected(run).content.split('\n').find((line: string) => line.startsWith('{"skill"'));
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
  });

  test('nested quoted discovery accepts spaces without flattening shell quotation', () => {
    const run = replay(3);
    run.expected.repo = '/fixture root/repo';
    run.expected.directory = '/fixture root/state data/.review-starts';
    changeRecord(run, 'repo', run.expected.repo);
    inspected(run).content = inspected(run).content.split('\n').find((line: string) => line.startsWith('{"skill"'));
    inspection(run).input.command = 'cd "/fixture root"; cat "$(find "state data" -name "201f687a-e805-45ff-985a-549398376e67.json" | head -1)"';
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
  });

  test.each(['wrong cwd', 'unknown cwd', 'wrong cd operand', 'quoted cd', 'comment cd', 'subshell cd', 'pipeline cd', 'background cd', 'ambiguous cd', 'short-circuit or', 'short-circuit and', 'foreign discovery'])('relative record binding rejects %s', kind => {
    const run = replay(3);
    const root = path.posix.dirname(run.expected.repo);
    const relative = 'state/projects/fixture-shared-libs/.review-starts/201f687a-e805-45ff-985a-549398376e67.json';
    const changes: Record<string, string> = {
      'wrong cwd': 'cd /foreign', 'unknown cwd': 'cd "$UNKNOWN"', 'wrong cd operand': `cd '${root}' extra`,
      'quoted cd': `echo "cd '${root}'"`, 'comment cd': `echo context # cd '${root}'\n`,
      'subshell cd': `(cd '${root}')`, 'pipeline cd': `cd '${root}' | cat`,
      'background cd': `cd '${root}' & echo background`, 'ambiguous cd': `cd '${root}' || echo failed`,
      'short-circuit or': `true || cd '${root}'`, 'short-circuit and': `false && cd '${root}'`,
    };
    inspection(run).input.command = kind === 'foreign discovery'
      ? `cd /foreign; cat "$(find state -name '201f687a-e805-45ff-985a-549398376e67.json')"`
      : `${changes[kind]}; cat '${relative}'`;
    inspected(run).content = inspected(run).content.split('\n').find((line: string) => line.startsWith('{"skill"'));
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(false);
  });

  test.each(['double', 'unquoted', 'single', 'escaped', 'wrong source'])('find substitution file operand: %s', form => {
    const run = replay(2);
    const token = 'ef41947a-643b-4494-aaee-149f288a9b29';
    const body = `find '${run.expected.directory}' -name '${token}.json' | head -1`;
    inspection(run).input.command = form === 'double' ? `cat "$( ${body} )"`
      : form === 'unquoted' ? `cat $( ${body} )`
      : form === 'single' ? "cat '$(find /fixture/state | head -1)'"
      : form === 'escaped' ? 'cat "\\$(find /fixture/state | head -1)"'
      : 'cat "$(find /fixture/state | head -1 /fixture/instructions.md)"';
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(['double', 'unquoted'].includes(form));
  });

  test.each(['quoted', 'unquoted', 'wrong token', 'foreign root', 'printed instructions'])('JSON-only substitution result: %s', form => {
    const run = replay(2);
    const filename = 'ef41947a-643b-4494-aaee-149f288a9b29.json';
    let body = `find '${run.expected.directory}' -name '${filename}' | head -1`;
    if (form === 'wrong token') body = body.replace(filename, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
    if (form === 'foreign root') body = body.replace(run.expected.directory, '/foreign/state');
    if (form === 'printed instructions') body = "printf '%s' /fixture/instructions.md";
    inspection(run).input.command = form === 'unquoted' ? `cat $(${body})` : `cat "$(${body})"`;
    inspected(run).content = inspected(run).content.split('\n').find((line: string) => line.startsWith('{"skill"'));
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(['quoted', 'unquoted'].includes(form));
  });

  test.each(['cat', 'head', 'tail', 'sed', 'jq', 'Read', 'Read text blocks'])('explicit-path %s preserves record binding', tool => {
    const run = replay();
    const file = inspected(run).content.split('\n').find((line: string) => line.startsWith('== ')).slice(3);
    const json = inspected(run).content.split('\n').find((line: string) => line.startsWith('{"skill"'));
    const shell = !tool.startsWith('Read');
    const prefix = ({ cat: 'cat', head: 'head -n 1', tail: 'tail -n 1', sed: "sed -n '1p'", jq: "jq -c '.'" } as any)[tool];
    inspection(run).name = shell ? 'Bash' : 'Read';
    inspection(run).input = shell ? { command: `${prefix} '${file}'` } : { file_path: file };
    inspected(run).content = shell ? json : tool === 'Read' ? `1\t${json}`
      : [{ type: 'text', text: `1→${json}` }];
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
  });

  test.each(['$REVIEW_START', '${TOKEN}'])('labeled start output and documented finish variable %s preserve binding', variable => {
    const run = replay();
    run.events[1].message.content[0].content = run.events[1].message.content[0].content
      .replace(/\n([a-f0-9-]{36})$/, '\nREVIEW_START=$1');
    run.events[4].message.content[0].input.command = run.events[4].message.content[0].input.command
      .replace(/--finish [a-f0-9-]{36}/, `--finish "${variable}"`);
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
    changeRecord(run, 'started_at', '2020-01-01T00:00:00.000Z');
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(false);
  });

  test.each([path.posix, path.win32])('record paths retain the source platform spelling', paths => {
    const run = replay();
    run.expected.repo = paths.join(paths === path.win32 ? 'D:\\fixture root' : '/fixture root', 'repo');
    run.expected.directory = paths.join(paths.dirname(run.expected.repo), 'state', 'projects', 'fixture-shared-libs', '.review-starts');
    const token = '099c0b80-598d-4625-8bb6-d60c430ef9f6';
    inspection(run).name = 'Read';
    inspection(run).input = { file_path: paths.join(run.expected.directory, `${token}.json`) };
    changeRecord(run, 'repo', run.expected.repo);
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
  });

  test('quoted helper executable and find-assignment read retain actual command meaning', () => {
    const run = replay();
    run.events[0].message.content[0].input.command = '"/trusted path/gstack-review-log" --start review';
    inspection(run).input.command = 'F=$(find "$GSTACK_HOME/projects" -name "099c0b80-*.json" | head -1); echo "$F"; cat "$F"';
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
  });

  test.each(['valid', 'wrong state', 'wrong slug', 'wrong token', 'unknown variable', 'literal variable', 'escaped variable', 'rebound variable'])(
    'trusted fixture environment and literal assignments: %s', form => {
      const run = replay(3);
      const token = '201f687a-e805-45ff-985a-549398376e67';
      let operand = '$GSTACK_HOME/projects/$SLUG/.review-starts/$TOK.json';
      if (form === 'unknown variable') operand = operand.replace('$GSTACK_HOME', '$AMBIENT');
      inspection(run).input.command = `GSTACK_HOME="\${GSTACK_HOME:-$HOME/.gstack}"; TOK=${token}; `
        + (form === 'rebound variable' ? 'TOK=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa; ' : '')
        + (form === 'literal variable' ? `cat '${operand}'` : form === 'escaped variable' ? `cat "${operand.replaceAll('$', '\\$')}"` : `cat "${operand}"`);
      if (form === 'wrong state') run.expected.state = '/foreign/state';
      if (form === 'wrong slug') run.expected.slug = 'foreign';
      if (form === 'wrong token') inspection(run).input.command = inspection(run).input.command.replace(token, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(form === 'valid');
    });

  test.each(['valid', 'foreign directory', 'rebound file', 'quoted command', 'heredoc body'])(
    'literal directory iteration retains read-target binding: %s', form => {
      const run = replay();
      const body = `D='${run.expected.directory}'; for f in "$D"/*; do echo "$f"; cat "$f"; done`;
      inspection(run).input.command = form === 'foreign directory' ? body.replace(run.expected.directory, '/foreign/state')
        : form === 'rebound file' ? body.replace('cat "$f"', 'f=/fixture/instructions.md; cat "$f"')
        : form === 'quoted command' ? `printf '%s' '${body.replaceAll("'", '')}'`
        : form === 'heredoc body' ? `cat <<'DATA'\n${body}\nDATA` : body;
      expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(form === 'valid');
    });

  test.each(['literal', 'pipeline', 'background', 'subshell', 'conditional'])(
    'path assignments retain their execution scope: %s', scope => {
      const run = replay(3);
      const assignment = `D='${run.expected.directory}'`;
      const prefix = scope === 'pipeline' ? `${assignment} | cat`
        : scope === 'background' ? `${assignment} & true`
        : scope === 'subshell' ? `(${assignment})`
        : scope === 'conditional' ? `false && ${assignment}` : assignment;
      inspection(run).input.command = `${prefix}; cat "$D/201f687a-e805-45ff-985a-549398376e67.json"`;
      expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(scope === 'literal');
    });

  test.each(['prefix', 'suffix', 'only data', 'unterminated'])(
    'heredoc bodies do not hide executed commands or invent them: %s', form => {
      const run = replay();
      const file = `${run.expected.directory}/099c0b80-598d-4625-8bb6-d60c430ef9f6.json`;
      const data = `cat <<'DATA'\ncat '${file}'\nDATA`;
      inspection(run).input.command = form === 'prefix' ? `cat '${file}'; ${data}`
        : form === 'suffix' ? `${data}\ncat '${file}'`
        : form === 'unterminated' ? `cat <<'DATA'\ncat '${file}'` : data;
      expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(['prefix', 'suffix'].includes(form));
    });

  test.each([
    ['repo', '/unrelated/repo'], ['branch', 'feature-a'], ['wtree', 'f'.repeat(40)],
    ['started_at', '2020-01-01T00:00:00.000Z'], ['skill', 'ship'],
  ])('rejects a wrong or stale %s', (field, value) => {
    const run = replay();
    changeRecord(run, field, value);
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(false);
  });

  test.each([
    'missing result', 'error result', 'unpaired result', 'assistant result', 'narration',
    'instruction Read', 'instruction cat', 'unrelated find', 'comment token', 'quoted cat', 'quoted start',
    'heredoc read', 'heredoc start', 'rebound variable', 'jq option value', 'fake while read',
    'echo only', 'wrong path', 'path suffix', 'wrong start token',
    'wrong finish token', 'read before start', 'read after finish', 'missing finish', 'failed finish',
  ])('rejects %s despite token/path text elsewhere', kind => {
    const run = replay();
    if (kind === 'missing result') run.events.splice(3, 1);
    if (kind === 'error result') inspected(run).is_error = true;
    if (kind === 'unpaired result') inspected(run).tool_use_id = 'other-tool';
    if (kind === 'assistant result') run.events[3].type = 'assistant';
    if (kind === 'narration') run.events[3] = { type: 'assistant', message: { content: [{
      type: 'text', text: inspected(run).content,
    }] } };
    if (kind === 'instruction Read') {
      inspection(run).name = 'Read'; inspection(run).input = { file_path: '/fixture/review-lifecycle.md' };
    }
    if (kind === 'instruction cat') inspection(run).input = { command: 'cat /fixture/review-lifecycle.md' };
    if (kind === 'unrelated find') inspection(run).input = { command: 'cat /fixture/review-lifecycle.md; find /tmp -maxdepth 0' };
    if (kind === 'comment token') inspection(run).input = { command: 'cat /fixture/instructions.md # 099c0b80-598d-4625-8bb6-d60c430ef9f6' };
    if (kind === 'quoted cat') inspection(run).input = { command: `printf '%s\\n' 'cat ${run.expected.directory}/099c0b80-598d-4625-8bb6-d60c430ef9f6.json' '${inspected(run).content}'` };
    if (kind === 'quoted start') run.events[0].message.content[0].input.command = "printf '%s\\n' 'gstack-review-log --start review' '099c0b80-598d-4625-8bb6-d60c430ef9f6'";
    const file = `${run.expected.directory}/099c0b80-598d-4625-8bb6-d60c430ef9f6.json`;
    if (kind === 'heredoc read') inspection(run).input.command = `cat <<'DATA'\ncat '${file}'\n${inspected(run).content}\nDATA`;
    if (kind === 'heredoc start') run.events[0].message.content[0].input.command = "cat <<'DATA'\ngstack-review-log --start review\n099c0b80-598d-4625-8bb6-d60c430ef9f6\nDATA";
    if (kind === 'rebound variable') inspection(run).input.command = 'F=$(find /tmp -name "*.json"); F=/fixture/instructions.md; cat "$F"';
    if (kind === 'jq option value') inspection(run).input.command = `jq --arg path '${file}' -r '.text' /fixture/instructions.json`;
    if (kind === 'fake while read') inspection(run).input.command = 'F=/fixture/instructions.md; find /tmp -maxdepth 0 | while printf read F; do cat "$F"; break; done';
    if (kind === 'echo only') inspection(run).input = { command: `echo '${inspected(run).content}'` };
    if (kind === 'wrong path') inspected(run).content = inspected(run).content.replace('/.review-starts/', '/untrusted/');
    if (kind === 'path suffix') inspected(run).content = inspected(run).content.replace(/\.json\n/, '.json.unrelated\n');
    if (kind === 'wrong start token') run.events[1].message.content[0].content = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    if (kind === 'wrong finish token') run.events[4].message.content[0].input.command =
      run.events[4].message.content[0].input.command.replace(/--finish [a-f0-9-]{36}/, '--finish aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    if (kind === 'read before start') run.events = [...run.events.slice(2, 4), ...run.events.slice(0, 2), ...run.events.slice(4)];
    if (kind === 'read after finish') run.events = [...run.events.slice(0, 2), ...run.events.slice(4), ...run.events.slice(2, 4)];
    if (kind === 'missing finish') run.events.splice(4);
    if (kind === 'failed finish') run.events[5].message.content[0].is_error = true;
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(false);
  });

  test('the actual paid verifier consumes the matcher result and preserves adjacent checks', () => {
    const source = readFileSync(path.join(import.meta.dir, 'skill-e2e-shared-libs.test.ts'), 'utf8');
    const scenario = source.slice(source.indexOf("test('shared-libs-review-revalidation'"));
    const marker = '}, result => {';
    const start = scenario.indexOf(marker) + marker.length;
    const body = scenario.slice(start, scenario.indexOf('\n        });', start));
    expect(start).toBeGreaterThan(marker.length);
    const verify = new Function('deps', 'result', new Bun.Transpiler({ loader: 'ts' }).transformSync(`const { change, questions, expect, toolCommandTrace,
      reviewRecords, createHash, path, f, fixtureGit, fixtureWorkingTree, hasTrustedReviewStartRead } = deps;
      ${body}`));
    for (const index of captured.keys()) {
      const run = replay(index);
      if (!['unchanged', 'filtered'].includes(run.scenario)) continue;
      const trace = 'gstack-review-read\ngit check-attr filter -- src/retry-route.ts lib/retry-after.ts\ngit ls-files --stage\ncanReuseSharedLibsAdvisory';
      const last = { skill: 'review', review_binding: { started_at: run.expected.startedAt,
        branch_id: createHash('sha256').update(run.expected.branch).digest('hex') },
        findings: run.scenario === 'unchanged' ? [] : [{ advisory: true, action: 'skipped' }] };
      const result = { events: run.events, toolCalls: [{ tool: 'Bash', input: { command: trace } }] };
      let matcherCalls = 0;
      const deps = { change: run.scenario, questions: run.scenario === 'unchanged' ? [] : [{}], expect,
        toolCommandTrace: () => [trace], reviewRecords: () => [
          { skill: 'review', findings: [{ advisory: true, action: 'skipped' }] }, last,
        ], createHash, path: path.posix, f: { repo: run.expected.repo,
          state: run.expected.directory.replace(/\/projects\/fixture-shared-libs\/\.review-starts$/, '') },
        fixtureGit: () => run.expected.branch, fixtureWorkingTree: () => run.expected.wtree,
        hasTrustedReviewStartRead: (events: unknown[], expected: any) => {
          matcherCalls++; expect(events).toBe(run.events); expect(expected).toEqual(run.expected);
          return hasTrustedReviewStartRead(events, expected);
        } };
      verify(deps, result);
      expect(matcherCalls).toBe(1);
      expect(() => verify({ ...deps, hasTrustedReviewStartRead: () => false }, result)).toThrow();
      expect(() => verify({ ...deps, toolCommandTrace: () => ['gstack-review-read'] }, result)).toThrow();
      expect(() => verify({ ...deps, questions: run.scenario === 'unchanged' ? [{}] : [] }, result)).toThrow();
      expect(() => verify({ ...deps, reviewRecords: () => [] }, result)).toThrow();
    }
  });
});

const sameCallReceipt = {
  "source": "/home/user/.capy/work/shared-libs-captures/1790268533056-shared-libs-review-revalidation-6-4.json",
  "source_sha256": "146c7faf66315868a5930b53c6a2a3f4dd289e246768076e84d2a7fa5666b494",
  "expected": {
    "repo": "/tmp/gp.31WCir/gstack-paid-shard-vrRGND/tmp/gstack-shared-revalidate-filtered-7VDIki/repo",
    "branch": "feature/a",
    "wtree": "288a3521b692882b9936606504a4b7999286702f",
    "startedAt": "2026-09-24T16:46:01.848Z",
    "state": "/tmp/gp.31WCir/gstack-paid-shard-vrRGND/tmp/gstack-shared-revalidate-filtered-7VDIki/state",
    "slug": "fixture-shared-libs",
    "directory": "/tmp/gp.31WCir/gstack-paid-shard-vrRGND/tmp/gstack-shared-revalidate-filtered-7VDIki/state/projects/fixture-shared-libs/.review-starts"
  },
  "public_start_pair": {
    "call": {
      "type": "tool_use",
      "id": "toolu_01BK5W3vQndHVp71gYmy3w2M",
      "name": "Bash",
      "input": {
        "command": "git fetch origin main --quiet; DIFF_BASE=$(git merge-base origin/main HEAD); echo \"DIFF_BASE=$DIFF_BASE\"; START_OUT=$(/workspace/gstack/bin/gstack-review-log --start review); echo \"START_OUT=$START_OUT\"; REVIEW_START=$(echo \"$START_OUT\" | grep -oE '[A-Za-z0-9_.-]+' | tail -1); echo \"REVIEW_START=$REVIEW_START\"; echo \"=== START RECORD ===\"; cat \"/tmp/gp.31WCir/gstack-paid-shard-vrRGND/tmp/gstack-shared-revalidate-filtered-7VDIki/state/projects/fixture-shared-libs/.review-starts/$REVIEW_START.json\"; echo; echo \"=== DIFF ===\"; git diff \"$DIFF_BASE\"; echo \"=== UNTRACKED ===\"; git ls-files --others --exclude-standard; echo \"=== HEAD/BRANCH ===\"; git rev-parse --short HEAD; git symbolic-ref --quiet --short HEAD; git status --short",
        "description": "Fetch base, capture review start token, read start record, then diff"
      },
      "caller": {
        "type": "direct"
      }
    },
    "result": {
      "tool_use_id": "toolu_01BK5W3vQndHVp71gYmy3w2M",
      "type": "tool_result",
      "content": "DIFF_BASE=f9dd5f0339b79af836810c03d49d3f4db66f1e03\nSTART_OUT=65892676-dd95-40b6-a3ba-6615bb41b0b6\nREVIEW_START=65892676-dd95-40b6-a3ba-6615bb41b0b6\n=== START RECORD ===\n{\"skill\":\"review\",\"repo\":\"/tmp/gp.31WCir/gstack-paid-shard-vrRGND/tmp/gstack-shared-revalidate-filtered-7VDIki/repo\",\"branch\":\"feature/a\",\"wtree\":\"288a3521b692882b9936606504a4b7999286702f\",\"started_at\":\"2026-09-24T16:46:01.848Z\"}\n=== DIFF ===\ndiff --git a/src/retry-worker.ts b/src/retry-worker.ts\nindex 8ab4b18..8f6dd51 100644\n--- a/src/retry-worker.ts\n+++ b/src/retry-worker.ts\n@@ -1 +1,15 @@\n-export { retrySeconds } from '../lib/retry-after';\n+// Both callers require Retry-After seconds/date parsing, 3600-second ceiling and caller fallback.\n+export function retrySeconds(value: string | null, now: number, fallback = 5): number {\n+  if (value == null || value.trim() === '') return fallback;\n+  const normalized = value.trim();\n+  if (/^\\d+$/.test(normalized)) {\n+    const seconds = Number(normalized);\n+    if (!Number.isSafeInteger(seconds)) return fallback;\n+    return Math.min(seconds, 3600);\n+  }\n+  const deadline = Date.parse(normalized);\n+  if (!Number.isFinite(deadline)) return fallback;\n+  const remaining = Math.ceil((deadline - now) / 1000);\n+  if (remaining < 0) return 0;\n+  return Math.min(remaining, 3600);\n+}\n=== UNTRACKED ===\n=== HEAD/BRANCH ===\nf9dd5f0\nfeature/a\n M src/retry-route.ts\n M src/retry-worker.ts",
      "is_error": false
    }
  },
  "public_finish_pair": {
    "call": {
      "type": "tool_use",
      "id": "toolu_01EVWtbsxqLFr25MPuvyZsw6",
      "name": "Bash",
      "input": {
        "command": "cd /tmp/gp.31WCir/gstack-paid-shard-vrRGND/tmp/gstack-shared-revalidate-filtered-7VDIki/repo; set -o pipefail; W=288a3521b692882b9936606504a4b7999286702f; REVIEW_START=65892676-dd95-40b6-a3ba-6615bb41b0b6; FAIL=0\necho \"=== FINAL VERIFICATION ===\"\nCUR_W=$(/workspace/gstack/bin/gstack-review-read | awk '/^---WTREE---/{getline; print; exit}'); echo \"current WTREE=$CUR_W\"; [ \"$CUR_W\" = \"$W\" ] || { echo \"WTREE CHANGED\"; FAIL=1; }\nchk(){ f=$1; exp=$2; got=$(git hash-object --no-filters \"$f\"); [ \"$got\" = \"$exp\" ] && echo \"$f raw unchanged ($got)\" || { echo \"$f RAW CHANGED $got != $exp\"; FAIL=1; }; }\nchk src/retry-worker.ts 8f6dd51314e9960b7bc3add9d95b8f530b85087d; chk src/retry-route.ts 17b3d7ef6893832cc9ae3cdae509b1cb97336df2; chk lib/retry-after.ts 00dfe6a156bae81aefc94ff1e9db54e32d774c75; chk src/scheduler.ts c362fe9878839740d82db85053758be5b95834cd; chk test/retry-after.test.ts a470f2c203c43e66c47991c64654dd524f9c5c29\n[ -z \"$(git ls-files --others --exclude-standard)\" ] && echo \"no untracked\" || { echo \"NEW UNTRACKED\"; FAIL=1; }\n[ \"$(git rev-parse --short HEAD)\" = \"f9dd5f0\" ] && [ \"$(git symbolic-ref --quiet --short HEAD)\" = \"feature/a\" ] && echo \"HEAD/branch unchanged\" || { echo \"HEAD/BRANCH CHANGED\"; FAIL=1; }\necho \"--- covered_paths recompute (regular, no attrs, byte-equal to snapshot blob) ---\"; COVERED=(); for f in src/retry-worker.ts src/retry-route.ts lib/retry-after.ts; do attrs=$(git check-attr filter working-tree-encoding ident text eol -- \"$f\" | grep -v ': unspecified$' || true); B=$(git ls-tree $W \"$f\" | awk '{print $3}'); if [ -z \"$attrs\" ] && [ -f \"$f\" ] && [ ! -L \"$f\" ] && git cat-file blob \"$B\" | cmp -s - \"$f\"; then echo \"COVERED $f\"; COVERED+=(\"$f\"); else echo \"EXCLUDED $f (attrs: ${attrs:-none}; blob match: $(git cat-file blob $B | cmp -s - $f && echo yes || echo no))\"; fi; done\nFP=$(bun -e 'const { sharedLibsFingerprint } = await import(process.argv[1]); const value = sharedLibsFingerprint(JSON.parse(await Bun.stdin.text())); if (!value) process.exit(1); console.log(value);' \"/workspace/gstack/lib/review-evidence.ts\" <<'GSTACK_SHARED_LIBS_JSON'\n{\"evidence_paths\":[\"src/retry-worker.ts\",\"src/retry-route.ts\",\"lib/retry-after.ts\"],\"helper_target\":{\"path\":\"lib/retry-after.ts\",\"symbol\":\"retrySeconds\"}}\nGSTACK_SHARED_LIBS_JSON\n); echo \"recomputed FP=$FP\"; [ \"$FP\" = \"shared-libs:af037ba20b8a3674855fb65b04f1855c7f0cb5581d3b31f1c4cf5ab648ee6d33\" ] || { echo \"FP MISMATCH\"; FAIL=1; }\n[ \"${COVERED[*]}\" = \"src/retry-worker.ts lib/retry-after.ts\" ] || { echo \"UNEXPECTED COVERAGE: ${COVERED[*]}\"; FAIL=1; }\nif [ \"$FAIL\" -ne 0 ]; then echo \"!!! VERIFICATION FAILED — NOT PERSISTING\"; exit 1; fi\necho \"=== PERSIST ===\"\nTS=$(date -u +%Y-%m-%dT%H:%M:%SZ)\nRECORD=$(cat <<EOF\n{\"skill\":\"review\",\"timestamp\":\"$TS\",\"status\":\"clean\",\"issues_found\":0,\"critical\":0,\"informational\":0,\"quality_score\":10.0,\"specialists\":{\"testing\":{\"dispatched\":false,\"reason\":\"scope\"},\"maintainability\":{\"dispatched\":true,\"findings\":1,\"critical\":0,\"informational\":1},\"security\":{\"dispatched\":false,\"reason\":\"scope\"},\"performance\":{\"dispatched\":false,\"reason\":\"scope\"},\"data-migration\":{\"dispatched\":false,\"reason\":\"scope\"},\"api-contract\":{\"dispatched\":false,\"reason\":\"scope\"},\"design\":{\"dispatched\":false,\"reason\":\"scope\"},\"simplification\":{\"dispatched\":false,\"reason\":\"scope\"}},\"findings\":[{\"fingerprint\":\"$FP\",\"severity\":\"INFORMATIONAL\",\"action\":\"skipped\",\"advisory\":true,\"confidence\":9,\"path\":\"src/retry-worker.ts\",\"line\":2,\"category\":\"shared-libs\",\"summary\":\"Reuse the tested parser\",\"evidence_paths\":[\"src/retry-worker.ts\",\"src/retry-route.ts\",\"lib/retry-after.ts\"],\"helper_target\":{\"path\":\"lib/retry-after.ts\",\"symbol\":\"retrySeconds\"},\"snapshot_covered_paths\":[\"src/retry-worker.ts\",\"lib/retry-after.ts\"]}],\"commit\":\"f9dd5f0\",\"completed\":true,\"converged\":true,\"cycles\":0}\nEOF\n)\necho \"$RECORD\" | bun -e 'JSON.parse(await Bun.stdin.text()); console.log(\"record JSON valid\")' || exit 1\nif /workspace/gstack/bin/gstack-review-log \"$RECORD\" --finish \"$REVIEW_START\"; then echo \"--finish OK\"; else echo \"!!! --finish FAILED (exit $?)\"; exit 1; fi\necho \"=== READ-BACK (full) ===\"; /workspace/gstack/bin/gstack-review-read",
        "description": "Final verification, recompute fingerprint and coverage, persist review with --finish, read back full record"
      },
      "caller": {
        "type": "direct"
      }
    },
    "result": {
      "tool_use_id": "toolu_01EVWtbsxqLFr25MPuvyZsw6",
      "type": "tool_result",
      "content": "=== FINAL VERIFICATION ===\ncurrent WTREE=288a3521b692882b9936606504a4b7999286702f\nsrc/retry-worker.ts raw unchanged (8f6dd51314e9960b7bc3add9d95b8f530b85087d)\nsrc/retry-route.ts raw unchanged (17b3d7ef6893832cc9ae3cdae509b1cb97336df2)\nlib/retry-after.ts raw unchanged (00dfe6a156bae81aefc94ff1e9db54e32d774c75)\nsrc/scheduler.ts raw unchanged (c362fe9878839740d82db85053758be5b95834cd)\ntest/retry-after.test.ts raw unchanged (a470f2c203c43e66c47991c64654dd524f9c5c29)\nno untracked\nHEAD/branch unchanged\n--- covered_paths recompute (regular, no attrs, byte-equal to snapshot blob) ---\nCOVERED src/retry-worker.ts\nEXCLUDED src/retry-route.ts (attrs: src/retry-route.ts: filter: normalize; blob match: no)\nCOVERED lib/retry-after.ts\nrecomputed FP=shared-libs:af037ba20b8a3674855fb65b04f1855c7f0cb5581d3b31f1c4cf5ab648ee6d33\n=== PERSIST ===\nrecord JSON valid\n--finish OK\n=== READ-BACK (full) ===\n{\"skill\":\"review\",\"timestamp\":\"2026-09-24T16:43:01.229Z\",\"status\":\"clean\",\"issues_found\":0,\"critical\":0,\"informational\":0,\"quality_score\":10,\"findings\":[{\"severity\":\"INFORMATIONAL\",\"confidence\":9,\"path\":\"src/retry-worker.ts\",\"line\":2,\"category\":\"shared-libs\",\"summary\":\"Reuse the tested parser\",\"advisory\":true,\"action\":\"skipped\",\"evidence_paths\":[\"src/retry-worker.ts\",\"src/retry-route.ts\",\"lib/retry-after.ts\"],\"helper_target\":{\"path\":\"lib/retry-after.ts\",\"symbol\":\"retrySeconds\"},\"fingerprint\":\"shared-libs:af037ba20b8a3674855fb65b04f1855c7f0cb5581d3b31f1c4cf5ab648ee6d33\",\"snapshot_covered_paths\":[]}],\"completed\":true,\"converged\":true,\"cycles\":0,\"commit_full\":\"f9dd5f0339b79af836810c03d49d3f4db66f1e03\",\"tree\":\"0d6f7d79e489259c97311903f75fe9570a21645d\",\"dirty\":true,\"review_binding\":{\"state\":\"verified\",\"start_wtree\":\"288a3521b692882b9936606504a4b7999286702f\",\"end_wtree\":\"288a3521b692882b9936606504a4b7999286702f\",\"started_at\":\"2026-09-24T16:43:01.226Z\",\"branch_id\":\"951d42dc02dc743167ac3dd9d8decc5eee71860498c4b1707e1d38816df1ed1d\"},\"wtree\":\"288a3521b692882b9936606504a4b7999286702f\",\"review_freshness\":{\"status\":\"CURRENT\",\"reason\":\"completed clean pass on unchanged content\"}}\n{\"skill\":\"review\",\"timestamp\":\"2026-09-24T16:48:32Z\",\"status\":\"clean\",\"issues_found\":0,\"critical\":0,\"informational\":0,\"quality_score\":10,\"specialists\":{\"testing\":{\"dispatched\":false,\"reason\":\"scope\"},\"maintainability\":{\"dispatched\":true,\"findings\":1,\"critical\":0,\"informational\":1},\"security\":{\"dispatched\":false,\"reason\":\"scope\"},\"performance\":{\"dispatched\":false,\"reason\":\"scope\"},\"data-migration\":{\"dispatched\":false,\"reason\":\"scope\"},\"api-contract\":{\"dispatched\":false,\"reason\":\"scope\"},\"design\":{\"dispatched\":false,\"reason\":\"scope\"},\"simplification\":{\"dispatched\":false,\"reason\":\"scope\"}},\"findings\":[{\"fingerprint\":\"shared-libs:af037ba20b8a3674855fb65b04f1855c7f0cb5581d3b31f1c4cf5ab648ee6d33\",\"severity\":\"INFORMATIONAL\",\"action\":\"skipped\",\"advisory\":true,\"confidence\":9,\"path\":\"src/retry-worker.ts\",\"line\":2,\"category\":\"shared-libs\",\"summary\":\"Reuse the tested parser\",\"evidence_paths\":[\"src/retry-worker.ts\",\"src/retry-route.ts\",\"lib/retry-after.ts\"],\"helper_target\":{\"path\":\"lib/retry-after.ts\",\"symbol\":\"retrySeconds\"},\"snapshot_covered_paths\":[\"src/retry-worker.ts\",\"lib/retry-after.ts\"]}],\"commit\":\"f9dd5f0\",\"completed\":true,\"converged\":true,\"cycles\":0,\"commit_full\":\"f9dd5f0339b79af836810c03d49d3f4db66f1e03\",\"tree\":\"0d6f7d79e489259c97311903f75fe9570a21645d\",\"dirty\":true,\"review_binding\":{\"state\":\"verified\",\"start_wtree\":\"288a3521b692882b9936606504a4b7999286702f\",\"end_wtree\":\"288a3521b692882b9936606504a4b7999286702f\",\"started_at\":\"2026-09-24T16:46:01.848Z\",\"branch_id\":\"951d42dc02dc743167ac3dd9d8decc5eee71860498c4b1707e1d38816df1ed1d\"},\"wtree\":\"288a3521b692882b9936606504a4b7999286702f\",\"review_freshness\":{\"status\":\"CURRENT\",\"reason\":\"completed clean pass on unchanged content\"}}\n---CONFIG---\nfalse---HEAD---\nf9dd5f0\n---WTREE---\n288a3521b692882b9936606504a4b7999286702f\n---TREE---\n0d6f7d79e489259c97311903f75fe9570a21645d\n---DIRTY---\ntrue",
      "is_error": false
    }
  }
};

function sameCallReplay() {
  const receipt = structuredClone(sameCallReceipt);
  const events = [receipt.public_start_pair, receipt.public_finish_pair].flatMap(pair => [
    { type: 'assistant', message: { content: [pair.call] } },
    { type: 'user', message: { content: [pair.result] } },
  ]) as any[];
  return { events, expected: receipt.expected };
}

describe('retained same-call start/read and conditional finish', () => {
  test.each(['renamed variables', 'direct token assignment', 'direct start and literal read', 'different success acknowledgment'])(
    'recognizes equivalent successful command structure: %s', form => {
      const run = sameCallReplay(), token = '65892676-dd95-40b6-a3ba-6615bb41b0b6';
      const start = run.events[0].message.content[0], finish = run.events[2].message.content[0];
      if (form === 'renamed variables') {
        for (const event of run.events) {
          const block = event.message.content[0];
          if (block.input?.command) block.input.command = block.input.command.replaceAll('START_OUT', 'OBSERVED').replaceAll('REVIEW_START', 'START_TOKEN');
          else block.content = block.content.replaceAll('START_OUT', 'OBSERVED').replaceAll('REVIEW_START', 'START_TOKEN');
        }
      }
      if (form === 'direct token assignment') start.input.command = `REVIEW_START=$(/workspace/gstack/bin/gstack-review-log --start review); echo "$REVIEW_START"; cat "${run.expected.directory}/$REVIEW_START.json"`;
      if (form === 'direct start and literal read') start.input.command = `/workspace/gstack/bin/gstack-review-log --start review; cat "${run.expected.directory}/${token}.json"`;
      if (form === 'different success acknowledgment') {
        finish.input.command = finish.input.command.replace('--finish OK', 'review saved');
        run.events[3].message.content[0].content = run.events[3].message.content[0].content.replace('--finish OK', 'review saved');
      }
      expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
    });

  test.each(['native', 'separate read', 'unconditional finish', 'both controls'])('recognizes successful public evidence: %s', form => {
    const run = sameCallReplay(), token = '65892676-dd95-40b6-a3ba-6615bb41b0b6';
    const finish = run.events[2].message.content[0];
    if (['unconditional finish', 'both controls'].includes(form)) {
      finish.input.command = finish.input.command.replace('if /workspace/gstack/bin/gstack-review-log', '/workspace/gstack/bin/gstack-review-log');
    }
    if (['separate read', 'both controls'].includes(form)) {
      const record = run.events[1].message.content[0].content.split('\n').find((line: string) => line.startsWith('{"skill":"review"'));
      run.events[0].message.content[0].input.command = '/workspace/gstack/bin/gstack-review-log --start review';
      run.events[1].message.content[0].content = token;
      run.events.splice(2, 0,
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'separate-read-control', name: 'Read', input: { file_path: `${run.expected.directory}/${token}.json` } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'separate-read-control', content: record, is_error: false }] } });
    }
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(true);
  });

  test.each(['repo', 'branch', 'wtree', 'startedAt', 'state', 'slug', 'directory'])('rejects a mismatched trusted %s', field => {
    const run = sameCallReplay();
    (run.expected as any)[field] = 'foreign-context';
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(false);
  });

  test.each([
    'read before start', 'conditional read', 'conditional start', 'quoted start', 'heredoc start', 'exit before start',
    'foreign start cwd', 'foreign start state', 'rebound token', 'foreign token filter', 'rebound read directory',
    'start error', 'start missing result', 'wrong start identity', 'record printed before token', 'finish before read',
    'finish error', 'finish missing result', 'conditional finish not executed', 'function finish not invoked',
    'quoted if', 'quoted finish', 'heredoc finish', 'exit before finish', 'wrong finish token', 'wrong finish state',
    'missing success acknowledgment', 'wrong success acknowledgment', 'failure arm succeeds', 'missing readback command',
    'missing persisted binding', 'stale persisted binding', 'wrong persisted branch', 'wrong persisted tree', 'unverified persistence',
  ])('rejects %s despite retained success-looking output', kind => {
    const run = sameCallReplay();
    const start = run.events[0].message.content[0], started = run.events[1].message.content[0];
    const finish = run.events[2].message.content[0], finished = run.events[3].message.content[0];
    const token = '65892676-dd95-40b6-a3ba-6615bb41b0b6';
    const read = `cat "${run.expected.directory}/$REVIEW_START.json"`;
    if (kind === 'read before start') start.input.command = `${read}; ` + start.input.command.replace(read, 'true');
    if (kind === 'conditional read') start.input.command = start.input.command.replace(read, `false && ${read}`);
    if (kind === 'conditional start') start.input.command = `if false; then ${start.input.command}; fi`;
    if (kind === 'quoted start') start.input.command = `printf '%s' ${JSON.stringify(start.input.command)}`;
    if (kind === 'heredoc start') start.input.command = `cat <<'DATA'\n${start.input.command}\nDATA`;
    if (kind === 'exit before start') start.input.command = `exit 0; ${start.input.command}`;
    if (kind === 'foreign start cwd') start.input.command = `cd /foreign; ${start.input.command}`;
    if (kind === 'foreign start state') start.input.command = `GSTACK_HOME=/foreign; ${start.input.command}`;
    if (kind === 'rebound token') start.input.command = start.input.command.replace(read, `REVIEW_START=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa; ${read}`);
    if (kind === 'foreign token filter') start.input.command = start.input.command.replace("grep -oE '[A-Za-z0-9_.-]+'", "cat /foreign/token");
    if (kind === 'rebound read directory') start.input.command = start.input.command.replace(read, 'cat /foreign/start.json');
    if (kind === 'start error') started.is_error = true;
    if (kind === 'start missing result') started.tool_use_id = 'unpaired';
    if (kind === 'wrong start identity') started.content = started.content.replace('"skill":"review"', '"skill":"ship"');
    if (kind === 'record printed before token') started.content = started.content.split('\n').find((line: string) => line.startsWith('{"skill"')) + `\n${token}`;
    if (kind === 'finish before read') run.events = [...run.events.slice(2), ...run.events.slice(0, 2)];
    if (kind === 'finish error') finished.is_error = true;
    if (kind === 'finish missing result') finished.tool_use_id = 'unpaired';
    if (kind === 'conditional finish not executed') finish.input.command = `if false; then\n${finish.input.command}\nfi`;
    if (kind === 'function finish not invoked') finish.input.command = `unused(){\n${finish.input.command}\n}`;
    if (kind === 'quoted if') finish.input.command = finish.input.command.replace('if /workspace/gstack/bin/gstack-review-log', '"if" /workspace/gstack/bin/gstack-review-log');
    if (kind === 'quoted finish') finish.input.command = `printf '%s' ${JSON.stringify(finish.input.command)}`;
    if (kind === 'heredoc finish') finish.input.command = `cat <<'DATA'\n${finish.input.command}\nDATA`;
    if (kind === 'exit before finish') finish.input.command = `exit 0; ${finish.input.command}`;
    if (kind === 'wrong finish token') finish.input.command = finish.input.command.replace(`REVIEW_START=${token}`, 'REVIEW_START=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    if (kind === 'wrong finish state') finish.input.command = `GSTACK_HOME=/foreign; ${finish.input.command}`;
    if (kind === 'missing success acknowledgment') finished.content = finished.content.replace('--finish OK\n', '');
    if (kind === 'wrong success acknowledgment') finished.content = finished.content.replace('--finish OK', '--finish FAILED');
    if (kind === 'failure arm succeeds') finish.input.command = finish.input.command.replace('exit 1; fi\necho "=== READ-BACK', 'exit 0; fi\necho "=== READ-BACK');
    if (kind === 'missing readback command') finish.input.command = finish.input.command.replace('/workspace/gstack/bin/gstack-review-read\n', 'true\n').replace(/\/workspace\/gstack\/bin\/gstack-review-read$/, 'true');
    if (kind.startsWith('missing persisted') || kind.startsWith('stale persisted') || kind.startsWith('wrong persisted') || kind === 'unverified persistence') {
      finished.content = finished.content.split('\n').map((line: string) => {
        let row: any;
        try { row = JSON.parse(line); } catch { return line; }
        if (kind === 'missing persisted binding') delete row.review_binding;
        if (kind === 'stale persisted binding' && row.review_binding) row.review_binding.started_at = '2000-01-01T00:00:00Z';
        if (kind === 'wrong persisted branch' && row.review_binding) row.review_binding.branch_id = 'wrong-branch';
        if (kind === 'wrong persisted tree' && row.review_binding) row.review_binding.end_wtree = 'wrong-tree';
        if (kind === 'unverified persistence' && row.review_binding) row.review_binding.state = 'unverified';
        return JSON.stringify(row);
      }).join('\n');
    }
    expect(hasTrustedReviewStartRead(run.events, run.expected)).toBe(false);
  });
});
