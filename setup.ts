#!/usr/bin/env node
/**
 * gstack setup — cross-platform installation script
 * 
 * Builds browser/design/pdf binaries and registers skills with Claude Code and other agents
 * Works on Windows, macOS, and Linux
 * 
 * Usage:
 *   node setup.ts [--host claude|codex|kiro|factory|opencode|auto]
 *   ./setup-node.mjs [--host claude|codex|factory|opencode|auto]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Determine script directory (works in both CommonJS and ESM)
const __filename = typeof module !== 'undefined' ? module.filename : fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INSTALL_GSTACK_DIR = __dirname;
const SOURCE_GSTACK_DIR = __dirname;
const INSTALL_SKILLS_DIR = path.dirname(INSTALL_GSTACK_DIR);
const BROWSE_BIN = path.join(SOURCE_GSTACK_DIR, 'browse', 'dist', 'browse');

const IS_WINDOWS = process.platform === 'win32';
const HOME = os.homedir();

const CLAUDE_SKILLS = path.join(HOME, '.claude', 'skills');
const CLAUDE_GSTACK = path.join(CLAUDE_SKILLS, 'gstack');

const CODEX_SKILLS = path.join(HOME, '.codex', 'skills');
const CODEX_GSTACK = path.join(CODEX_SKILLS, 'gstack');

const FACTORY_SKILLS = path.join(HOME, '.factory', 'skills');
const FACTORY_GSTACK = path.join(FACTORY_SKILLS, 'gstack');

const KIRO_SKILLS = path.join(HOME, '.kiro', 'skills');
const KIRO_GSTACK = path.join(KIRO_SKILLS, 'gstack');

const OPENCODE_SKILLS = path.join(HOME, '.config', 'opencode', 'skills');
const OPENCODE_GSTACK = path.join(OPENCODE_SKILLS, 'gstack');

/**
 * Log with color (if supported)
 */
function log(message, color = 'reset') {
  const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
  };
  const code = colors[color] || colors.reset;
  console.log(`${code}${message}${colors.reset}`);
}

/**
 * Log error
 */
function error(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
}

/**
 * Log success
 */
function success(message) {
  log(`✓ ${message}`, 'green');
}

/**
 * Check if bun is installed
 */
function checkBun() {
  try {
    const result = execSync('bun --version', { encoding: 'utf-8' });
    success(`bun is installed: ${result.trim()}`);
    return true;
  } catch {
    error('bun is required but not installed');
    console.error('Install with: curl -fsSL https://bun.sh/install | bash');
    process.exit(1);
  }
}

/**
 * Build binaries using bun
 */
function buildBinaries() {
  log('\n📦 Building binaries...', 'blue');
  
  try {
    // Note: Bun doesn't have built-in cross-compilation yet
    // This builds for the current platform only
    // For true cross-platform builds, you'd need to run build on each platform or use other tools
    
    const buildCmd = 'bun run build';
    log(`Running: ${buildCmd}`, 'yellow');
    
    execSync(buildCmd, {
      cwd: SOURCE_GSTACK_DIR,
      stdio: 'inherit',
    });
    
    success('Binaries built successfully');
    return true;
  } catch (err) {
    error(`Build failed: ${err.message}`);
    return false;
  }
}

/**
 * Check if host is installed
 */
function isHostInstalled(hostCmd) {
  try {
    execSync(`${hostCmd} --version`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create symlink or copy directory
 */
function linkSkills(from, to, hostName) {
  try {
    // Create parent directory if needed
    const parentDir = path.dirname(to);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });
    }

    // Remove old symlink/directory if it exists
    if (fs.existsSync(to)) {
      const stat = fs.lstatSync(to);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(to);
      } else if (stat.isDirectory()) {
        // Keep existing directory, just log warning
        log(`⚠ ${to} already exists, skipping`, 'yellow');
        return true;
      }
    }

    // Try to create symlink (cross-platform)
    try {
      fs.symlinkSync(from, to, IS_WINDOWS ? 'dir' : 'dir');
      success(`${hostName}: registered to ${to}`);
      return true;
    } catch (symErr) {
      // Fallback: copy directory if symlink fails (e.g., Windows without admin)
      log(`⚠ Symlink failed, copying directory instead...`, 'yellow');
      copyDirectory(from, to);
      success(`${hostName}: registered to ${to} (copied)`);
      return true;
    }
  } catch (err) {
    error(`Failed to register ${hostName} at ${to}: ${err.message}`);
    return false;
  }
}

/**
 * Recursively copy directory
 */
function copyDirectory(from, to) {
  if (!fs.existsSync(to)) {
    fs.mkdirSync(to, { recursive: true, mode: 0o755 });
  }

  for (const file of fs.readdirSync(from)) {
    const src = path.join(from, file);
    const dst = path.join(to, file);
    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
      copyDirectory(src, dst);
    } else {
      fs.copyFileSync(src, dst);
      // Make scripts executable
      if (file.startsWith('gstack-') || file === 'setup') {
        fs.chmodSync(dst, 0o755);
      }
    }
  }
}

/**
 * Main setup function
 */
function main() {
  log('\n🚀 gstack setup', 'blue');
  log(`Platform: ${process.platform} (${IS_WINDOWS ? 'Windows' : 'Unix-like'})`);
  log(`Home: ${HOME}`);
  log(`gstack: ${SOURCE_GSTACK_DIR}\n`);

  // Check prerequisites
  checkBun();

  // Build binaries
  if (!buildBinaries()) {
    process.exit(1);
  }

  // Register with installed hosts
  log('\n🔗 Registering with installed hosts...', 'blue');

  let registered = false;

  // Check Claude Code
  if (isHostInstalled('claude')) {
    linkSkills(SOURCE_GSTACK_DIR, CLAUDE_GSTACK, 'Claude Code');
    registered = true;
  }

  // Check Codex
  if (isHostInstalled('codex')) {
    linkSkills(SOURCE_GSTACK_DIR, CODEX_GSTACK, 'Codex');
    registered = true;
  }

  // Check Factory
  if (isHostInstalled('factory')) {
    linkSkills(SOURCE_GSTACK_DIR, FACTORY_GSTACK, 'Factory');
    registered = true;
  }

  // Check Kiro
  if (isHostInstalled('kiro-cli')) {
    linkSkills(SOURCE_GSTACK_DIR, KIRO_GSTACK, 'Kiro');
    registered = true;
  }

  // Check OpenCode
  if (isHostInstalled('opencode')) {
    linkSkills(SOURCE_GSTACK_DIR, OPENCODE_GSTACK, 'OpenCode');
    registered = true;
  }

  if (!registered) {
    log('\n⚠ No AI agents detected on this system', 'yellow');
    log('Install Claude Code, Codex, or another agent to use gstack\n');
    process.exit(1);
  }

  success('\n✓ Setup complete!');
  log('You can now use gstack skills in your AI agent\n', 'green');
}

// Run
main();
