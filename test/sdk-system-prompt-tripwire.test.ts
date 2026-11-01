/**
 * Every Agent SDK caller hands Claude Code its real system prompt, or names
 * why not. Without systemPrompt the SDK runs a bare stub that drops the "run
 * /skill via Skill" line, so a skill arm never learns to load its skill and a
 * null result means nothing (docs/TESTING_INTERNALS.md#agent-sdk-system-prompt).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CLAUDE_CODE_PRESET, sdkSystemPrompt } from './helpers/sdk-system-prompt';
import { runAgentSdkTest } from './helpers/agent-sdk-runner';

const ROOT = path.resolve(import.meta.dir, '..');
const SELF = 'test/sdk-system-prompt-tripwire.test.ts';
const DEFINERS = new Set(['test/helpers/agent-sdk-runner.ts', 'test/helpers/sdk-system-prompt.ts']);

/** Index just past the bracket that closes the one opened at text[open]. */
function closeOf(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return text.length; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '\x60') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1; }
  }
  return text.length;
}

/** Text of one property value: from after "key:" to the next top-level , } or ). */
function valueAt(text: string, start: number): string {
  let i = start;
  while (i < text.length && !',})'.includes(text[i]!)) {
    const c = text[i]!;
    if ('({['.includes(c)) { i = closeOf(text, i); continue; }
    if (c === "'" || c === '"' || c === '\x60') { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; }
    i++;
  }
  return text.slice(start, i).trim();
}

/** Why a systemPrompt value is refused, or null when it is the preset, names its reason, or forwards a caller's value. */
export function promptValueProblem(value: string): string | null {
  if (/^['"\x60]/.test(value)) return 'a bare string prompt (empty runs the SDK stub); pass CLAUDE_CODE_PRESET or name a reason';
  if (/^[\w$.?]+$/.test(value)) return null;
  const objects = [...value.matchAll(/\{[^{}]*\}/g)].map(m => m[0]);
  if (!objects.length) return null;
  for (const o of objects) {
    if (/type:\s*'preset'/.test(o) && /preset:\s*'claude_code'/.test(o)) continue;
    if (/type:\s*'(sdk-default|custom)'/.test(o) && /reason:\s*(['"\x60])\s*[^'"\x60\s][^'"\x60]*\1/.test(o)) continue;
    return 'a prompt that is neither the Claude Code preset nor a named sdk-default/custom reason';
  }
  return null;
}

/** Every refused systemPrompt and every SDK call that omits one, in one file's source. */
export function scanSource(file: string, source: string): string[] {
  const problems: string[] = [];
  const line = (i: number) => source.slice(0, i).split('\n').length;
  if (!DEFINERS.has(file)) {
    for (const m of source.matchAll(/\bsystemPrompt\s*:/g)) {
      const problem = promptValueProblem(valueAt(source, m.index! + m[0].length));
      if (problem) problems.push(file + ':' + line(m.index!) + ': ' + problem);
    }
  }
  const sdk = /import\s*\{[^}]*\bquery\b[^}]*\}\s*from\s*'@anthropic-ai\/claude-agent-sdk'|\(await import\('@anthropic-ai\/claude-agent-sdk'\)\)\.query|const\s*\{\s*query\s*\}\s*=\s*await import\('@anthropic-ai\/claude-agent-sdk'\)/.test(source);
  const calls = [...source.matchAll(/(?<![\w.])runAgentSdkTest\(/g)].map(m => m.index! + m[0].length - 1);
  if (sdk && !DEFINERS.has(file)) calls.push(...[...source.matchAll(/(?<![\w.])query\(/g)].map(m => m.index! + m[0].length - 1));
  for (const open of calls) {
    if (/function\s+runAgentSdkTest\($/.test(source.slice(Math.max(0, open - 40), open + 1))) continue;
    const arg = source.slice(open + 1, closeOf(source, open) - 1).trim();
    if (!arg.startsWith('{')) continue;
    if (/\bsystemPrompt\b|\.\.\.\s*sdkSystemPrompt\(/.test(arg)) continue;
    if (/\.\.\./.test(arg)) continue;
    problems.push(file + ':' + line(open) + ': SDK call without systemPrompt; pass CLAUDE_CODE_PRESET or name a reason');
  }
  return problems;
}

function trackedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && rel !== 'test/fixtures') walk(rel); }
      else if (/\.tsx?$/.test(entry.name) && rel !== SELF) out.push(rel);
    }
  };
  walk('test'); walk('scripts');
  return out;
}

describe('Agent SDK system prompt tripwire', () => {
  test('every runAgentSdkTest and SDK query caller passes the preset or names its reason', () => {
    const files = trackedSources();
    const problems = files.flatMap(file => scanSource(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(problems).toEqual([]);
    const callers = files.filter(file => /(?<![\w.])runAgentSdkTest\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(callers).toContain('test/helpers/ship-hook-actor.ts');
    expect(callers.length).toBeGreaterThan(10);
  });

  test('the scanner refuses a missing, empty, bare or unnamed prompt and accepts the preset, a named reason or a forward', () => {
    const scan = (body: string) => scanSource('x.ts', body);
    expect(scan("runAgentSdkTest({ userPrompt: 'go', workingDirectory: d })")).toHaveLength(1);
    expect(scan("runAgentSdkTest({ systemPrompt: '', userPrompt: 'go' })")).toHaveLength(1);
    expect(scan("runAgentSdkTest({ systemPrompt: 'be terse', userPrompt: 'go' })")).toHaveLength(1);
    expect(scan("runAgentSdkTest({ systemPrompt: { type: 'sdk-default', reason: '' }, userPrompt: 'go' })")).toHaveLength(1);
    expect(scan("import { query } from '@anthropic-ai/claude-agent-sdk';\nquery({ prompt: 'p', options: { tools: [] } })")).toHaveLength(1);
    expect(scan("runAgentSdkTest({ systemPrompt: { type: 'preset', preset: 'claude_code' }, userPrompt: 'go' })")).toEqual([]);
    expect(scan("runAgentSdkTest({ systemPrompt: a ? { type: 'preset', preset: 'claude_code', append: x } : { type: 'preset', preset: 'claude_code' } })")).toEqual([]);
    expect(scan("runAgentSdkTest({ systemPrompt: { type: 'sdk-default', reason: 'stub provider' }, userPrompt: 'go' })")).toEqual([]);
    expect(scan("runAgentSdkTest({ systemPrompt: CLAUDE_CODE_PRESET, userPrompt: 'go' })")).toEqual([]);
    expect(scan("runAgentSdkTest({ ...options, signal })")).toEqual([]);
    expect(scan("const o = { systemPrompt: options.systemPrompt };")).toEqual([]);
    expect(scan("import { query } from '@anthropic-ai/claude-agent-sdk';\nquery({ prompt: 'p', options: { ...sdkSystemPrompt({ type: 'sdk-default', reason: 'probe' }) } })")).toEqual([]);
    expect(scan("import { query } from '@anthropic-ai/claude-agent-sdk';\nquery({ ...args, options: { ...args.options, cwd } })")).toEqual([]);
  });

  test('the runner refuses a bare or unnamed prompt before it starts', async () => {
    const queryProvider = (() => { throw new Error('query must not run'); }) as never;
    for (const systemPrompt of ['', 'be terse', undefined, { type: 'sdk-default', reason: ' ' }, { type: 'custom', reason: 'x' }]) {
      await expect(runAgentSdkTest({ systemPrompt: systemPrompt as never, userPrompt: 'go', workingDirectory: ROOT, queryProvider, maxRetries: 0 }))
        .rejects.toThrow('docs/TESTING_INTERNALS.md#agent-sdk-system-prompt');
    }
    expect(sdkSystemPrompt(CLAUDE_CODE_PRESET)).toEqual({ systemPrompt: CLAUDE_CODE_PRESET });
    expect(sdkSystemPrompt({ type: 'sdk-default', reason: 'stub provider' })).toEqual({});
    expect(sdkSystemPrompt({ type: 'custom', text: 'be terse', reason: 'overlay-only arm' })).toEqual({ systemPrompt: 'be terse' });
  });
});
