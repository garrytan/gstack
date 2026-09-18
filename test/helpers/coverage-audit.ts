import { isDeepStrictEqual } from 'node:util';
import * as path from 'node:path';
import type { SkillTestResult } from './session-runner';

export interface CoverageFile { path: string; content: string }

function outputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

/** Require the entire nonce-bearing fixture in successful, owned tool output.
 * Shell spelling is deliberately irrelevant: cat, sed and other readers can
 * display the same bytes. A command, assistant claim or pending call is no proof.
 */
export function requireCoverageFileReads(transcript: any[], cwd: string, files: CoverageFile[]): void {
  const required = ['src/billing.ts', 'test/billing.test.ts'].map(file => path.join(cwd, file)).sort();
  if (!isDeepStrictEqual(files.map(file => file.path).sort(), required)
    || files.some(file => typeof file.content !== 'string' || !file.content.trim())) {
    throw new Error('Coverage audit: source and test expectations are required');
  }
  const inits = transcript.filter(event => event.type === 'system' && event.subtype === 'init'
    && event.parent_tool_use_id == null);
  const sessions = new Set(inits.map(event => event.session_id));
  if (sessions.size !== 1 || typeof inits[0]?.session_id !== 'string'
    || !inits.every(event => event.cwd === cwd)) throw new Error('Coverage audit: missing or conflicting native owner');
  const session = inits[0].session_id;
  const calls = new Map<string, any>();
  const results = new Map<string, any>();
  const read = new Set<string>();
  for (const event of transcript) {
    if (event.session_id !== session || event.parent_tool_use_id != null
      || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        if (calls.has(block.id) && !isDeepStrictEqual(calls.get(block.id), block)) {
          throw new Error('Coverage audit: conflicting native tool input');
        }
        calls.set(block.id, block);
      }
      if (event.type !== 'user' || block.type !== 'tool_result') continue;
      if (results.has(block.tool_use_id) && !isDeepStrictEqual(results.get(block.tool_use_id), block)) {
        throw new Error('Coverage audit: conflicting native tool result');
      }
      results.set(block.tool_use_id, block);
      if (block.is_error !== undefined && block.is_error !== false) continue;
      const call = calls.get(block.tool_use_id);
      if (!call || !['Read', 'Bash'].includes(call.name)) continue;
      const text = outputText(block.content).replace(/\r\n/g, '\n');
      // Native Read uses N→; cat -n uses N<TAB>. Preserve every content byte.
      const numbered = text.split('\n').map(line => line.replace(/^\s*\d+(?:\t|→)/, '')).join('\n');
      for (const file of files) {
        if (call.name === 'Read' && (typeof call.input?.file_path !== 'string'
          || path.resolve(cwd, call.input.file_path) !== file.path)) continue;
        if (call.name === 'Bash' && typeof call.input?.command !== 'string') continue;
        const expected = file.content.replace(/\r\n/g, '\n').trim();
        if (expected && (text.includes(expected) || numbered.includes(expected))) read.add(file.path);
      }
    }
  }
  const missing = files.filter(file => !read.has(file.path)).map(file => path.relative(cwd, file.path));
  if (missing.length) throw new Error(`Coverage audit: no successful complete file read: ${missing.join(', ')}`);
}

export function validateCoverageAudit(result: SkillTestResult, cwd: string, files: CoverageFile[]): void {
  if (result.exitReason !== 'success') throw new Error(`Coverage audit process: ${result.exitReason}`);
  if (result.browseErrors.length) throw new Error('Coverage audit reported browser errors');
  const output = result.output || '';
  const lower = output.toLowerCase();
  const hasGap = lower.includes('gap') || lower.includes('no test');
  const hasTested = /\btested\b/i.test(output) || output.includes('✓') || output.includes('★');
  const hasCoverage = lower.includes('coverage') || lower.includes('paths tested');
  if (!hasGap || !hasTested || !hasCoverage || !output.includes('processPayment') || !output.includes('refundPayment')) {
    throw new Error('Coverage audit: diagram must name both functions and show tested paths, gaps and coverage');
  }
  requireCoverageFileReads(result.transcript, cwd, files);
}
