/**
 * Every workflow step that runs the GitHub CLI gets a token (free).
 *
 * On a GitHub-hosted runner `gh` reads no ambient credential: a step without
 * GH_TOKEN (or GITHUB_TOKEN) in its step, job or workflow env fails at its
 * first gh call with "To use GitHub CLI in a GitHub Actions workflow, set the
 * GH_TOKEN environment variable" (exit 4). That is how promote run 39691485727
 * died after a 40-minute protected-environment approval: its candidate step
 * called `gh api …/compare` with no token. actionlint does not check this.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
/** A gh invocation at a command position, never ghcr.io, --gh or a word ending in gh. */
const GH_CALL = /(?:^|[\s;&|(`]|\$\()gh\s+[a-z]/;

/** `<file>:<job>:<step>` for every run step that calls gh with no token in scope. */
export function tokenlessGhSteps(file: string, document: any): string[] {
  const found: string[] = [];
  const hasToken = (env: any) => Boolean(env?.GH_TOKEN || env?.GITHUB_TOKEN);
  for (const [jobName, job] of Object.entries<any>(document?.jobs ?? {})) {
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      if (typeof step?.run !== 'string') continue;
      const calls = step.run.split('\n').some((line: string) => !line.trim().startsWith('#') && GH_CALL.test(line));
      if (calls && !hasToken(step.env) && !hasToken(job.env) && !hasToken(document.env)) found.push(`${file}:${jobName}:${step.name ?? index}`);
    }
  }
  return found;
}

describe('workflow gh token', () => {
  test('no workflow step runs gh without GH_TOKEN or GITHUB_TOKEN in scope', () => {
    const files = fs.readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name));
    expect(files).toContain('weekly-release.yml');
    const missing = files.flatMap(file => tokenlessGhSteps(file, Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'))));
    expect(missing).toEqual([]);
  });

  test('the scanner flags the promote run 39691485727 shape and accepts every scope that supplies a token', () => {
    const step = (env?: Record<string, string>) => ({ name: 'candidate', env, run: 'set -e\nx="$(jq -r .a f)"\ngh api "repos/$R/compare/$a...$b" > out.json' });
    expect(tokenlessGhSteps('w.yml', { jobs: { propose: { steps: [step({ QUALIFICATION_RUN: '1' })] } } })).toEqual(['w.yml:propose:candidate']);
    expect(tokenlessGhSteps('w.yml', { jobs: { propose: { steps: [step({ GH_TOKEN: '${{ github.token }}' })] } } })).toEqual([]);
    expect(tokenlessGhSteps('w.yml', { jobs: { propose: { env: { GITHUB_TOKEN: 't' }, steps: [step()] } } })).toEqual([]);
    expect(tokenlessGhSteps('w.yml', { env: { GH_TOKEN: 't' }, jobs: { propose: { steps: [step()] } } })).toEqual([]);
    for (const run of ['v="$(gh run list --json id)"', 'a && gh pr create --fill', 'gh attestation verify "oci://$i"']) {
      expect(tokenlessGhSteps('w.yml', { jobs: { j: { steps: [{ run }] } } })).toEqual(['w.yml:j:0']);
    }
    for (const run of ['docker pull ghcr.io/o/r@sha256:x', 'tool --gh api', '# gh api is called by the next step', 'echo high']) {
      expect(tokenlessGhSteps('w.yml', { jobs: { j: { steps: [{ run }] } } })).toEqual([]);
    }
  });
});
