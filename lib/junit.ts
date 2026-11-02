/**
 * JUnit XML reader for gstack-flaky (GSTA-158). One reader for every runner
 * that writes JUnit: Playwright (`--reporter=junit`, retry-aware with
 * PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1), `bun test --reporter=junit`, jest,
 * pytest and vitest. No XML dependency: the subset JUnit uses (elements,
 * attributes, text, CDATA, comments, processing instructions) is tokenized
 * here.
 *
 * A test's id is `<file>::<project>::<title>`. The title is the describe path
 * plus the test name joined by " > ", so Playwright's " › " and bun's nested
 * testsuites give the same shape. The project is Playwright's project name
 * (its testsuite `hostname`) and empty for every other runner, so a test
 * that runs in two browser projects is two ids.
 *
 * Attempts: Playwright's retry-aware report lists each failed retry as
 * `rerunFailure` (final result failed) or `flakyFailure` (final result
 * passed). A Playwright failure whose text shows "Retry #" without those
 * elements means retries ran but were not reported (`retriesHidden`). A test
 * that appears more than once (repeat-each, a duplicate name) fails when any
 * of its executions failed.
 */
import * as fs from 'fs';

export type JunitRunner = 'playwright' | 'bun' | 'generic';
export type Attempt = 'pass' | 'fail' | 'skip';

export interface JunitTest {
  id: string;
  file: string;
  project: string;
  /** Describe path plus test name. */
  path: string[];
  attempts: Attempt[];
  /** Testcase elements with this id in the report (more than one: repeat-each or a duplicate name). */
  executions: number;
  /** First lines of the final failure, or of the first failed attempt. */
  excerpt: string[];
}

export interface JunitReport {
  runner: JunitRunner;
  tests: JunitTest[];
  retriesHidden: boolean;
}

export class JunitError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string; parent: XmlNode | null }

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const TAG = /^<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '', parent: null };
  let cur = root;
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { cur.text += decode(xml.slice(i)); break; }
    if (lt > i) cur.text += decode(xml.slice(i, lt));
    const rest = xml.slice(lt, lt + 9);
    if (rest.startsWith('<![CDATA[')) {
      const end = xml.indexOf(']]>', lt);
      if (end < 0) throw new JunitError('FLAKY_JUNIT_INVALID', 'unterminated CDATA section');
      cur.text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = xml.indexOf('-->', lt);
      if (end < 0) throw new JunitError('FLAKY_JUNIT_INVALID', 'unterminated comment');
      i = end + 3;
      continue;
    }
    if (rest.startsWith('<?') || rest.startsWith('<!')) {
      const end = xml.indexOf('>', lt);
      if (end < 0) throw new JunitError('FLAKY_JUNIT_INVALID', 'unterminated declaration');
      i = end + 1;
      continue;
    }
    const m = TAG.exec(xml.slice(lt));
    if (!m) throw new JunitError('FLAKY_JUNIT_INVALID', `malformed tag at offset ${lt}`);
    const [whole, close, name, attrText, selfClose] = m;
    if (close) {
      if (cur.name !== name) throw new JunitError('FLAKY_JUNIT_INVALID', `</${name}> closes <${cur.name}> at offset ${lt}`);
      cur = cur.parent!;
    } else {
      const attrs: Record<string, string> = {};
      for (const a of attrText!.matchAll(ATTR)) attrs[a[1]!] = decode(a[2] ?? a[3] ?? '');
      const node: XmlNode = { name: name!, attrs, children: [], text: '', parent: cur };
      cur.children.push(node);
      if (!selfClose) cur = node;
    }
    i = lt + whole!.length;
  }
  if (cur !== root) throw new JunitError('FLAKY_JUNIT_INVALID', `<${cur.name}> is never closed`);
  return root;
}

function allNodes(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    allNodes(c, name, out);
  }
  return out;
}

export function detectRunner(root: XmlNode): JunitRunner {
  const top = root.children.find(c => c.name === 'testsuites');
  if (top?.attrs.name === 'bun test') return 'bun';
  const cases = allNodes(root, 'testcase');
  if (cases.some(c => (c.attrs.name ?? '').includes(' › '))) return 'playwright';
  const suites = allNodes(root, 'testsuite');
  if (suites.length && suites.every(s => 'timestamp' in s.attrs && 'hostname' in s.attrs && !('file' in s.attrs))
    && cases.every(c => c.parent?.name === 'testsuite' && c.attrs.classname === c.parent.attrs.name)) return 'playwright';
  return 'generic';
}

function excerptOf(node: XmlNode | undefined): string[] {
  if (!node) return [];
  const body = (node.attrs.message ? node.attrs.message + '\n' : '') + node.text;
  return body.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trimEnd()).filter(l => l.trim()).slice(0, 8);
}

export const testId = (file: string, project: string, path: string[]) => `${file}::${project}::${path.join(' > ')}`;

function readCase(tc: XmlNode, runner: JunitRunner): Omit<JunitTest, 'id' | 'executions'> & { hidden: boolean } {
  const suite = tc.parent!;
  let file: string, project = '', path: string[];
  if (runner === 'playwright') {
    file = tc.attrs.classname || suite.attrs.name || '';
    project = suite.attrs.hostname ?? '';
    path = (tc.attrs.name ?? '').split(' › ');
  } else if (runner === 'bun') {
    file = tc.attrs.file ?? '';
    path = [];
    for (let s: XmlNode | null = suite; s && s.name === 'testsuite'; s = s.parent) {
      if ('file' in s.attrs && s.attrs.name === s.attrs.file && s.parent?.name !== 'testsuite') break;
      path.unshift(s.attrs.name ?? '');
    }
    path.push(tc.attrs.name ?? '');
  } else {
    file = tc.attrs.file || tc.attrs.classname || suite.attrs.file || suite.attrs.name || '';
    path = [tc.attrs.name ?? ''];
  }
  const kids = (n: string) => tc.children.filter(c => c.name === n);
  const final = kids('failure')[0] ?? kids('error')[0];
  const skipped = kids('skipped').length > 0;
  const flaky = [...kids('flakyFailure'), ...kids('flakyError')];
  const rerun = [...kids('rerunFailure'), ...kids('rerunError')];
  let attempts: Attempt[];
  if (final) attempts = [...rerun.map(() => 'fail' as const), 'fail'];
  else if (skipped) attempts = ['skip'];
  else attempts = [...flaky.map(() => 'fail' as const), 'pass'];
  const hidden = runner === 'playwright' && !!final && rerun.length === 0 && /\bRetry #\d+/.test(final.text);
  return { file, project, path, attempts, excerpt: excerptOf(final ?? flaky[0]), hidden };
}

export function parseJunit(xml: string, runner?: JunitRunner): JunitReport {
  const root = parseXml(xml);
  const kind = runner ?? detectRunner(root);
  const byId = new Map<string, JunitTest>();
  let retriesHidden = false;
  for (const tc of allNodes(root, 'testcase')) {
    const { hidden, ...t } = readCase(tc, kind);
    retriesHidden ||= hidden;
    const id = testId(t.file, t.project, t.path);
    const seen = byId.get(id);
    if (seen) {
      const failed = finalAttempt(seen) === 'fail' || t.attempts.at(-1) === 'fail';
      seen.attempts = [...seen.attempts, ...t.attempts].sort((a, b) => failed ? Number(a === 'fail') - Number(b === 'fail') : 0);
      seen.executions++;
      if (!seen.excerpt.length) seen.excerpt = t.excerpt;
    } else byId.set(id, { id, ...t, executions: 1 });
  }
  if (byId.size === 0) throw new JunitError('FLAKY_NO_RESULTS', 'the JUnit report holds no testcase');
  return { runner: kind, tests: [...byId.values()], retriesHidden };
}

/** Read and parse one JUnit file; missing, unreadable and empty files are errors, never green. */
export function readJunit(file: string, runner?: JunitRunner): JunitReport {
  let xml: string;
  try { xml = fs.readFileSync(file, 'utf-8'); } catch (e) {
    throw new JunitError('FLAKY_NO_RESULTS', `cannot read ${file}: ${(e as Error).message}`);
  }
  if (!xml.trim()) throw new JunitError('FLAKY_NO_RESULTS', `${file} is empty`);
  return parseJunit(xml, runner);
}

/** The final outcome of a test: its last attempt. */
export const finalAttempt = (t: JunitTest): Attempt => t.attempts[t.attempts.length - 1]!;
