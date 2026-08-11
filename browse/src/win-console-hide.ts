/**
 * Windows console-window suppression for the browse daemon.
 *
 * The daemon is launched detached (see cli.ts startServer), which on Windows
 * means it runs with NO console. Any console child it then spawns —
 * chrome-headless-shell.exe via Playwright, `bun` helpers, the taskkill cleanup —
 * finds no console to inherit, so Windows allocates a fresh VISIBLE console
 * window for it. That's the stray terminal windows users see during browse use.
 *
 * The fix is windowsHide (CREATE_NO_WINDOW) on the CHILD: it suppresses the
 * window even when the parent has no console. Verified on Windows 11: a child of
 * a detached/console-less parent is visible without windowsHide and hidden with
 * it. Playwright does not pass windowsHide (it spawns the browser via
 * `childProcess.spawn(...)` in playwright-core's processLauncher with no such
 * option), and we can't pass spawn options through `chromium.launch()`. So we
 * default windowsHide ON for every child_process spawn in this process.
 *
 * Why this works despite Playwright loading first: playwright-core captures
 * child_process via `__toESM(require("child_process"))`, whose property access
 * (`childProcess.spawn`) is a live getter that reads the underlying singleton at
 * call time. Patching the singleton's spawn/spawnSync before the first
 * `launch()` (i.e. during daemon startup, which is what importing this module
 * first in server.ts guarantees) is therefore sufficient.
 *
 * No-op on macOS/Linux.
 */
import { createRequire } from 'node:module';

if (process.platform === 'win32') {
  // An ESM `import * as cp` namespace is read-only and can't be patched.
  // createRequire yields the mutable, cached CJS child_process exports — the
  // same singleton object playwright-core's require("child_process") returns.
  const require_ = createRequire(import.meta.url);
  const cp = require_('child_process') as Record<string, unknown>;

  // Normalize spawn(cmd, options) vs spawn(cmd, args, options) and default
  // windowsHide:true when the caller didn't set it explicitly.
  const withHide = (args: unknown, options: unknown): [unknown, Record<string, unknown>] => {
    let opts: Record<string, unknown>;
    if (args && !Array.isArray(args) && typeof args === 'object') {
      opts = args as Record<string, unknown>;
      args = undefined;
    } else {
      opts = (options as Record<string, unknown>) || {};
    }
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return [args, opts];
  };

  for (const name of ['spawn', 'spawnSync'] as const) {
    const orig = cp[name] as ((...a: unknown[]) => unknown) & { __gstackHidden?: boolean };
    if (typeof orig !== 'function' || orig.__gstackHidden) continue;
    const patched = function (this: unknown, command: unknown, args?: unknown, options?: unknown) {
      const [a, o] = withHide(args, options);
      return a === undefined ? orig.call(this, command, o) : orig.call(this, command, a, o);
    } as ((...a: unknown[]) => unknown) & { __gstackHidden?: boolean };
    patched.__gstackHidden = true;
    cp[name] = patched;
  }
}
