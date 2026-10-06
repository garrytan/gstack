/**
 * CEO-12 / DX-5 / ENG-8 / ENG-14: free text never enters a shell command.
 *
 * 1. Every allowlisted identifier grammar rejects the characters that would
 *    let a value escape its quoting, and every entry is used somewhere.
 * 2. Hostile payloads run through the real generated posting blocks
 *    (Greptile replies, test-failure issues, /spec filing and archive) with
 *    stub gh/glab: the text arrives byte for byte and nothing in it runs.
 * 3. A block whose file was never written refuses with the path and the
 *    manual command, and sends nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IDENTIFIER_PLACEHOLDERS } from './helpers/placeholder-allowlist';
import { generateTestFailureTriage } from '../scripts/resolvers/preamble';
import { freeTextFileBash } from '../scripts/resolvers/free-text-file';

const ROOT = path.resolve(import.meta.dir, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-free-text-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const QUOTE_BREAKERS = ["it's", 'say "hi"', 'a`id`b', 'a$(id)b', '$HOME', 'a\\b', 'line\nline'];
const UNQUOTED_BREAKERS = ['a;b', 'a|b', 'a&b', 'a(b)', 'a<b', 'a>b', 'a?b', 'a[b]', 'a{b}', 'a!b', 'a#b'];

function bashFences(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,})(.*)$/);
    if (!open) continue;
    let end = i + 1;
    while (end < lines.length && !new RegExp(`^\\s*\`{${open[2].length},}\\s*$`).test(lines[end])) end++;
    if (open[3].trim() === 'bash') out.push(lines.slice(i + 1, end).map(l => l.slice(open[1].length)).join('\n'));
    i = end;
  }
  return out;
}
const fence = (text: string, marker: string) => {
  const found = bashFences(text).filter(f => f.includes(marker));
  if (found.length !== 1) throw new Error(`expected one fence containing ${marker}, found ${found.length}`);
  return found[0];
};

/** A git repo with stub gh/glab/gstack binaries that record what they were given. */
function sandbox(name: string) {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`));
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'log');
  const runtime = path.join(dir, 'runtime');
  for (const d of [repo, bin, log, path.join(runtime, 'bin'), path.join(dir, 'state')]) fs.mkdirSync(d, { recursive: true });
  expect(spawnSync('git', ['init', '-q'], { cwd: repo, timeout: 10_000 }).status).toBe(0);
  const stub = (file: string, body: string) => fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  stub(path.join(bin, 'gh'), `
LOG="${log}"
n=$(ls "$LOG" | wc -l | tr -d ' ')
case "$1 $2" in
  "repo view") echo o/r; exit 0 ;;
  "pr view") echo 7; exit 0 ;;
  "issue view") echo "https://github.com/o/r/issues/$3"; exit 0 ;;
esac
printf '%s\\n' "$@" > "$LOG/$n.args"
prev=""
for a in "$@"; do
  case "$a" in body=@*) cp "\${a#body=@}" "$LOG/$n.body" ;; esac
  [ "$prev" = "--body-file" ] && cp "$a" "$LOG/$n.body"
  [ "$prev" = "--title" ] && printf '%s' "$a" > "$LOG/$n.title"
  prev="$a"
done
[ "$1 $2" = "issue create" ] && echo "https://github.com/o/r/issues/42"
exit 0`);
  stub(path.join(bin, 'glab'), `
LOG="${log}"; n=$(ls "$LOG" | wc -l | tr -d ' '); prev=""
for a in "$@"; do
  [ "$prev" = "-t" ] && printf '%s' "$a" > "$LOG/$n.title"
  [ "$prev" = "-d" ] && printf '%s' "$a" > "$LOG/$n.body"
  prev="$a"
done
printf '%s\\n' "$@" > "$LOG/$n.args"`);
  stub(path.join(runtime, 'bin', 'gstack-decision-log'), `printf '%s' "$1" > "${log}/decision.json"`);
  stub(path.join(runtime, 'bin', 'gstack-paths'), `echo "${path.join(dir, 'state')}"`);
  stub(path.join(runtime, 'bin', 'gstack-slug'), 'echo proj');
  const run = (script: string) => spawnSync('bash', ['-c', script.replaceAll('~/.claude/skills/gstack', runtime)], {
    cwd: repo, encoding: 'utf8', timeout: 15_000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: path.join(dir, 'home'), TMPDIR: dir },
  });
  /** Run a create block, then do what the agent's file-write tool does: write each printed file. */
  const create = (script: string, texts: Record<string, string>) => {
    const r = run(script);
    expect(r.status, r.stderr).toBe(0);
    const names: Record<string, string> = {};
    for (const m of r.stdout.matchAll(/^([A-Z_]+_FILE): (\S+) \(name: (\S+)\)$/gm)) {
      expect(path.basename(m[2])).toBe(m[3]);
      expect(fs.statSync(m[2]).mode & 0o777).toBe(0o600);
      if (texts[m[1]] !== undefined) fs.writeFileSync(m[2], texts[m[1]]);
      names[m[1]] = m[3];
    }
    return names;
  };
  const calls = () => fs.readdirSync(log).filter(f => f.endsWith('.args')).sort().map(f => {
    const n = f.replace('.args', '');
    const read = (ext: string) => fs.existsSync(path.join(log, `${n}.${ext}`)) ? fs.readFileSync(path.join(log, `${n}.${ext}`), 'utf8') : undefined;
    return { args: fs.readFileSync(path.join(log, f), 'utf8').trim().split('\n'), body: read('body'), title: read('title') };
  });
  return { dir, repo, log, run, create, calls };
}

/** Backticks, $(...), an apostrophe, double quotes, and lines equal to common heredoc delimiters. */
function hostile(canary: string): string {
  return [
    `**Fixed** in \`touch ${canary}-backtick\`.`,
    `$(touch ${canary}-subst) and \${HOME} stay literal; it's "quoted"`,
    'EOF',
    'GSTACK_REPLY',
    'GSTACK_ISSUE',
    'REDACT_BODY_EOF',
    `'; touch ${canary}-quote; '`,
    '```diff',
    '- old',
    '+ new',
    '```',
    '',
  ].join('\n');
}
const ranAnything = (dir: string, canary: string) => fs.readdirSync(dir).concat(fs.readdirSync(path.join(dir, 'repo'))).filter(f => f.startsWith(path.basename(canary)));

describe('identifier grammars (CEO-12, ENG-8)', () => {
  for (const [placeholder, entry] of Object.entries(IDENTIFIER_PLACEHOLDERS)) {
    test(`${placeholder} rejects values that could escape its quoting`, () => {
      for (const bad of QUOTE_BREAKERS) expect(entry.grammar.test(bad), `${placeholder} accepted ${JSON.stringify(bad)}`).toBe(false);
      if (entry.quoted) return;
      for (const bad of UNQUOTED_BREAKERS) expect(entry.grammar.test(bad), `${placeholder} accepted ${JSON.stringify(bad)}`).toBe(false);
      if (!entry.list) for (const bad of ['a b', 'a\tb', 'a*b']) expect(entry.grammar.test(bad), `${placeholder} accepted ${JSON.stringify(bad)}`).toBe(false);
    });
  }

  test('git accepts branch names with shell metacharacters; the ref grammar does not, and keeps valid refs', () => {
    const ref = IDENTIFIER_PLACEHOLDERS['<branch-name>'].grammar;
    for (const name of ['fix;id', 'fix`id`', 'x;curl-evil', 'a$(id)']) {
      expect(spawnSync('git', ['check-ref-format', '--branch', name], { timeout: 10_000 }).status).toBe(0);
      expect(ref.test(name)).toBe(false);
    }
    for (const name of ['feature/foo+bar@2', 'fix/ünïcode', 'release-1.2_rc']) expect(ref.test(name)).toBe(true);
  });

  test('numeric ids are digits only', () => {
    for (const key of ['<comment-id>', '<PID>', '<run-id>', '<check-number>']) {
      expect(IDENTIFIER_PLACEHOLDERS[key].grammar.test('12345')).toBe(true);
      expect(IDENTIFIER_PLACEHOLDERS[key].grammar.test('123 4')).toBe(false);
      expect(IDENTIFIER_PLACEHOLDERS[key].grammar.test('0x1f')).toBe(false);
    }
  });
});

describe('Greptile replies through the real review/greptile-triage.md blocks', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'review/greptile-triage.md'), 'utf8');
  const createBlock = fence(doc, 'REPLY_FILE=$(mktemp');
  const lineBlock = fence(doc, 'comments/<comment-id>/replies');
  const topBlock = fence(doc, 'issues/$PR_NUMBER/comments" -F');

  test('the create block is the shared free-text block', () => {
    expect(createBlock).toBe(freeTextFileBash([{ variable: 'REPLY_FILE', stem: 'reply' }]));
  });

  test('the fetched JSON goes to a mktemp directory, not fixed /tmp paths', () => {
    expect(doc).not.toMatch(/\/tmp\/greptile_/);
    expect(fence(doc, 'GREPTILE_DIR=$(mktemp -d')).toContain('"$GREPTILE_DIR/line.json"');
  });

  for (const [kind, block, api] of [['line-level', lineBlock, 'repos/o/r/pulls/7/comments/123/replies'], ['top-level', topBlock, 'repos/o/r/issues/7/comments']] as const) {
    test(`${kind}: a hostile reply posts byte for byte and nothing in it runs`, () => {
      const s = sandbox(`greptile-${kind}`);
      const canary = path.join(s.dir, 'PWNED');
      const body = hostile(canary);
      const names = s.create(createBlock, { REPLY_FILE: body });
      const r = s.run(block.replaceAll('<reply-file-name>', names.REPLY_FILE).replaceAll('<comment-id>', '123'));
      expect(r.status, r.stderr).toBe(0);
      const [call] = s.calls();
      expect(call.args.slice(0, 2)).toEqual(['api', api]);
      expect(call.body).toBe(body);
      expect(ranAnything(s.dir, canary)).toEqual([]);
      expect(fs.readdirSync(path.join(s.repo, '.gstack/tmp'))).toEqual([]);
      expect(fs.readFileSync(path.join(s.repo, '.git/info/exclude'), 'utf8')).toContain('/.gstack/tmp/');
      expect(s.run('git status --porcelain').stdout).toBe('');
    });
  }

  test('an unwritten reply is refused with the path and the manual command; nothing is posted', () => {
    const s = sandbox('greptile-refuse');
    const names = s.create(createBlock, {});
    const r = s.run(lineBlock.replaceAll('<reply-file-name>', names.REPLY_FILE).replaceAll('<comment-id>', '123'));
    expect(r.status).toBe(1);
    const file = path.join(fs.realpathSync(s.repo), '.gstack/tmp', names.REPLY_FILE);
    expect(r.stderr).toContain(`Not sent: ${file} is missing or empty`);
    expect(r.stderr).toContain(`gh api repos/o/r/pulls/7/comments/123/replies -F body=@${file}`);
    expect(s.calls()).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('test-failure issues through the real generated triage text', () => {
  const text = generateTestFailureTriage();
  const createBlock = fence(text, 'TITLE_FILE=$(mktemp');
  const postBlock = fence(text, 'case "<platform>" in');

  test('the generated ship section carries the same text, with no literal \\n or nested triple backticks', () => {
    const section = fs.readFileSync(path.join(ROOT, 'ship/sections/tests.md'), 'utf8');
    expect(section).toContain(postBlock);
    expect(text).not.toContain('\\n\\n**Error:**');
    expect(postBlock).not.toContain('```');
    expect(text).toMatch(/\*\*Error:\*\*\n~~~\n<first 10 lines of the failure>\n~~~/);
  });

  for (const platform of ['github', 'gitlab'] as const) {
    test(`${platform}: hostile title, error output and branch name post as data`, () => {
      const s = sandbox(`issue-${platform}`);
      const canary = path.join(s.dir, 'PWNED');
      const title = `Pre-existing test failure: \`touch ${canary}-title\` $(touch ${canary}-t2) it's`;
      const body = `Failing on x;touch ${canary}-branch; pre-existing.\n\n**Error:**\n~~~\n${hostile(canary)}~~~\n`;
      const names = s.create(createBlock, { TITLE_FILE: `${title}\n`, BODY_FILE: body });
      const r = s.run(postBlock.replaceAll('<title-file-name>', names.TITLE_FILE).replaceAll('<body-file-name>', names.BODY_FILE)
        .replaceAll('<platform>', platform).replaceAll('<github-username>', 'octocat').replaceAll('<gitlab-username>', 'octo'));
      expect(r.status, r.stderr).toBe(0);
      const [call] = s.calls();
      expect(call.title).toBe(title);
      expect(call.body).toBe(platform === 'github' ? body : body.replace(/\n+$/, ''));
      expect(call.args).toContain(platform === 'github' ? 'octocat' : 'octo');
      expect(ranAnything(s.dir, canary)).toEqual([]);
      expect(fs.readdirSync(path.join(s.repo, '.gstack/tmp'))).toEqual([]);
    });
  }

  test('an unknown platform sends nothing and keeps the files', () => {
    const s = sandbox('issue-unknown');
    const names = s.create(createBlock, { TITLE_FILE: 't\n', BODY_FILE: 'b\n' });
    const r = s.run(postBlock.replaceAll('<title-file-name>', names.TITLE_FILE).replaceAll('<body-file-name>', names.BODY_FILE).replaceAll('<platform>', 'unknown'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Not sent: no GitHub or GitLab remote');
    expect(s.calls()).toEqual([]);
    expect(fs.readdirSync(path.join(s.repo, '.gstack/tmp')).length).toBe(2);
  });
});

describe('/spec filing and archive through the real generated gate-and-file text', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'spec/sections/gate-and-file.md'), 'utf8');
  const draftBlock = fence(doc, 'REDACT_FILE=$(mktemp');
  const titleBlock = fence(doc, 'TITLE_FILE=$(mktemp');
  const fileBlock = fence(doc, 'ISSUE_URL=$(gh issue create');
  const archiveBlock = fence(doc, 'ARCHIVE_PATH.tmp');

  test('hostile title, body and approach are filed and archived as literal text', () => {
    const s = sandbox('spec');
    const canary = path.join(s.dir, 'PWNED');
    const title = `Spec: \`touch ${canary}-title\` $(touch ${canary}-t2) it's`;
    const body = hostile(canary);
    const approach = `Use $(touch ${canary}-approach) "carefully"`;
    const draft = s.create(draftBlock, { REDACT_FILE: body });
    const files = s.create(titleBlock, { TITLE_FILE: `${title}\n`, APPROACH_FILE: `${approach}\n` });
    const sub = (block: string) => block.replaceAll('<redact-file-name>', draft.REDACT_FILE)
      .replaceAll('<title-file-name>', files.TITLE_FILE).replaceAll('<approach-file-name>', files.APPROACH_FILE).replaceAll('<issue-number>', '42');
    let r = s.run(sub(fileBlock));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('ISSUE_NUMBER: 42');
    const [call] = s.calls();
    expect(call.title).toBe(title);
    expect(call.body).toBe(body);
    expect(JSON.parse(fs.readFileSync(path.join(s.log, 'decision.json'), 'utf8'))).toMatchObject({ decision: `Spec filed #42: ${title}`, rationale: approach, issue: '42' });
    r = s.run(sub(archiveBlock));
    expect(r.status, r.stderr).toBe(0);
    const archived = /^Archived: (\S+)/m.exec(r.stdout)![1];
    const text = fs.readFileSync(archived, 'utf8');
    expect(text).toContain('spec_issue_number: 42\nspec_issue_url: https://github.com/o/r/issues/42\n');
    expect(text.endsWith(`---\n\n# ${title}\n\n${body}`)).toBe(true);
    expect(ranAnything(s.dir, canary)).toEqual([]);
  });

  test('a missing title file refuses filing with the manual command', () => {
    const s = sandbox('spec-refuse');
    const draft = s.create(draftBlock, { REDACT_FILE: 'body\n' });
    const files = s.create(titleBlock, {});
    const r = s.run(fileBlock.replaceAll('<redact-file-name>', draft.REDACT_FILE).replaceAll('<title-file-name>', files.TITLE_FILE).replaceAll('<approach-file-name>', files.APPROACH_FILE));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not filed:');
    expect(r.stderr).toContain('gh issue create --title "$(cat ');
    expect(s.calls()).toEqual([]);
  });
});
