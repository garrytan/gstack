/** INV-1: every gate reason code users can see has a section in docs/troubleshooting.md. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GATE_OUTCOMES, gateOutcomeLine, type GateReason } from '../lib/gate-outcomes';
import { RESULT_CODES, resultLine } from '../lib/result-codes';

const ROOT = path.resolve(import.meta.dir, '..');
const doc = fs.readFileSync(path.join(ROOT, 'docs/troubleshooting.md'), 'utf8');
const anchors = new Set([...doc.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)].map(m => m[1]));

describe('docs/troubleshooting.md anchors', () => {
  for (const [code, outcome] of Object.entries(GATE_OUTCOMES)) {
    test(`${code} → #${outcome.anchor}`, () => {
      expect(anchors.has(outcome.anchor)).toBe(true);
      // The anchor introduces a section: the next line is its heading.
      const after = doc.slice(doc.indexOf(`<a id="${outcome.anchor}"></a>`)).split('\n')[1] ?? '';
      expect(after).toMatch(/^#{2,4} /);
    });
  }

  // B0: lib/result-codes.ts is the sibling table for the unattended workflow
  // commands; its codes are an enumerated list (ARTIFACT_* spelled out, never
  // a wildcard) and each has a section here, same rule as the gate outcomes.
  for (const [code, row] of Object.entries(RESULT_CODES)) {
    test(`result code ${code} → #${row.anchor}`, () => {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(anchors.has(row.anchor)).toBe(true);
      const after = doc.slice(doc.indexOf(`<a id="${row.anchor}"></a>`)).split('\n')[1] ?? '';
      expect(after).toMatch(/^#{2,4} /);
    });
  }

  test('anchors are unique and every outcome has a fix action', () => {
    const all = [...doc.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)].map(m => m[1]);
    expect(new Set(all).size).toBe(all.length);
    const codes = [...Object.values(GATE_OUTCOMES), ...Object.values(RESULT_CODES)].map(o => o.anchor);
    expect(new Set(codes).size).toBe(codes.length);
    for (const outcome of Object.values(GATE_OUTCOMES)) expect(outcome.fix.trim().length).toBeGreaterThan(0);
    for (const row of Object.values(RESULT_CODES)) expect(row.fix.trim().length).toBeGreaterThan(0);
  });

  test('result lines end with the code in parentheses and carry a fix clause', () => {
    expect(resultLine('gstack-artifact validate', 'ARTIFACT_STALE', 'findings.jsonl'))
      .toMatch(/^gstack-artifact validate: .+ \(findings\.jsonl\); fix: .+ \(ARTIFACT_STALE\)$/);
    expect(resultLine('review-log', 'REVIEW_STATUS_MISMATCH')).toMatch(/; fix: .+ \(REVIEW_STATUS_MISMATCH\)$/);
  });

  test('every docs/troubleshooting.md#anchor that setup or a bin script prints exists', () => {
    const sources = ['setup', ...fs.readdirSync(path.join(ROOT, 'bin')).map(f => `bin/${f}`)]
      .filter(f => fs.statSync(path.join(ROOT, f)).isFile());
    const linked = sources.flatMap(f => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/troubleshooting\.md#([a-z0-9-]+)/g)]
      .map(m => `${f} -> #${m[1]}`));
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.filter(l => !anchors.has(l.split('#')[1]!))).toEqual([]);
  });

  // CEO-7 / ENG-15: messages print relative links or full GitHub URLs; both
  // resolve against the docs in this working tree, so a new anchor never fails
  // before it reaches main.
  test('every docs/<guide>.md#anchor linked from shipped code (relative or full URL) exists in the working tree', () => {
    const roots = ['setup', 'bin', 'lib', 'browse/src', 'autoplan/bin', 'scripts/resolvers', 'hosts'];
    const files = roots.flatMap(function walk(rel: string): string[] {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) return [];
      if (fs.statSync(full).isFile()) return [rel];
      return fs.readdirSync(full).filter(f => f !== 'node_modules').flatMap(f => walk(path.join(rel, f)));
    });
    const docAnchors = (doc: string) => {
      const text = fs.readFileSync(path.join(ROOT, 'docs', doc), 'utf8');
      return new Set([...text.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)].map(m => m[1]));
    };
    const cache = new Map<string, Set<string | undefined>>();
    const missing: string[] = [];
    let linked = 0;
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of text.matchAll(/(?:https:\/\/github\.com\/garrytan\/gstack\/blob\/main\/)?docs\/((?:troubleshooting|autoplan-guard-troubleshooting)\.md)#([a-z0-9-]+)/g)) {
        linked++;
        if (!cache.has(m[1]!)) cache.set(m[1]!, docAnchors(m[1]!));
        if (!cache.get(m[1]!)!.has(m[2]!)) missing.push(`${file} -> ${m[1]}#${m[2]}`);
      }
    }
    expect(linked).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });

  test('outcome lines follow the not run / unavailable / unverified shapes', () => {
    const line = (code: GateReason, detail?: string) => gateOutcomeLine('Codex outside review', code, detail);
    expect(line('disabled')).toBe('Codex outside review: not run (outside reviews are turned off (codex_reviews=disabled)). Fix: gstack-config set codex_reviews enabled.');
    expect(line('sandbox_unavailable', 'bwrap: No permissions to create new namespace'))
      .toBe("Codex outside review unavailable: Codex's sandbox could not start here (bwrap: No permissions to create new namespace). No review ran; this is missing coverage, not a pass. Fix: enable unprivileged user namespaces for this container, or set GSTACK_CODEX_NO_SANDBOX=1.");
    expect(line('untagged_review')).toMatch(/^Codex outside review: ran, verdict unverified \(.+\)\. Fix: read the output above/);
  });
});
