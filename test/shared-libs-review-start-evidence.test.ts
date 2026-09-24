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
