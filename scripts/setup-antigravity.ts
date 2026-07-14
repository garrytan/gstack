#!/usr/bin/env bun
/**
 * setup-antigravity.ts
 *
 * Automated post-generation setup for the Google Antigravity host.
 *
 * What it does:
 *   1. Resolves the repo-local generated skills directory:
 *        <repo>/.antigravity/skills/gstack
 *   2. Ensures the global Antigravity skills parent directory exists:
 *        ~/.agents/skills/
 *   3. Creates a platform-appropriate link at ~/.agents/skills/gstack:
 *        Windows  → NTFS junction (no admin/Developer Mode required)
 *        macOS/Linux → directory symlink
 *   4. Is fully idempotent: safe to run repeatedly; skips if already correct.
 *   5. Detects and cleans up broken or stale links before re-creating.
 *
 * Why ~/.agents/skills/ (not ~/.antigravity/skills/):
 *   Antigravity v2 Desktop IDE and CLI discover repo-local and global AI skills
 *   under ~/.agents/skills/. The .antigravity/ directory is the VS Code app shell,
 *   not the skill discovery root. This script bridges the two.
 *
 * Usage:
 *   bun run scripts/setup-antigravity.ts
 *   bun run setup:antigravity        (via package.json)
 *
 * The setup:antigravity script in package.json first runs gen:skill-docs --host
 * antigravity so the source directory always exists before linking.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Constants ───────────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === 'win32';

/** Root of the gstack repository (parent of this script's directory). */
const REPO_ROOT = path.resolve(import.meta.dir, '..');

/** Source: the full generated Antigravity skills directory inside the repo.
 *  This is the PARENT that contains gstack/, gstack-ship/, gstack-review/, etc.
 *  We link this entire directory into ~/.agents/skills/gstack so Antigravity
 *  can discover all gstack-* skills in one place.
 */
const SOURCE_DIR = path.join(REPO_ROOT, '.antigravity', 'skills');

/** Target parent: the global Antigravity/agents skills directory. */
const TARGET_PARENT = path.join(os.homedir(), '.agents', 'skills');

/** Target link path: where Antigravity will discover gstack skills. */
const TARGET_LINK = path.join(TARGET_PARENT, 'gstack');

// ─── Logging helpers ─────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

function warn(msg: string): void {
  process.stderr.write('[warn] ' + msg + '\n');
}

function die(msg: string): never {
  process.stderr.write('[error] ' + msg + '\n');
  process.exit(1);
}

// ─── Utility: resolve a link's final real target ────────────────────────────

/**
 * Return the real path a symlink/junction points at, or null if the link is
 * broken (target doesn't exist on disk) or the path doesn't exist at all.
 */
function readLinkTarget(linkPath: string): string | null {
  try {
    const target = fs.readlinkSync(linkPath);
    // Resolve relative targets against the link's directory
    const resolved = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(linkPath), target);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Return true if linkPath is a symlink or NTFS junction.
 * On Windows, junctions report isSymbolicLink() === true via lstat.
 */
function isLink(linkPath: string): boolean {
  try {
    return fs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Return true if linkPath exists as a real directory (not a link).
 */
function isRealDir(linkPath: string): boolean {
  try {
    const stat = fs.lstatSync(linkPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

// ─── Step 1: Verify source exists ────────────────────────────────────────────

function assertSourceExists(): void {
  if (!fs.existsSync(SOURCE_DIR)) {
    die(
      `Source directory not found: ${SOURCE_DIR}\n` +
      `Run 'bun run gen:skill-docs --host antigravity' first, or use:\n` +
      `  bun run setup:antigravity`
    );
  }
  log(`✓ Source: ${SOURCE_DIR}`);
}

// ─── Step 2: Ensure target parent directory exists ───────────────────────────

function ensureTargetParent(): void {
  if (!fs.existsSync(TARGET_PARENT)) {
    fs.mkdirSync(TARGET_PARENT, { recursive: true });
    log(`✓ Created: ${TARGET_PARENT}`);
  } else {
    log(`✓ Parent exists: ${TARGET_PARENT}`);
  }
}

// ─── Step 3: Check existing link/directory state ─────────────────────────────

type LinkState =
  | { kind: 'none' }                    // TARGET_LINK does not exist
  | { kind: 'correct'; target: string } // already points at SOURCE_DIR
  | { kind: 'stale'; target: string }   // link exists but points elsewhere
  | { kind: 'broken' }                  // link exists but target is missing
  | { kind: 'real-dir' };               // real directory (not a link) — back up

function inspectTarget(): LinkState {
  if (!fs.existsSync(TARGET_LINK) && !isLink(TARGET_LINK)) {
    return { kind: 'none' };
  }

  if (isLink(TARGET_LINK)) {
    const resolvedTarget = readLinkTarget(TARGET_LINK);
    if (resolvedTarget === null) {
      return { kind: 'broken' };
    }
    // Normalize both paths for comparison (handles Windows drive-letter case, trailing slashes)
    const normalizedTarget = path.normalize(resolvedTarget);
    const normalizedSource = path.normalize(SOURCE_DIR);
    if (normalizedTarget === normalizedSource) {
      return { kind: 'correct', target: resolvedTarget };
    }
    return { kind: 'stale', target: resolvedTarget };
  }

  if (isRealDir(TARGET_LINK)) {
    return { kind: 'real-dir' };
  }

  // Exists but is neither link nor directory (shouldn't happen, but handle gracefully)
  return { kind: 'broken' };
}

// ─── Step 4: Remove existing stale/broken link or back up real directory ────

function removeOrBackup(state: LinkState): void {
  if (state.kind === 'broken' || state.kind === 'stale') {
    log(`  Removing ${state.kind} link: ${TARGET_LINK}`);
    if (state.kind === 'stale') {
      log(`  (was pointing at: ${(state as { kind: 'stale'; target: string }).target})`);
    }
    // Use unlinkSync for junctions/symlinks (rmSync throws EFAULT on Windows junctions)
    fs.unlinkSync(TARGET_LINK);
    return;
  }

  if (state.kind === 'real-dir') {
    const backupPath = TARGET_LINK + '.backup-' + Date.now();
    warn(
      `${TARGET_LINK} is a real directory (not a link).\n` +
      `  Backing it up to: ${backupPath}\n` +
      `  If this was intentional, merge it back manually after setup.`
    );
    fs.renameSync(TARGET_LINK, backupPath);
    return;
  }
}

// ─── Step 5: Create the link ─────────────────────────────────────────────────

function createLink(): void {
  // Dynamically select link type based on the operating system
  const linkType = IS_WINDOWS ? 'junction' : 'dir';

  try {
    fs.symlinkSync(SOURCE_DIR, TARGET_LINK, linkType);
    log(`✓ Successfully bridged across ${process.platform} using a '${linkType}' link!`);
    log(`  ${TARGET_LINK} → ${SOURCE_DIR}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    die(
      `Failed to create ${linkType}.\n` +
      `  ${msg}\n\n` +
      `Manual fallback:\n` +
      (IS_WINDOWS
        ? `  mklink /J "${TARGET_LINK}" "${SOURCE_DIR}"`
        : `  ln -s "${SOURCE_DIR}" "${TARGET_LINK}"`)
    );
  }
}

// ─── Step 6: Verify the link resolves correctly ──────────────────────────────

function verifyLink(): void {
  const state = inspectTarget();
  if (state.kind !== 'correct') {
    die(
      `Link verification failed after creation (state: ${state.kind}).\n` +
      `  Expected: ${TARGET_LINK} → ${SOURCE_DIR}\n` +
      `  Please report this as a bug in scripts/setup-antigravity.ts.`
    );
  }
  log(`✓ Verified: ${TARGET_LINK} → ${SOURCE_DIR}`);
}

// ─── Step 7: Print discovery hint ───────────────────────────────────────────

function printDiscoveryHint(): void {
  log('');
  log('─'.repeat(60));
  log('  Antigravity skill bridge ready.');
  log(`  Skills are discoverable at: ${TARGET_LINK}`);
  log('');
  if (IS_WINDOWS) {
    log('  Windows note: an NTFS junction was created. No admin required.');
    log('  To verify: dir /AL "' + path.dirname(TARGET_LINK) + '"');
  } else {
    log('  To verify: ls -la "' + path.dirname(TARGET_LINK) + '"');
  }
  log('');
  log('  To refresh skills after a git pull:');
  log('    bun run setup:antigravity');
  log('─'.repeat(60));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('');
  log('Setting up Antigravity skill bridge...');
  log('');

  // 1. Verify source
  assertSourceExists();

  // 2. Ensure ~/.agents/skills/ exists
  ensureTargetParent();

  // 3. Inspect existing state
  const state = inspectTarget();

  if (state.kind === 'correct') {
    log(`✓ Already linked correctly: ${TARGET_LINK}`);
    log(`  (${IS_WINDOWS ? 'junction' : 'symlink'} → ${SOURCE_DIR})`);
    printDiscoveryHint();
    return; // Idempotent: nothing to do
  }

  // 4. Remove stale/broken link or back up real directory
  if (state.kind !== 'none') {
    removeOrBackup(state);
  }

  // 5. Create the link
  createLink();

  // 6. Verify
  verifyLink();

  // 7. Done
  printDiscoveryHint();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  die(`Unexpected error: ${msg}`);
});
