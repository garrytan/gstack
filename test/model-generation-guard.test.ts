import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { newestModel } from '../lib/model-families';
import { MODEL_CATALOG } from '../lib/model-catalog';
import { CLAUDE_CAPTURE_EVAL_MODEL, CLAUDE_JUDGE_EVAL_MODEL } from '../lib/eval-model';
import { CYBER_RETRIES } from '../lib/review-pass';
import { CODEX_FRONTIER_MODEL } from '../scripts/resolvers/constants';
import { resolveCodexRuntimeModel } from '../scripts/resolve-codex-generation-model';

/**
 * Garry, 2026-11-24: "gstack should always be using latest astra, sol, fable or opus".
 * Runtime code and agent-loaded prose name only the newest model of those four families
 * (lib/model-families.ts). History, frozen eval records and tests are out of scope;
 * ALLOWED names each runtime file that must still recognize an older id, and why.
 */
const ROOT = path.resolve(import.meta.dir, '..');
const NEWEST: Record<string, string> = { opus: newestModel('opus'), fable: newestModel('fable'), sol: newestModel('sol'), astra: newestModel('astra') };
const FAMILY_ID = /\b(?:claude-(opus|fable)-\d+(?:-\d{1,2})?|gpt-\d+(?:\.\d+)?-(sol|astra))(?!\w)/gi;

const HISTORY: readonly RegExp[] = [
  /(^|\/)test\//,
  /^CHANGELOG\.md$/,
  /^changelog\.d\//,
  /^docs\/designs\//,
  /^docs\/evals\//,
  /^docs\/test-audit-\d{4}-\d{2}\.md$/,
  /^TODOS\.md$/,
];

const ALLOWED: Record<string, { ids: readonly string[] | '*'; why: string }> = {
  'lib/pricing.ts': { ids: '*', why: 'prices runs on every model, older ones included; pricing is outside this rule' },
  'scripts/typecheck-test-baseline.json': { ids: '*', why: 'recorded test-code type diagnostics, not a model choice' },
  'scripts/models.ts': { ids: ['gpt-5.6-sol', 'gpt-6-astra', 'claude-opus-4-7', 'claude-fable-5', 'claude-opus-4-8'], why: 'prompt-overlay names for the model a user runs, recognized, never picked' },
  'scripts/resolvers/model-overlay.ts': { ids: ['gpt-5.6-sol'], why: 'the Sol overlay, selected only when the user runs exactly that model' },
  'scripts/resolvers/preamble/generate-completeness-section.ts': { ids: ['gpt-5.6-sol'], why: 'the Sol overlay, selected only when the user runs exactly that model' },
  'scripts/resolve-codex-generation-model.ts': { ids: ['gpt-5.6-sol'], why: 'warns a user whose Codex config names a near-miss of the Sol overlay id' },
  'setup': { ids: ['claude-opus-4-8', 'gpt-5.6-sol', 'gpt-6-astra'], why: 'overlay names and overlay examples for the model a user runs' },
  'bin/gstack-config': { ids: ['claude-opus-4-8'], why: 'overlay example for the model a user runs' },
  'docs/hosts.md': { ids: ['gpt-5.6-sol'], why: 'documents the Sol overlay a user on that model receives' },
  'docs/loadouts.md': { ids: ['gpt-6-astra', 'claude-opus-55', 'claude-opus-5-50'], why: 'the Astra overlay name, a heading anchor, and an id the model map must not match' },
  'modules/loadouts.json': { ids: ['claude-fable-5', 'gpt-6-astra', 'claude-opus-5', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'], why: 'rung globs that recognize the model a user runs, older ones included' },
  'lib/inventory.ts': { ids: ['gpt-6.1-sol'], why: 'ledger rows measured on 6.1 Sol keep it (R116: frozen plans keep their models)' },
  'docs/TESTING_INTERNALS.md': { ids: ['gpt-6.1-sol', 'claude-opus-4-7', 'gpt-6-astra', 'claude-fable-5-1', 'claude-opus-4-5'], why: 'R116 check: frozen plans and examples of refused older ids' },
  'docs/eval-models.md': { ids: ['claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'gpt-6.1-sol'], why: 'example families list, newest first, so it names older ids on purpose' },
  'docs/troubleshooting.md': { ids: ['claude-opus-5'], why: 'example of an arm identity that does not cover the newest id' },
  'eval-plan/SKILL.md.tmpl': { ids: ['claude-opus-4-5'], why: 'example of an older id the R116 check refuses' },
  'eval-plan/SKILL.md': { ids: ['claude-opus-4-5'], why: 'generated from eval-plan/SKILL.md.tmpl' },
  'docs/unattended.md': { ids: ['gpt-6.1-sol'], why: 'records which model past no-loss rounds ran on' },
  'docs/skill-routing-and-contracts.md': { ids: ['gpt-6.1-sol'], why: 'records Codex behavior observed on that model' },
  'lib/codex-rollout.ts': { ids: ['gpt-6.1-sol'], why: 'records Codex behavior observed on that model' },
  'lib/review-brief.ts': { ids: ['gpt-6.1-sol'], why: 'records a reader behavior observed on that model (GST-850)' },
  'lib/context-bill.ts': { ids: ['claude-opus-4-5'], why: 'records the tokenizer the offline divisors were fitted on' },
  'scripts/preflight-agent-sdk.ts': { ids: ['claude-opus-4-7'], why: 'preflight for the Opus 4.7 overlay harness, whose model under test is Opus 4.7' },
  'crew/scripts/measure-journal-read.ts': { ids: ['claude-opus-4-1'], why: 'a fixed journal envelope whose byte size the measurement depends on' },
  '.github/docker/Dockerfile.ci': { ids: ['claude-fable-5-1'], why: 'records why an earlier Claude CLI pin was chosen' },
};

export function olderIds(text: string): Array<{ id: string; line: number; newest: string }> {
  const found: Array<{ id: string; line: number; newest: string }> = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(FAMILY_ID)) {
      const id = m[0].toLowerCase();
      const newest = NEWEST[(m[1] ?? m[2]).toLowerCase()];
      if (id !== newest) found.push({ id, line: i + 1, newest });
    }
  });
  return found;
}

function runtimeFiles(): string[] {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\0').filter(f => f && !HISTORY.some(re => re.test(f)));
}

function readText(file: string): string | null {
  const full = path.join(ROOT, file);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 4_000_000) return null;
  const bytes = fs.readFileSync(full);
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

describe('model generations', () => {
  test('the detector flags older ids of the four families and nothing else', () => {
    const ids = (s: string) => olderIds(s).map(f => f.id);
    expect(ids('gpt-6-astra openai/gpt-6.1-sol claude-fable-5-1 claude-opus-4-7-1 claude-opus-5* gpt-5.6-sol.')).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'claude-fable-5-1', 'claude-opus-4-7', 'claude-opus-5', 'gpt-5.6-sol']);
    expect(ids(`${NEWEST.opus} ${NEWEST.fable} openai/${NEWEST.sol} ${NEWEST.astra} ${NEWEST.opus}-20261101 ${NEWEST.sol}-2026-11-01`)).toEqual([]);
    expect(ids('claude-sonnet-4-6 claude-haiku-4-5 gpt-6-luna gpt-5.4 claude-fable-* gpt-daybreak-blue-latest')).toEqual([]);
  });

  test('runtime code and agent-loaded prose name only the newest opus, fable, sol and astra', () => {
    const offenders: string[] = [];
    for (const file of runtimeFiles()) {
      const allowed = ALLOWED[file];
      if (allowed?.ids === '*') continue;
      const text = readText(file);
      if (text === null) continue;
      for (const f of olderIds(text)) {
        if (allowed?.ids.includes(f.id)) continue;
        offenders.push(`${file}:${f.line} names ${f.id}; use ${f.newest} (lib/model-families.ts)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every allowance is still needed', () => {
    const stale: string[] = [];
    for (const [file, { ids }] of Object.entries(ALLOWED)) {
      const text = readText(file);
      const present = new Set(text === null ? [] : olderIds(text).map(f => f.id));
      if (ids === '*') { if (present.size === 0) stale.push(`${file}: *`); continue; }
      for (const id of ids) if (!present.has(id)) stale.push(`${file}: ${id}`);
    }
    expect(stale).toEqual([]);
  });

  test('every default that names one of the four families reads lib/model-families.ts', () => {
    const tier = (provider: string, t: string) => MODEL_CATALOG.find(e => e.provider === provider && e.tier === t)?.model;
    expect([tier('anthropic', 'frontier'), tier('openai', 'frontier'), tier('anthropic', 'smart'), tier('openai', 'smart')]).toEqual([NEWEST.fable, NEWEST.astra, NEWEST.opus, NEWEST.sol]);
    expect([CLAUDE_CAPTURE_EVAL_MODEL, CLAUDE_JUDGE_EVAL_MODEL, CODEX_FRONTIER_MODEL]).toEqual([NEWEST.opus, NEWEST.fable, NEWEST.astra]);
    expect(CYBER_RETRIES.find(r => r.name === 'astra-read-only')?.model.model_id).toBe(`openai/${NEWEST.astra}`);
    const empty = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'gstack-gen-'));
    try {
      expect(resolveCodexRuntimeModel({ kind: 'exec', env: {}, codexHome: empty, home: empty }).model).toBe(NEWEST.astra);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
