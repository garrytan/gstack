/**
 * #2847: a nested gstack Codex call is a one-shot review, but Codex injects every
 * installed skill (gstack's own `review` included) into its context, and the
 * reviewer re-ran whole skill workflows inside its timeout. A read-only sandbox
 * does not stop that. Verified against codex-cli 0.152.0 and 0.160.0 with a local
 * Responses API stub: without `skills.include_instructions=false` the request
 * carried the full gstack catalog; with it, none (exec and native review alike).
 * Every gstack-owned Codex call therefore carries the isolation flag, and the
 * prompt boundary names the Codex skill roots.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CODEX_MODEL_CONFIG_FLAG, CODEX_REVIEW_MODEL_CONFIG_FLAG, CODEX_SKILLS_ISOLATION_FLAG } from '../scripts/resolvers/constants';
import { expectMentions } from './helpers/prompt-structure';

const ROOT = path.join(import.meta.dir, '..');

function renderedSkillFiles(): string[] {
  const files: string[] = [];
  const pending = [ROOT];
  const excluded = new Set(['node_modules', '.git', '.context', '.claude', 'fixtures']);
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.endsWith('.md') && !entry.name.endsWith('.tmpl')) files.push(full);
    }
  }
  return files;
}

describe('Codex skill isolation (#2847)', () => {
  test('the model flags carry the isolation flag, so every model-flag site is isolated', () => {
    expect(CODEX_SKILLS_ISOLATION_FLAG).toBe('-c skills.include_instructions=false');
    expect(CODEX_MODEL_CONFIG_FLAG).toContain(CODEX_SKILLS_ISOLATION_FLAG);
    expect(CODEX_REVIEW_MODEL_CONFIG_FLAG).toContain(CODEX_SKILLS_ISOLATION_FLAG);
  });

  test('every wrapped Codex exec/review call in generated skills disables the skill catalog', () => {
    const calls: string[] = [];
    for (const file of renderedSkillFiles()) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (/run-with-timeout\s+\d+\s+codex\s+(exec|review)\b/.test(line)) calls.push(`${path.relative(ROOT, file)}: ${line}`);
      }
    }
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter(call => !call.includes("skills.include_instructions=false"))).toEqual([]);
  });

  test('the probe round trip does not pay for the skill catalog either', () => {
    const probe = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-codex-probe'), 'utf8');
    const roundTrip = probe.split('\n').find(line => line.includes('"reply OK"'));
    expect(roundTrip).toContain("skills.include_instructions=false");
  });

  test('outside-voice and /codex prompt boundaries name the Codex skill roots and forbid skill use', () => {
    const sources = ['scripts/resolvers/outside-voice-steps.ts', ...['review-mode', 'challenge-mode', 'consult-mode'].map(m => `codex/sections/${m}.md.tmpl`)];
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const boundaries = text.split('\n').filter(line => /do not read or execute any files under/i.test(line));
      expect(boundaries.length, rel).toBeGreaterThan(0);
      for (const line of boundaries) {
        expectMentions(line, [['do not', 'installed', 'invoke']], 'line');
      }
    }
  });
});
