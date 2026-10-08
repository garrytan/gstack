/**
 * /autoplan's own read-only inputs, approved without a permission card.
 *
 * Claude Code clears a skill's `allowed-tools` grant when the next turn starts,
 * and a background reviewer's completion notice starts one. The skill's hooks
 * stay registered for the session, so this hook re-approves exactly the files
 * /autoplan itself reads outside the working directory: its installed section
 * files, and the immutable phase artifacts in a project's `.gstack/tmp/autoplan/`
 * when the session started below the repository root. It never denies; anything
 * else keeps Claude Code's own permission check. Skill hooks do not run inside
 * subagents, so reviewer inputs live in the project, which needs no approval.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { nativePathSpelling, sameNativePath } from '../../lib/claude-journal-records';
import { resolveStateRoot } from '../../lib/state-root';

/** setup's `${GSTACK_USER_RENDER_DIR:-$GSTACK_STATE_ROOT/render/claude}`, realpath'd. */
export function userRenderRoot(): string | undefined {
  const configured = process.env.GSTACK_USER_RENDER_DIR || path.join(resolveStateRoot(), 'render', 'claude');
  try { return fs.realpathSync(path.resolve(nativePathSpelling(configured))); } catch { return; }
}

/** scripts/gen-skill-docs.ts rewriteSectionBase, which writes that render. */
export function renderSectionBase(content: string, linkRoot: string): string {
  return content.replace(
    /~\/\.claude\/skills\/gstack\/([^\s)`"'*]+\/sections\/)/g,
    (_m, p1: string) => `${linkRoot}/${p1}`,
  );
}

const ARTIFACT_DIR = /^autoplan-(ceo|design|dx|eng)-[^\\/]+$/;
const artifactFiles = (phase: string) => ['methodology.md', 'methodology.json', 'native-prompt.md', 'snapshot.json',
  'source-implementation.md', `${phase}-implementation.md`, 'close-packet.md'];

/** True only for this installation's autoplan/sections/*.md, or an immutable artifact in
 *  <repo>/.gstack/tmp/autoplan/autoplan-<phase>-*\/ (read-only: mode 0444, or the read-only attribute on Windows) where <repo> is the session's project directory or contains it. */
export function ownedAutoplanRead(file: unknown, cwd: string, root: string): boolean {
  if (typeof file !== 'string') return false;
  try {
    const requested = nativePathSpelling(path.resolve(cwd, file.replace(/^~(?=[\\/]|$)/, () => os.homedir())));
    const base = path.basename(requested), directory = path.dirname(requested), actual = fs.realpathSync(requested);
    if (path.basename(directory) === 'sections' && path.basename(path.dirname(directory)) === 'autoplan') {
      const canonical = path.join(root, 'autoplan', 'sections', base);
      if (!/^[a-z0-9-]+\.md$/.test(base) || !fs.lstatSync(canonical).isFile()) return false;
      if (sameNativePath(actual, canonical)) return true;
      const render = userRenderRoot();
      return !!render && sameNativePath(actual, path.join(render, 'autoplan', 'sections', base)) &&
        fs.readFileSync(actual, 'utf8') === renderSectionBase(fs.readFileSync(canonical, 'utf8'), render);
    }
    const phase = ARTIFACT_DIR.exec(path.basename(directory))?.[1];
    if (!phase || !artifactFiles(phase).includes(base) || !sameNativePath(actual, requested)) return false;
    const stat = fs.lstatSync(requested), store = path.dirname(directory), owner = path.dirname(path.dirname(path.dirname(store)));
    const project = fs.realpathSync(nativePathSpelling(process.env.CLAUDE_PROJECT_DIR || cwd));
    return stat.isFile() && sameNativePath(store, path.join(owner, '.gstack', 'tmp', 'autoplan')) &&
      (sameNativePath(project, owner) || nativePathSpelling(project).startsWith(nativePathSpelling(owner) + path.sep)) &&
      (process.platform === 'win32' ? (stat.mode & 0o222) === 0 : (stat.mode & 0o777) === 0o444);
  } catch { return false; }
}

export const OWNED_READ_APPROVAL = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PreToolUse',
  permissionDecision: 'allow', permissionDecisionReason: '[autoplan] Reading an /autoplan section or phase artifact.' }) });

/** The guard's own verdict wins: only a parent Read the guard left without any output is approved. */
export function approveOwnedRead(value: unknown, output: object, root: string): object {
  if (Object.keys(output).length || value === null || typeof value !== 'object') return output;
  const input = value as Record<string, any>;
  if (input.tool_name !== 'Read' || input.agent_id || typeof input.cwd !== 'string' ||
      !ownedAutoplanRead(input.tool_input?.file_path, input.cwd, root)) return output;
  return OWNED_READ_APPROVAL;
}
