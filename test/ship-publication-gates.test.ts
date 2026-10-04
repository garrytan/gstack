import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectMentions } from './helpers/prompt-structure';

const template = readFileSync(new URL('../ship/sections/pr-body.md.tmpl', import.meta.url), 'utf8');
const scanner = resolve(import.meta.dir, '../bin/gstack-redact');

for (const failure of ['none', 'body', 'title'] as const) {
  test(`publication scan consumes the real scanner result: ${failure}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ship-scan-'));
    try {
      const bin = join(root, '.claude/skills/gstack/bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'gstack-config'), '#!/bin/sh\nprintf "private\\n"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'gstack-redact'), `#!/bin/sh
kind=title
case "$*" in *--from-file*) kind=body ;; esac
printf '%s\\n' "$kind" >> "$HOME/scans"
if [ "$kind" = "$FAIL_AT" ]; then
  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scanner)} --from-file "$HOME/missing-input" --json
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scanner)} "$@"
`, { mode: 0o755 });
      const block = template.match(/```bash\n(: "\$\{NEW_TITLE:[\s\S]*?)\n```/)?.[1];
      expect(block).toBeDefined();
      writeFileSync(join(root, 'section.md'), '**Status:** current — no edits.');
      const result = Bun.spawnSync(['bash', '-c', block!], {
        cwd: root,
        env: { ...process.env, HOME: root, NEW_TITLE: 'v1.2.3.4 fix: publication checks', FAIL_AT: failure,
          DOCS_SECTION_FILE: join(root, 'section.md') },
        stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      });
      const output = result.stdout.toString();
      const error = result.stderr.toString();
      const calls = readFileSync(join(root, 'scans'), 'utf8').trim().split('\n');
      if (failure === 'none') {
        expect(result.exitCode).toBe(0);
        expect(calls).toEqual(['body', 'title']);
        expect(output).toContain('"HIGH": 0');
      } else {
        expect(result.exitCode).toBe(1);
        expect(error).toContain('missing-input');
        expect(calls).toEqual(failure === 'body' ? ['body'] : ['body', 'title']);
        if (failure === 'body') expect(output).toContain('BLOCKED');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('publication composes the saved documentation section unchanged and refuses to scan without it', () => {
  const block = template.match(/```bash\n(: "\$\{NEW_TITLE:[\s\S]*?)\n```/)?.[1]!;
  const compose = block.slice(block.indexOf('PR_BODY_FILE=$(mktemp'), block.indexOf('~/.claude/skills/gstack/bin/gstack-redact --from-file'));
  const root = mkdtempSync(join(tmpdir(), 'ship-compose-'));
  try {
    const section = '**Status:** current — no edits.\n\n- Diagram drift: none (no diagrams in any doc).';
    writeFileSync(join(root, 'section.md'), section);
    const run = (file: string) => Bun.spawnSync(['bash', '-c', `${compose}cat -- "$PR_BODY_FILE"`], {
      cwd: root, env: { ...process.env, HOME: root, DOCS_SECTION_FILE: file }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    const composed = run(join(root, 'section.md'));
    expect(composed.exitCode).toBe(0);
    expect(composed.stdout.toString()).toContain(`## Documentation" heading line>\n${section}\n<rest of the PR body`);
    const missing = run(join(root, 'absent.md'));
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout.toString()).toBe('');
    const unset = Bun.spawnSync(['bash', '-c', block], {
      cwd: root, env: { ...process.env, HOME: root, NEW_TITLE: 'v1.2.3.4 fix: publication checks', DOCS_SECTION_FILE: '' },
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
  expectMentions(lookup.replace(/\s+/g, ' '), [['before', 'publishing', 'redaction']], 'lookup.replace(/\s+/g,  )');
  expect(lookup).not.toContain('Ship control flow');
  expect(lookup).not.toContain('|| echo "NO_PR"');
  expect(lookup).not.toContain('|| echo "NO_MR"');
  expectMentions(template, [['blocks', 'error', 'exit']], 'template');
  expect(template).toContain('public-strict policy');
});
