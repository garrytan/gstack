/**
 * gstack-ship-receipt carry across a changelog-fragment conversion (GST-1210, HARN-1 harness-evals#206): a PR reviewed
 * with its own version stamp (VERSION, package.json, CHANGELOG) moves to a changelog.d fragment after the base adopts
 * fragments, which puts every stamp file back at the base's content. A stamp file the branch no longer changes against
 * the base, or changes only in its stamp fields, holds no unreviewed change, so the receipt carries; a non-stamp change
 * in package.json or a logic edit next to the reviewed one still refuses.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const receiptIn = (body: string) => extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
const carry = (repo: FixtureRepo, body: string) => runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
const pkg = (version: string, scripts: Record<string, string> = {}) => JSON.stringify({ name: 'fixture', version, scripts: { test: 'node --test test/*.test.js', generate: 'node gen.js', ...scripts } }, null, 2) + '\n';
const POLICY = (fragments: boolean) => JSON.stringify({ min_gstack_version: '1.91.340.0', stamp_files: ['VERSION', 'package.json', 'CHANGELOG.md'], ...(fragments ? { changelog_fragments: { dir: 'changelog.d' } } : {}) }, null, 2) + '\n';
const RETRY4 = "exports.MAX_RETRIES = 4;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\n";

/**
 * main at 1.0.0 <- feature: four retries plus its own 1.0.1 stamp, /ship receipt written there. main then ships 1.0.3,
 * adopts changelog fragments and (`mainScripts`) changes package.json beyond its version. The branch merges main and
 * converts: `converted` is the package.json it keeps (main's by default), plus a fragment and any `extra` files.
 */
function converted(repo: FixtureRepo, opts: { mainScripts?: Record<string, string>; keep?: (main: string) => string; extra?: Record<string, string>; executable?: boolean } = {}): { reviewed: string; body: string } {
  repo.git('checkout', '-q', 'main');
  commit(repo, { VERSION: '1.0.0\n', 'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n- base\n', '.gstack/ship-policy.json': POLICY(false) }, 'main: stamp files');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('reset', '-q', '--hard', 'origin/main');
  const reviewed = commit(repo, { 'lib/retry.js': RETRY4, VERSION: '1.0.1\n', 'package.json': pkg('1.0.1'), 'CHANGELOG.md': '# Changelog\n\n## 1.0.1\n- four retries\n\n## 1.0.0\n- base\n' }, 'feat: four retries (v1.0.1)');
  const body = path.join(repo.root, 'body.md');
  const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '206', '--base', 'main', '--version', '1.0.1', '--session-kind', 'unattended', '--body', body]);
  expect(w.status).toBe(EXIT.ok);
  repo.git('checkout', '-q', 'main');
  const mainPkg = pkg('1.0.3', opts.mainScripts);
  commit(repo, { VERSION: '1.0.3\n', 'package.json': mainPkg, 'CHANGELOG.md': '# Changelog\n\n## 1.0.3\n- other PRs\n\n## 1.0.0\n- base\n', '.gstack/ship-policy.json': POLICY(true), 'changelog.d/README.md': '# fragments\n' }, 'main: v1.0.3, changelog fragments');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  try { repo.git('merge', '-q', '--no-edit', 'origin/main'); } catch { /* the stamp files conflict; the conversion resolves them below */ }
  repo.git('checkout', 'origin/main', '--', 'VERSION', 'CHANGELOG.md', 'package.json');
  write(repo.work, 'package.json', (opts.keep ?? (m => m))(mainPkg));
  write(repo.work, 'changelog.d/four-retries.md', '- four retries\n');
  for (const [rel, text] of Object.entries(opts.extra ?? {})) write(repo.work, rel, text);
  if (opts.executable) fs.chmodSync(path.join(repo.work, 'package.json'), 0o755);
  repo.git('add', '-A');
  if (opts.executable) repo.git('update-index', '--chmod=+x', 'package.json');
  repo.git('commit', '-q', '--no-edit', '-m', 'convert to a changelog fragment');
  return { reviewed, body };
}

describe('carry across a changelog-fragment conversion (GST-1210)', () => {
  // Value: protects=a PR converted to a changelog fragment after review keeps its receipt when the base also changed
  // package.json beyond its version (HARN-1 harness-evals#206 paid a fresh /ship); fails_when=carry reads the base's own
  // package.json change as the branch's product change; seam=none; no_claim=gh pr edit (--body stands in)
  test('a stamp file back at the base\'s content carries as release metadata', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { reviewed, body } = converted(repo, { mainScripts: { lint: 'node lint.js' } });
    const head = repo.git('rev-parse', 'HEAD');
    const out = carry(repo, body);
    expect(out.err).not.toContain('RECEIPT_CARRY');
    expect(out.status).toBe(EXIT.ok);
    expect(out.out).toContain(`CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)}`);
    expect(receiptIn(body).carry!.reason).toContain('release metadata');
  }, 90_000);

  // Value: protects=the converted PR whose package.json is the base's except its version field carries as stamp-only;
  // fails_when=the version difference against the base reads as a product change; seam=none; no_claim=gh pr edit
  test('a package.json equal to the base\'s except the version field carries', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { body } = converted(repo, { mainScripts: { lint: 'node lint.js' }, keep: m => m.replace('"version": "1.0.3"', '"version": "1.0.4"') });
    const out = carry(repo, body);
    expect(out.err).not.toContain('RECEIPT_CARRY');
    expect(out.status).toBe(EXIT.ok);
    expect(receiptIn(body).carry!.reason).toContain('release metadata');
  }, 90_000);

  // Value: protects=fail closed on a package.json field the branch changed beyond the stamp (a new script runs code);
  // fails_when=a stamp file that is not the base's content is read as stamp-only; seam=none; no_claim=gh pr edit
  test('a non-stamp field the branch adds to package.json still refuses', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { body } = converted(repo, { mainScripts: { lint: 'node lint.js' }, keep: m => m.replace('"lint": "node lint.js"', '"lint": "node lint.js",\n    "postinstall": "node evil.js"') });
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.err).toContain('package.json');
  }, 90_000);

  // Value: protects=fail closed on a stamp file whose content is the base's but whose mode the branch flipped (a mode is
  // not a stamp); fails_when=an unchanged side is read from the object id alone; seam=none; no_claim=gh pr edit
  test('a package.json back at the base\'s content with a flipped mode still refuses', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { body } = converted(repo, { mainScripts: { lint: 'node lint.js' }, executable: true });
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.err).toContain('package.json');
  }, 90_000);

  // Value: protects=fail closed on a logic edit beside the reviewed one riding the conversion; fails_when=the stamp-file
  // rule widens to the whole diff; seam=none; no_claim=gh pr edit
  test('a logic edit next to the reviewed constant still refuses', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const { body } = converted(repo, { mainScripts: { lint: 'node lint.js' }, extra: { 'lib/retry.js': RETRY4.replace('TIMEOUT_MS = 5000', 'TIMEOUT_MS = 50') } });
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.err).toContain('lib/retry.js');
  }, 90_000);
});
