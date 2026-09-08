/**
 * Runtime paths for PTY sessions that seed the checkout's Claude skills.
 *
 * Claude's registry uses CLAUDE_CONFIG_DIR, but generated skills also read
 * ~/.claude/skills/gstack and execute $HOME/.claude/skills/gstack/bin tools.
 * Point those unchanged paths at the same checkout, never an operator install.
 * This HOME is owned by the existing hermetic runRoot and its exit/GC cleanup.
 *
 * Two intentional shared resources survive the HOME change: nested Codex's
 * configured auth/model directory, and Playwright's existing browser cache.
 * Claude auth stays in the existing seeded config/API env; gstack state stays
 * at the caller's GSTACK_HOME. No operator skill, hooks, or settings are copied.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getHermeticDirs } from './hermetic-env';

let cachedRuntime: { home: string; root: string } | undefined;

export function hermeticSkillRuntime(): { home: string; root: string } {
  if (cachedRuntime) return cachedRuntime;
  const home = fs.mkdtempSync(path.join(getHermeticDirs().runRoot, 'skill-home-'));
  const root = path.join(home, '.claude', 'skills', 'gstack');
  try {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.symlinkSync(path.resolve(import.meta.dir, '..', '..'), root, 'dir');
  } catch (error) {
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
  cachedRuntime = { home, root };
  return cachedRuntime;
}

/** Keep the cache the child used before HOME isolation (Playwright defaults). */
function browserCache(env: Record<string, string>, originalHome: string): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  const base = process.platform === 'darwin'
    ? path.join(originalHome, 'Library', 'Caches')
    : process.platform === 'win32'
      ? env.LOCALAPPDATA || path.join(originalHome, 'AppData', 'Local')
      : env.XDG_CACHE_HOME || path.join(originalHome, '.cache');
  return path.join(base, 'ms-playwright');
}

export function withHermeticSkillRuntime(
  env: Record<string, string>,
  operatorEnv: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; root: string } {
  const originalHome = env.HOME || os.homedir();
  const runtime = hermeticSkillRuntime();
  // An explicit empty per-test value resets Codex to its original HOME default.
  const codexHome = env.CODEX_HOME !== undefined
    ? env.CODEX_HOME || path.join(originalHome, '.codex')
    : operatorEnv.CODEX_HOME || path.join(originalHome, '.codex');
  return {
    root: runtime.root,
    env: {
      ...env,
      HOME: runtime.home,
      CODEX_HOME: codexHome,
      PLAYWRIGHT_BROWSERS_PATH: browserCache(env, originalHome),
    },
  };
}
