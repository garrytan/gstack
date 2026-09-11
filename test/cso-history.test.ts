import { describe,expect,test } from 'bun:test';
import { gitDiffHeaderPaths,historyForPath } from '../lib/cso/history';

describe('CSO retained Git history path filtering',()=>{
  test('matches exact paths without leaking a prefix sibling hunk',()=>{
    const raw=`commit ${'a'.repeat(40)}
Author: Fixture
diff --git a/foo b/foo
--- a/foo
+++ b/foo
+wanted
diff --git a/foo-extra b/foo-extra
--- a/foo-extra
+++ b/foo-extra
+must-not-leak
`;
    const selected=historyForPath(raw,'foo')!;
    expect(selected).toContain('+wanted');
    expect(selected).not.toContain('must-not-leak');
  });

  test('decodes Git C-quoted UTF-8 and space-bearing header paths',()=>{
    expect(gitDiffHeaderPaths('diff --git "a/caf\\303\\251 file.ts" "b/caf\\303\\251 file.ts"')).toEqual(['a/café file.ts','b/café file.ts']);
    const raw=`commit ${'b'.repeat(40)}\nSubject: Unicode\ndiff --git "a/caf\\303\\251 file.ts" "b/caf\\303\\251 file.ts"\n+unicode-only\n`;
    expect(historyForPath(raw,'café file.ts')).toContain('+unicode-only');
  });

  test('rejects malformed quoted headers instead of broadening the match',()=>{
    expect(gitDiffHeaderPaths('diff --git "a/foo b/foo')).toBeUndefined();
    expect(historyForPath('diff --git "a/foo b/foo\n+secret\n','foo')).toBeUndefined();
  });
});
