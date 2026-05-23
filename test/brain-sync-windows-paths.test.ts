import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Static invariants guarding Windows artifact-sync (bin/gstack-brain-sync).
//
// These are deliberately static, not behavioral. The brain-sync integration
// suite (test/brain-sync.test.ts) spawns the bin/ scripts directly, which
// Node/Bun cannot exec on Windows (they are bash-shebang scripts), so that
// suite is excluded from the Windows CI lane. Instead we assert the source
// keeps the properties that make `--discover-new` and the `--once` drain work
// on Windows. Each maps to a confirmed, separately-reproduced failure:
//
//   1. os.path.relpath yields BACKSLASH separators on Windows, which never
//      match the forward-slash allowlist globs (e.g. "projects/*/learnings.jsonl"),
//      so nested artifacts were silently never discovered.
//   2. discover-new enqueued via subprocess.run([bash-shim]); Windows Python
//      cannot exec a shebang script, so it enqueued nothing even once matched.
//   3. compute_paths_to_stage's python print() emits CRLF on Windows; the bash
//      `read -r` keeps the trailing \r, so `git add -- "path\r"` matches
//      nothing and the drain silently stages/commits nothing.
//
// Plus two robustness properties (independent codex review, both [P2]):
//   4. the inline enqueue must append one atomic record at a time (O_APPEND),
//      or a concurrent writer-shim append can interleave mid-record and produce
//      a malformed queue line that the drain silently drops.
//   5. the skip-list must be normalized to the same separator form as `rel`,
//      or a backslash entry in .brain-skip.txt stops matching and a file the
//      user explicitly skipped gets synced.
const ROOT = path.resolve(import.meta.dir, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-brain-sync'), 'utf-8');

describe('gstack-brain-sync — Windows path/exec invariants', () => {
  test('discover-new normalizes relpath separators before fnmatch (bug 1)', () => {
    expect(SRC).toContain('os.path.relpath(full, gstack_home).replace(os.sep, "/")');
  });

  test('no python subprocess exec — Windows cannot exec the bash shims (bug 2)', () => {
    // The whole script must never shell out to a bin/ bash script from Python;
    // that is the exec failure that left discover enqueuing nothing on Windows.
    expect(SRC).not.toContain('subprocess');
  });

  test('drain loop strips trailing CR before git add (bug 3)', () => {
    const CR_STRIP = "p=\"${p%$'\\r'}\"";
    expect(SRC).toContain(CR_STRIP);
    // The strip must precede the staging call, or the pathspec still carries \r.
    expect(SRC.indexOf(CR_STRIP)).toBeLessThan(SRC.indexOf('add -f -- "$p"'));
  });

  test('inline enqueue appends one atomic record at a time (codex P2 #1)', () => {
    expect(SRC).toContain('os.O_APPEND');
    expect(SRC).toContain('os.write(fd');
    // No buffered batch write to the queue (the interleave-corruption shape).
    expect(SRC).not.toContain('open(queue_path, "a"');
  });

  test('skip-list is normalized on BOTH discover and drain sides (codex P2 #2)', () => {
    // The drain (compute_paths_to_stage) is the real staging boundary, so it
    // must normalize skip entries identically to discover_new — otherwise a
    // backslash .brain-skip.txt entry is honored at discovery but bypassed at
    // commit, syncing a file the user explicitly skipped.
    const NORM = 's.replace(os.sep, "/") for s in load_lines(skip_path)';
    expect(SRC.split(NORM).length - 1).toBeGreaterThanOrEqual(2);
  });
});
