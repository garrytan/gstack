/**
 * EXAMPLE: Cross-platform binary execution in browse CLI
 * 
 * This file shows how to update browse/src/cli.ts
 * to handle platform-specific binary names and locations.
 * 
 * The CLI binary is compiled for different platforms, so we need
 * to handle finding the correct binary for the user's OS.
 */

// ============================================================================
// BEFORE: Assumes Unix path structure only
// ============================================================================

// import { execSync } from 'child_process';
// import * as path from 'path';
// 
// // ❌ Hardcoded Unix-style path
// const BROWSE_BIN = path.join(__dirname, '..', 'dist', 'browse');
// 
// // ❌ Assumes it's executable without checking platform
// function runBrowse(args: string[]) {
//   execSync(`${BROWSE_BIN} ${args.join(' ')}`, { stdio: 'inherit' });
// }

// ============================================================================
// AFTER: Cross-platform binary resolution
// ============================================================================

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { IS_WINDOWS, getHomeDir } from '../../lib/paths';
import { findBinary } from '../../lib/binary-locator';

/**
 * Platform-specific binary names and locations
 */
const BINARY_NAMES = {
  browse: IS_WINDOWS ? 'browse.exe' : 'browse',
  design: IS_WINDOWS ? 'design.exe' : 'design',
  pdf: IS_WINDOWS ? 'pdf.exe' : 'pdf',
};

/**
 * Get the path to a gstack binary
 * Searches in multiple locations:
 * 1. Relative to this script (local development)
 * 2. In installed skill directory (~/.claude/skills/gstack/browse/dist/)
 * 3. In system PATH
 */
async function getGstackBinary(binaryName: keyof typeof BINARY_NAMES): Promise<string> {
  const exeName = BINARY_NAMES[binaryName];
  const searchDirs = [
    // Local development: browse/dist/browse
    path.join(__dirname, '..', 'dist', exeName),
    
    // Installed via CLI: ~/.claude/skills/gstack/browse/dist/browse
    path.join(getHomeDir(), '.claude', 'skills', 'gstack', 'browse', 'dist', exeName),
    
    // Try to find in PATH (system-installed gstack)
  ];

  // Check predefined locations first
  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }

  // Fallback: search PATH for the binary
  const found = await findBinary(binaryName);
  if (found) {
    return found;
  }

  throw new Error(
    `${binaryName} binary not found.\n` +
    `Searched:\n${searchDirs.map(d => `  - ${d}`).join('\n')}\n\n` +
    `Install gstack with: cd ~/.claude/skills/gstack && ./setup`
  );
}

/**
 * Execute a gstack binary with arguments
 * Handles platform differences transparently
 */
async function runGstackBinary(
  binaryName: keyof typeof BINARY_NAMES,
  args: string[]
): Promise<void> {
  try {
    const binary = await getGstackBinary(binaryName);
    
    // On Windows, need to quote the binary path if it contains spaces
    const cmd = IS_WINDOWS && binary.includes(' ') 
      ? `"${binary}" ${args.join(' ')}`
      : `${binary} ${args.join(' ')}`;
    
    execSync(cmd, {
      stdio: 'inherit',
      shell: IS_WINDOWS ? 'cmd.exe' : '/bin/bash',
    });
  } catch (err) {
    if (err instanceof Error) {
      console.error(`✗ Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Example: CLI entry point that calls browse with args
 */
async function main() {
  const args = process.argv.slice(2);
  
  try {
    await runGstackBinary('browse', args);
  } catch (err) {
    console.error('Failed to run browse:', err);
    process.exit(1);
  }
}

// ============================================================================
// ALTERNATIVE: If building the binary as part of this CLI
// ============================================================================

/**
 * Get the output path for the compiled binary
 * Creates platform-specific output names for multi-platform builds
 */
function getBinaryOutputPath(binaryName: string, platform?: string, arch?: string): string {
  // If building for current platform only
  if (!platform) {
    platform = process.platform;
  }
  if (!arch) {
    arch = process.arch;
  }

  const exeName = IS_WINDOWS ? `${binaryName}.exe` : binaryName;
  
  // Output: browse-darwin-arm64, browse-linux-x64, browse-win32-x64.exe, etc.
  const outputName = `${binaryName}-${platform}-${arch}${IS_WINDOWS ? '.exe' : ''}`;
  const distDir = path.join(__dirname, '..', 'dist');
  
  return path.join(distDir, outputName);
}

/**
 * Build binaries for all platforms
 * This would be called from package.json build script
 */
async function buildForAllPlatforms() {
  const platforms = [
    { name: 'darwin', arch: 'arm64' },  // macOS ARM64
    { name: 'darwin', arch: 'x64' },    // macOS Intel
    { name: 'linux', arch: 'x64' },     // Linux
    { name: 'linux', arch: 'arm64' },   // Linux ARM
    { name: 'win32', arch: 'x64' },     // Windows
  ];

  for (const target of platforms) {
    console.log(`Building for ${target.name}-${target.arch}...`);
    
    const output = getBinaryOutputPath('browse', target.name, target.arch);
    
    // Call bun build with platform target
    // Note: As of 2026, Bun may support cross-compilation via --target flag
    // Example: bun build --compile --target darwin-arm64 src/cli.ts --outfile output
    
    // For now, this documents what the command would look like:
    // execSync(`bun build --compile --target ${target.name}-${target.arch} src/cli.ts --outfile ${output}`);
    
    console.log(`Would build: bun build --compile --target ${target.name}-${target.arch} ... -> ${output}`);
  }
}

export {
  getGstackBinary,
  runGstackBinary,
  getBinaryOutputPath,
  buildForAllPlatforms,
  main,
};

// If run directly
if (require.main === module || import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
