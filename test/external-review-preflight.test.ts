import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('external review preflight', () => {
  test('Claude auth treats inaccessible credentials as unknown, not logged out', () => {
    const template = read('claude/SKILL.md.tmpl');

    expect(template).toContain('echo "AUTH_UNKNOWN: cli_exit=$_CLAUDE_AUTH_EXIT"');
    expect(template).toContain('do not report that authentication is missing');
    expect(template).toContain('request narrowly scoped host credential/network access');
    expect(template).toContain('Never turn an access failure into a logout');
  });

  test('standalone Claude and Codex wrappers require provider-specific export consent', () => {
    const claude = read('claude/SKILL.md.tmpl');
    const codex = read('codex/SKILL.md.tmpl');

    expect(claude).toContain('External Data Authorization Boundary');
    expect(claude).toContain('Anthropic Claude');
    expect(claude).toContain('generic request for an "independent review"');

    expect(codex).toContain('External data authorization');
    expect(codex).toContain('OpenAI Codex model');
    expect(codex).toContain('generic request for an "independent review"');
  });

  test('automatic Codex review callers share the same export-consent gate', () => {
    const constants = read('scripts/resolvers/constants.ts');

    expect(constants).toContain('local provider/configuration preflight first');
    expect(constants).toContain('codex_reviews=enabled');
    expect(constants).toContain('do not read or assemble the provider payload yet');
    expect(constants).toContain('Never infer consent from another provider');
    expect(constants).toContain('Only after authorization is');
  });

  test('design Codex callers also use the shared export-consent gate', () => {
    const design = read('scripts/resolvers/design.ts');

    expect(design).toContain("codexExportAuthorization('the design diff and necessary source context')");
    expect(design).toContain("'the design plan, design artifacts, and necessary source context'");
    expect(design).not.toContain('Outside voices run automatically when Codex is available. No opt-in needed.');
  });

  test('GitHub and Greptile access failures remain unverified rather than clean', () => {
    const triage = read('review/greptile-triage.md');

    expect(triage).toContain('GitHub authentication unverified');
    expect(triage).toContain('Repeat only `gh auth status` with host');
    expect(triage).toContain('do not turn an access failure into a clean zero-comment result');
  });

  test('Codex review assets resolve from GSTACK_ROOT and include triage data', () => {
    const host = read('hosts/codex.ts');

    expect(host).toContain("{ from: '.claude/skills/review', to: '$GSTACK_ROOT/review' }");
    expect(host).toContain("'design-checklist.md'");
    expect(host).toContain("'greptile-triage.md'");
    expect(host).toContain("'TODOS-format.md'");
  });
});
