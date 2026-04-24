#!/usr/bin/env node
/**
 * Cross-platform build helper for gstack binaries
 * 
 * Builds binaries for the current platform + creates appropriate naming/linking
 * 
 * Current Bun limitation: can only compile for the current platform
 * Workaround: Run this script on each target platform (Windows, macOS, Linux)
 * 
 * Future: When Bun supports --target flag, add cross-compilation
 * 
 * Usage:
 *   node scripts/build-binaries.js
 *   # or if you have bun:
 *   bun scripts/build-binaries.ts
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname.replace('/scripts', '');
const IS_WINDOWS = process.platform === 'win32';
const PLATFORM = process.platform;
const ARCH = process.arch;
const HAS_BUN = (() => {
  try {
    execSync('bun --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

interface Binary {
  name: string;
  source: string;
  distDir: string;
  baseNames: string[]; // All names this binary should have
}

const BINARIES = [
  {
    name: 'browse',
    source: 'browse/src/cli.ts',
    distDir: 'browse/dist',
    baseNames: ['browse', 'find-browse-cli'],
  },
  {
    name: 'find-browse',
    source: 'browse/src/find-browse.ts',
    distDir: 'browse/dist',
    baseNames: ['find-browse'],
  },
  {
    name: 'design',
    source: 'design/src/cli.ts',
    distDir: 'design/dist',
    baseNames: ['design'],
  },
  {
    name: 'pdf',
    source: 'make-pdf/src/cli.ts',
    distDir: 'make-pdf/dist',
    baseNames: ['pdf', 'make-pdf-cli'],
  },
  {
    name: 'gstack-global-discover',
    source: 'bin/gstack-global-discover.ts',
    distDir: 'bin',
    baseNames: ['gstack-global-discover'],
  },
];
  {
    name: 'browse',
    source: 'browse/src/cli.ts',
    distDir: 'browse/dist',
    baseNames: ['browse', 'find-browse-cli'],
  },
  {
    name: 'find-browse',
    source: 'browse/src/find-browse.ts',
    distDir: 'browse/dist',
    baseNames: ['find-browse'],
  },
  {
    name: 'design',
    source: 'design/src/cli.ts',
    distDir: 'design/dist',
    baseNames: ['design'],
  },
  {
    name: 'pdf',
    source: 'make-pdf/src/cli.ts',
    distDir: 'make-pdf/dist',
    baseNames: ['pdf', 'make-pdf-cli'],
  },
  {
    name: 'gstack-global-discover',
    source: 'bin/gstack-global-discover.ts',
    distDir: 'bin',
    baseNames: ['gstack-global-discover'],
  },
];

/**
 * Get the output filename for a binary (includes .exe on Windows)
 */
function getOutputName(baseName: string): string {
  if (IS_WINDOWS) {
    return `${baseName}.exe`;
  }
  return baseName;
}

/**
 * Get the output path for a binary with platform-arch suffix
 * Example: browse-darwin-arm64, browse-win32-x64.exe
 */
function getPlatformBinaryName(baseName: string): string {
  const nameWithPlatform = `${baseName}-${PLATFORM}-${ARCH}`;
  return getOutputName(nameWithPlatform);
}

/**
 * Build a single binary
 */
function buildBinary(binary) {
  const outputName = getOutputName(binary.name);
  const outputPath = path.join(ROOT, binary.distDir, outputName);
  const distDir = path.join(ROOT, binary.distDir);

  // Ensure dist directory exists
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  console.log(`\n📦 Building ${binary.name}...`);
  console.log(`   Source: ${binary.source}`);
  console.log(`   Output: ${outputPath}`);

  try {
    const cmd = `bun build --compile "${binary.source}" --outfile "${outputPath}"`;
    console.log(`   Command: ${cmd}`);
    execSync(cmd, {
      cwd: ROOT,
      stdio: 'inherit',
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error(`Build succeeded but file not created: ${outputPath}`);
    }

    // Make executable on Unix
    if (!IS_WINDOWS) {
      fs.chmodSync(outputPath, 0o755);
    }

    console.log(`   ✓ Built successfully`);
  } catch (err) {
    console.error(`   ✗ Build failed: ${err.message}`);
    throw err;
  }
}

/**
 * Create symlinks/aliases from base names to platform-specific binary
 * Example: browse -> browse-darwin-arm64, make-pdf -> pdf-darwin-arm64
 */
function createBinaryAliases(binary) {
  const distDir = path.join(ROOT, binary.distDir);
  const outputName = getOutputName(binary.name);
  const platformBinaryName = getPlatformBinaryName(binary.name);
  const platformBinaryPath = path.join(distDir, platformBinaryName);

  // For each base name, create an alias
  for (const baseName of binary.baseNames) {
    const aliasName = getOutputName(baseName);
    const aliasPath = path.join(distDir, aliasName);

    // Remove old alias if it exists
    if (fs.existsSync(aliasPath)) {
      try {
        fs.unlinkSync(aliasPath);
      } catch {
        // Already deleted or in use
      }
    }

    // Create symlink (or copy on Windows)
    try {
      if (IS_WINDOWS) {
        // Windows: can't easily symlink without admin, so copy
        fs.copyFileSync(platformBinaryPath, aliasPath);
      } else {
        // Unix: create symlink
        const relativePath = path.basename(platformBinaryName);
        fs.symlinkSync(relativePath, aliasPath);
      }
      console.log(`   ✓ Alias: ${aliasName} -> ${platformBinaryName}`);
    } catch (err) {
      console.error(`   ✗ Failed to create alias ${aliasName}: ${err.message}`);
      // Don't fail the build for this
    }
  }
}

/**
 * Write version hash to .version file
 */
function writeVersionFile(distDir) {
  try {
    const versionHash = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
    const versionFile = path.join(ROOT, distDir, '.version');
    fs.writeFileSync(versionFile, versionHash);
    console.log(`   ✓ Version hash: ${versionHash.slice(0, 8)}`);
  } catch (err) {
    console.warn(`   ⚠ Could not get git version: ${err.message}`);
  }
}

/**
 * Build node server bundle for Windows (compatibility layer)
 */
function buildNodeServer() {
  console.log(`\n📦 Building Node.js server bundle...`);
  try {
    execSync('bash browse/scripts/build-node-server.sh', {
      cwd: ROOT,
      stdio: 'inherit',
    });
    console.log(`   ✓ Node.js server bundle built`);
  } catch (err) {
    console.warn(`   ⚠ Node.js server build skipped: ${err.message}`);
  }
}

/**
 * Main build function
 */
async function main() {
  console.log(`\n🚀 gstack cross-platform build`);
  console.log(`   Platform: ${PLATFORM}-${ARCH}`);
  console.log(`   OS Type: ${IS_WINDOWS ? 'Windows' : 'Unix-like'}`);
  console.log(`   Bun available: ${HAS_BUN ? 'yes' : 'no'}`);
  console.log(`   Root: ${ROOT}`);

  if (!HAS_BUN) {
    console.warn(`\n⚠️  Bun not found. To compile binaries, install Bun:`);
    console.warn(`   curl -fsSL https://bun.sh/install | bash`);
    console.warn(`\n   This script requires Bun to compile TypeScript/CLI binaries.`);
    process.exit(1);
  }

  try {
    // Build all binaries
    for (const binary of BINARIES) {
      buildBinary(binary);
      createBinaryAliases(binary);
      writeVersionFile(binary.distDir);
    }

    // Build Node.js server bundle (for Windows compatibility)
    buildNodeServer();

    // Make binaries executable (already done above, but ensure)
    if (!IS_WINDOWS) {
      const binFiles = [
        'browse/dist/browse',
        'browse/dist/find-browse',
        'design/dist/design',
        'make-pdf/dist/pdf',
        'bin/gstack-global-discover',
      ];
      for (const file of binFiles) {
        const fullPath = path.join(ROOT, file);
        try {
          if (fs.existsSync(fullPath)) {
            fs.chmodSync(fullPath, 0o755);
          }
        } catch (err) {
          console.warn(`   ⚠ Could not chmod ${file}: ${err.message}`);
        }
      }
    }

    console.log(`\n✅ Build complete!`);
    console.log(`\n📝 Next steps:`);
    console.log(`   1. Test binaries: ./browse/dist/browse --help`);
    console.log(`   2. Verify paths work on your platform`);
    if (!IS_WINDOWS) {
      console.log(`   3. If using WSL on Windows, test from cmd.exe too`);
    }
    console.log(`\n💡 Platform-specific builds:`);
    console.log(`   Run this script on each platform you want to support:`);
    console.log(`   - Windows (x64): node scripts/build-binaries.ts`);
    console.log(`   - macOS ARM64: node scripts/build-binaries.ts`);
    console.log(`   - macOS Intel: node scripts/build-binaries.ts`);
    console.log(`   - Linux (x64): node scripts/build-binaries.ts`);

    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Build failed!`);
    console.error(err);
    process.exit(1);
  }
}

main();
