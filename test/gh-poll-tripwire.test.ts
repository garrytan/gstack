/**
 * GitHub poll tripwire (GST-1713). The Capy GitHub app installation shares one
 * GraphQL budget across every crew; gstack waits that polled every 5 to 30 s
 * drained it. lib/gh-poll.ts's pollDelayMs puts a 60 s floor (plus jitter) on
 * every wait between GitHub reads.
 *
 * Rule: in bin/, lib/ and scripts/, a file that reads GitHub (spawns gh, or
 * calls one of the GitHub readers named in READERS) may only sleep with a
 * duration from pollDelayMs on the same line. Sleep primitives being defined
 * or typed (`sleep: ms => Bun.sleepSync(ms)`, `sleep(ms: number): void`) are
 * plumbing, not waits. Anything else needs a marker with its reason on the
 * line or the line above:
 *
 *   // gh-poll-exempt: <why this wait may be shorter than 60 s>
 *
 * Exemptions are counted and ratcheted (EXEMPT_CEILING only goes down), and
 * no shipped file may set the GSTACK_GH_POLL_FLOOR_MS test seam.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCAN_ROOTS = ['bin', 'lib', 'scripts'];
/** The policy owner itself sleeps the rate-limit wait it computes. */
const OWNER = path.join('lib', 'gh-poll.ts');

const READERS = /\b(?:ghJson|ghLines|ghApiJson|runView|newestBranchRun|ciAtHead|readAllPages|runsForHead|fetchPullState|fetchChecks|fetchConversation|reviewDone|ghRunDeps|waitForRun|awaitNonceRun)\(/;
const SPAWNS_GH = /\b(?:spawnSync|spawn|execFileSync)\(\s*['"]gh['"]|\bghSpawnSync\(|\bctx\.gh\(|\brunGh\(|\bspawnGh\b|\.run\(\s*['"]gh['"]|['"]gh['"]\s*,\s*\[/;
const SLEEP = /\b(?:Bun\.sleepSync|Bun\.sleep|Atomics\.wait|sleepSync|sleep)\s*\(|\bsetTimeout\(\s*\w+\s*,/;
const PLUMBING = /\bsleep\w*\s*[:=]\s*\S|function\s+sleep|\bsleep\w*\(\s*\w+\s*:\s*number\s*\)\s*:/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
const EXEMPT_MARKER = /gh-poll-exempt:/;
/** Shrink-only: lower it when exemptions burn down; never raise it. */
const EXEMPT_CEILING = 4;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full, out); }
    else if (dir.endsWith(`${path.sep}bin`) || /\.(?:[cm]?[jt]s)$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface Hit { file: string; line: number; text: string }

function scanSleeps(files: Array<{ rel: string; source: string }>): { violations: Hit[]; exempt: Hit[] } {
  const violations: Hit[] = [];
  const exempt: Hit[] = [];
  for (const { rel, source } of files) {
    if (rel === OWNER || !(READERS.test(source) || SPAWNS_GH.test(source))) continue;
    const lines = source.split('\n');
    lines.forEach((text, i) => {
      if (!SLEEP.test(text) || COMMENT_LINE.test(text) || PLUMBING.test(text) || /\bpollDelayMs\(/.test(text)) return;
      const hit = { file: rel, line: i + 1, text: text.trim().slice(0, 140) };
      if (EXEMPT_MARKER.test(text) || (i > 0 && EXEMPT_MARKER.test(lines[i - 1]!))) exempt.push(hit);
      else violations.push(hit);
    });
  }
  return { violations, exempt };
}

function shipped(): Array<{ rel: string; source: string }> {
  return SCAN_ROOTS.flatMap(root => walk(path.join(ROOT, root))).flatMap(file => {
    const source = fs.readFileSync(file, 'utf8');
    return source.includes('\u0000') ? [] : [{ rel: path.relative(ROOT, file), source }];
  });
}

describe('GitHub poll tripwire', () => {
  // Value: protects=the shared GraphQL and REST budgets from a new fast poll loop; fails_when=a GitHub-reading module sleeps a literal or caller interval instead of pollDelayMs
  test('every wait in a GitHub-reading module goes through pollDelayMs', () => {
    const { violations, exempt } = scanSleeps(shipped());
    if (violations.length) {
      throw new Error(`${violations.length} wait(s) in GitHub-reading modules do not use pollDelayMs (lib/gh-poll.ts, 60 s floor):\n${violations.map(v => `  ${v.file}:${v.line}: ${v.text}`).join('\n')}\nFix: sleep pollDelayMs(<interval ms>), or mark a non-poll wait with // gh-poll-exempt: <reason>`);
    }
    expect(exempt.length).toBeLessThanOrEqual(EXEMPT_CEILING);
  });

  test('the scanner catches a planted 20 s poll, and passes pollDelayMs, plumbing and exempted waits', () => {
    const planted = (body: string) => [{ rel: 'lib/planted.ts', source: `const r = ctx.gh(['pr', 'checks']);\n${body}\n` }];
    expect(scanSleeps(planted('  Bun.sleepSync(20_000);')).violations.map(v => v.line)).toEqual([2]);
    expect(scanSleeps(planted('  await sleep(o.pollMs);')).violations).toHaveLength(1);
    expect(scanSleeps(planted('  await new Promise(r => setTimeout(r, 30_000));')).violations).toHaveLength(1);
    expect(scanSleeps([{ rel: 'lib/delegated.ts', source: 'for (;;) { if (runView(ctx, slug, id)) break; Atomics.wait(i32, 0, 0, 5_000); }\n' }]).violations).toHaveLength(1);
    expect(scanSleeps(planted('  await sleep(pollDelayMs(o.pollMs));')).violations).toEqual([]);
    expect(scanSleeps(planted('  sleep: ms => Bun.sleepSync(ms),\n  sleep(ms: number): void;')).violations).toEqual([]);
    expect(scanSleeps(planted('  // gh-poll-exempt: lock retry, not a GitHub read\n  Bun.sleepSync(50);')).exempt).toHaveLength(1);
    expect(scanSleeps([{ rel: 'lib/no-github.ts', source: 'Bun.sleepSync(10);\n' }]).violations).toEqual([]);
  });

  test('no shipped file sets the GSTACK_GH_POLL_FLOOR_MS test seam', () => {
    const setters = shipped().filter(f => f.rel !== OWNER && /GSTACK_GH_POLL_FLOOR_MS/.test(f.source));
    const workflows = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter(name => /GSTACK_GH_POLL_FLOOR_MS/.test(fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8')));
    expect([...setters.map(f => f.rel), ...workflows]).toEqual([]);
  });
});
