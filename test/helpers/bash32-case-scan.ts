/**
 * bash 3.2 (macOS /bin/bash) ends a `$( ... )` at the `)` of a case pattern
 * that has no leading `(`, so a script bash 5 parses fails to parse there
 * (#3601: gstack-doctor reported the launch probe "missing"). Linux CI runs
 * bash 5, so this finds the shape statically: a case pattern without its
 * optional leading `(` while a command or process substitution is open. It is
 * a small tokenizer, not a shell parser: quotes, `$'..'`, escapes, comments,
 * here-documents, `${..}`, `$((..))`, backquotes and nested case statements are
 * tracked; everything else is ordinary text.
 */
export interface Bash32CaseHit { line: number; text: string }

type Frame = 'comsub' | 'paren' | 'arith' | 'brace' | 'dq' | 'bq';
interface CaseState { mode: 'subject' | 'in' | 'pattern' | 'body'; depth: number }

const WORD_CHAR = /[A-Za-z0-9_-]/;

export function scanBash32CaseInSubstitution(src: string): Bash32CaseHit[] {
  const hits: Bash32CaseHit[] = [];
  const lines = src.split('\n');
  const frames: Frame[] = [];
  const cases: CaseState[] = [];
  const heredocs: { tag: string; strip: boolean }[] = [];
  let line = 1;
  let i = 0;
  const top = () => frames[frames.length - 1];
  const atWordStart = (j: number) => j === 0 || /[\s;&|()`]/.test(src[j - 1]);
  const readWord = (j: number) => { let k = j; while (k < src.length && WORD_CHAR.test(src[k])) k++; return src.slice(j, k); };
  const closeQuote = (j: number, q: string) => {
    let k = j + 1;
    while (k < src.length && src[k] !== q) { if (q === '"' && src[k] === '\\') k++; if (src[k] === '\n') line++; k++; }
    return k + 1;
  };
  const newline = () => {
    line++;
    i++;
    while (heredocs.length) {
      const { tag, strip } = heredocs.shift()!;
      while (i < src.length) {
        const end = src.indexOf('\n', i);
        const text = src.slice(i, end < 0 ? src.length : end);
        i = end < 0 ? src.length : end + 1;
        line++;
        if ((strip ? text.replace(/^\t+/, '') : text) === tag) break;
      }
    }
  };
  const skipSubject = (j: number) => {
    let k = j;
    while (k < src.length && !/\s/.test(src[k])) {
      if (src[k] === '"' || src[k] === "'") { k = closeQuote(k, src[k]); continue; }
      if (src[k] === '$' && src[k + 1] === '{') { const e = src.indexOf('}', k); k = e < 0 ? src.length : e + 1; continue; }
      if (src[k] === '\\') k++;
      k++;
    }
    return k;
  };
  /** One pattern list up to its closing `)`; a bare one inside a substitution is a hit. */
  const scanPattern = (j: number, bare: boolean) => {
    let k = bare ? j : j + 1;
    while (k < src.length) {
      const ch = src[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '"' || ch === "'") { k = closeQuote(k, ch); continue; }
      if (ch === '[') { const e = src.indexOf(']', k + 2); if (e > 0 && !src.slice(k, e).includes('\n')) { k = e + 1; continue; } }
      if (ch === '$' && src[k + 1] === '{') { const e = src.indexOf('}', k); k = e < 0 ? src.length : e + 1; continue; }
      if (ch === ')') {
        if (bare && frames.includes('comsub')) hits.push({ line, text: (lines[line - 1] ?? '').trim().slice(0, 160) });
        cases[cases.length - 1].mode = 'body';
        return k + 1;
      }
      if (ch === '\n') line++;
      k++;
    }
    return k;
  };

  while (i < src.length) {
    const c = src[i];
    const cs = cases[cases.length - 1];
    const caseHere = cs !== undefined && cs.depth === frames.length;
    if (c === '\n' && top() !== 'dq' && top() !== 'bq') { newline(); continue; }
    if (c === '\n') { line++; i++; continue; }
    if (c === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue; }
    if (caseHere && cs.mode === 'subject') {
      if (c === ' ' || c === '\t') { i++; continue; }
      i = skipSubject(i); cs.mode = 'in'; continue;
    }
    if (top() === 'dq') {
      if (c === '"') frames.pop();
      else if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') { frames.push('arith'); i += 3; continue; }
      else if (c === '$' && src[i + 1] === '(') { frames.push('comsub'); i += 2; continue; }
      else if (c === '$' && src[i + 1] === '{') { frames.push('brace'); i += 2; continue; }
      else if (c === '`') frames.push('bq');
      i++; continue;
    }
    if (c === "'") { i = closeQuote(i, "'"); continue; }
    if (c === '$' && src[i + 1] === "'") {
      let k = i + 2;
      while (k < src.length && src[k] !== "'") { if (src[k] === '\\') k++; if (src[k] === '\n') line++; k++; }
      i = k + 1; continue;
    }
    if (c === '"') { frames.push('dq'); i++; continue; }
    if (c === '`') { if (top() === 'bq') frames.pop(); else frames.push('bq'); i++; continue; }
    if (top() === 'brace') {
      if (c === '}') frames.pop();
      else if (c === '$' && src[i + 1] === '{') { frames.push('brace'); i += 2; continue; }
      i++; continue;
    }
    if (top() === 'arith') {
      if (c === ')' && src[i + 1] === ')') { frames.pop(); i += 2; continue; }
      if (c === '(') frames.push('paren');
      i++; continue;
    }
    if (c === '#' && atWordStart(i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      let k = i + 2;
      const strip = src[k] === '-';
      if (strip) k++;
      while (src[k] === ' ' || src[k] === '\t') k++;
      const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(src.slice(k, k + 80));
      if (m) { heredocs.push({ tag: m[2], strip }); i = k + m[0].length; continue; }
      i += 2; continue;
    }
    if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') { frames.push('arith'); i += 3; continue; }
    if ((c === '$' || c === '<' || c === '>') && src[i + 1] === '(') { frames.push('comsub'); i += 2; continue; }
    if (c === '$' && src[i + 1] === '{') { frames.push('brace'); i += 2; continue; }
    if (caseHere && cs.mode === 'pattern') {
      if (c === ' ' || c === '\t') { i++; continue; }
      if (readWord(i) === 'esac') { cases.pop(); i += 4; continue; }
      i = scanPattern(i, c !== '('); continue;
    }
    if (caseHere && cs.mode === 'body' && c === ';' && (src[i + 1] === ';' || src[i + 1] === '&')) {
      cs.mode = 'pattern'; i += src[i + 1] === ';' && src[i + 2] === '&' ? 3 : 2; continue;
    }
    if (c === '(') { frames.push('paren'); i++; continue; }
    if (c === ')') { if (top() === 'comsub' || top() === 'paren') frames.pop(); i++; continue; }
    if (atWordStart(i) && WORD_CHAR.test(c)) {
      const w = readWord(i);
      const whole = i + w.length >= src.length || /[\s;&|()]/.test(src[i + w.length]);
      if (whole && caseHere && cs.mode === 'in' && w === 'in') { cs.mode = 'pattern'; i += 2; continue; }
      if (whole && w === 'case') { cases.push({ mode: 'subject', depth: frames.length }); i += 4; continue; }
      if (whole && w === 'esac' && caseHere) { cases.pop(); i += 4; continue; }
      i += w.length; continue;
    }
    i++;
  }
  return hits;
}
