--- a/lib/worktree.ts
+++ b/lib/worktree.ts
@@ -180,6 +180,27 @@ export class WorktreeManager {
         return patchPath;
     }
 
+    /**
+     * Returns true iff `candidate` resolves to a path inside `worktreeBase`.
+     *
+     * Defends against symlink-plant attacks where an entry under
+     * `.gstack-worktrees/<id>/evil -> /elsewhere/innocent` would
+     * otherwise be recursively removed by `pruneStale()`. Without this
+     * check, `fs.rmSync({recursive:true, force:true})` follows the
+     * symlink and deletes content outside the worktree boundary.
+     *
+     * Implementation: resolve both paths to their realpath (chasing any
+     * symlinks) and check that the candidate is reachable from the base
+     * via a non-`..` relative path. Failure modes (un-resolvable
+     * candidate, base that itself disappeared) are treated as
+     * "do not delete" — the safer default; the next prune tick can
+     * retry once the filesystem settles.
+     */
+    private safeInsideWorktrees(candidate: string): boolean {
+        try {
+            const real = fs.realpathSync.native(candidate);
+            const baseReal = fs.realpathSync.native(this.worktreeBase);
+            const rel = path.relative(baseReal, real);
+            return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
+        } catch {
+            return false;
+        }
+    }
+
     /** Remove a worktree. Non-fatal on error. */
     cleanup(testName: string): void {
         const info = this.active.get(testName);
@@ -222,6 +243,7 @@ export class WorktreeManager {
                 try {
                     const stat = fs.statSync(entryPath);
                     const ageMs = Date.now() - stat.mtimeMs;
                     if (ageMs < 3600_000) continue;
+                    if (!this.safeInsideWorktrees(entryPath)) continue;
                     fs.rmSync(entryPath, { recursive: true, force: true });
                 } catch { /* non-fatal */ }
             }