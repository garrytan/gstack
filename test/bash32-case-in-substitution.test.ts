/**
 * #3601: macOS /bin/bash 3.2 cannot parse a case pattern without its leading
 * ( inside $( ), and Linux CI's bash 5 can, so bin/gstack-launch-probe.sh
 * shipped a parse error that made gstack-doctor call the probe "missing".
 * The repo-wide case is the guard Linux CI can run; the last case parses the
 * probe with /bin/bash, which is bash 3.2 on macOS. It lives here, not in
 * test/gstack-launch-probe.test.ts, because that file runs in windows-smoke and
 * a hardcoded /bin/bash path takes a file out of the Windows-safe set.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { scanBash32CaseInSubstitution } from './helpers/bash32-case-scan';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin/gstack-launch-probe.sh');

function trackedShellScripts(): string[] {
  const files = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).stdout.split('\0').filter(Boolean);
  return files.filter(rel => {
    if (/\.(md|ts|js|json|ya?ml|txt|tmpl)$/.test(rel)) return false;
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const first = fs.readFileSync(file, 'utf8').slice(0, 200).split('\n')[0];
    if (/^#!.*\b(zsh|python3?|node|bun|perl|ruby)\b/.test(first)) return false;
    return rel.endsWith('.sh') || /^#!.*\b(bash|sh)\b/.test(first);
  });
}

describe('bash 3.2: case patterns inside a substitution (#3601)', () => {
  // Value: protects=the scanner flags exactly the shape bash 3.2 cannot parse; fails_when=it misses a bare pattern in $( ), one-line or multi-line,
  //   or flags a parenthesized pattern, a case outside a substitution, or quoted text; why_new=the scanner is new; seam=none
  test('the scanner flags a bare pattern inside $( ) or <( ) and nothing else', () => {
    const hits = (src: string) => scanBash32CaseInSubstitution(src).map(h => h.line);
    expect(hits("x=$(case a in *[![:space:]]*) echo ok ;; esac)")).toEqual([1]);
    expect(hits("x=$(\ncase a in\n  (b) echo 1 ;;\n  c) echo 2 ;;\nesac\n)")).toEqual([4]);
    expect(hits("diff <(case a in b) echo ;; esac) /dev/null")).toEqual([1]);
    expect(hits("x=$(case \"$v\" in (*[![:space:]]*) echo ok ;; (b|c) : ;; esac)")).toEqual([]);
    expect(hits("case a in b) x=$(echo hi) ;; esac")).toEqual([]);
    expect(hits("y=$(echo \"case a in b) no\")")).toEqual([]);
    expect(hits("cat <<'EOF'\nx=$(case a in b) ;; esac)\nEOF\nz=$(echo ok)")).toEqual([]);
  });

  // Value: protects=every shell script gstack ships parses under macOS /bin/bash 3.2 (#3601);
  //   fails_when=a script puts a bare case pattern inside $( ); why_new=Linux CI runs bash 5, which accepts it; seam=none
  test('no tracked shell script has a bare case pattern inside a substitution', () => {
    const scripts = trackedShellScripts();
    expect(scripts).toContain('bin/gstack-launch-probe.sh');
    const hits = scripts.flatMap(rel => scanBash32CaseInSubstitution(fs.readFileSync(path.join(ROOT, rel), 'utf8')).map(h => `${rel}:${h.line}: ${h.text}`));
    expect(hits).toEqual([]);
  });

  // Value: protects=the probe parses under macOS /bin/bash 3.2, so gstack-doctor can source it (#3601);
  //   fails_when=a case pattern inside $( ) loses its leading (, on a macOS runner only: Linux /bin/bash is 5.x, which parsed the old line,
  //   so the scan above is the Linux CI guard; why_new=test/gstack-launch-probe.test.ts runs PATH bash; seam=none
  test.skipIf(!fs.existsSync('/bin/bash'))('bin/gstack-launch-probe.sh parses under /bin/bash (catches #3601 only where /bin/bash is 3.2, i.e. macOS)', () => {
    const r = spawnSync('/bin/bash', ['-n', PROBE], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
