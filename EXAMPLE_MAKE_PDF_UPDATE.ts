/**
 * EXAMPLE: Cross-platform make-pdf updates
 * 
 * This file shows how to update make-pdf/src/pdftotext.ts
 * to use the new cross-platform utilities.
 * 
 * Replace the hardcoded `/usr/local/bin/pdftotext` lookup with
 * platform-aware binary detection.
 */

// ============================================================================
// BEFORE: Hardcoded Unix paths (doesn't work on Windows)
// ============================================================================

// import { execSync } from 'child_process';
// 
// async function locatePdftotext(): Promise<string> {
//   const paths = [
//     '/usr/local/bin/pdftotext',        // Intel Mac or Linuxbrew
//     '/usr/bin/pdftotext',               // Standard Linux
//     '/opt/homebrew/bin/pdftotext',      // Apple Silicon Mac
//     process.env.PATH?.split(':').map(p => `${p}/pdftotext`) || [], // Try PATH
//   ].flat().filter(Boolean);
//   
//   for (const path of paths) {
//     try {
//       execSync(`test -x "${path}"`, { stdio: 'pipe' });
//       return path;
//     } catch {
//       // Path doesn't exist, try next
//     }
//   }
//   
//   throw new Error(
//     'pdftotext not found. Install with:\n' +
//     '  macOS: brew install poppler\n' +
//     '  Linux: apt-get install poppler-utils\n' +
//     '  Windows: https://blog.alivate.com.au/poppler-windows/'
//   );
// }

// ============================================================================
// AFTER: Using cross-platform binary locator
// ============================================================================

import * as path from 'path';
import { findBinary, describeSearchPaths, BinaryNotFoundError } from '../../lib/binary-locator';

/**
 * Locate pdftotext binary using cross-platform search
 * 
 * Searches in platform-specific locations:
 * - Windows: Program Files, Scoop, Chocolatey, user PATH
 * - macOS: Homebrew (Intel and Apple Silicon), /usr/local/bin
 * - Linux: /usr/bin, /usr/local/bin, snap
 */
async function locatePdftotext(): Promise<string> {
  const pdftotext = await findBinary('pdftotext');
  
  if (pdftotext) {
    return pdftotext;
  }

  // Not found — provide helpful error message
  const searchInfo = describeSearchPaths('pdftotext');
  throw new Error(
    'pdftotext not found.\n\n' +
    'Install poppler:\n' +
    '  macOS:   brew install poppler\n' +
    '  Linux:   apt-get install poppler-utils  (or dnf/pacman)\n' +
    '  Windows: Download from https://github.com/oschwartz10612/poppler-windows/releases/\n' +
    '           Extract to Program Files\\poppler\n\n' +
    searchInfo
  );
}

/**
 * Example usage in pdf conversion function
 */
async function convertPdfToText(pdfPath: string, outputPath: string): Promise<void> {
  const pdftotext = await locatePdftotext();
  
  // pdftotext is now an absolute path, works on all platforms
  const { execFileSync } = await import('child_process');
  
  try {
    execFileSync(pdftotext, [pdfPath, outputPath], {
      stdio: 'inherit',
      timeout: 30000,
    });
  } catch (err) {
    throw new Error(`PDF conversion failed: ${err.message}`);
  }
}

// ============================================================================
// USAGE: Call the async function in your setup/initialization code
// ============================================================================

async function setupPdftotext() {
  try {
    const pdftotextPath = await locatePdftotext();
    console.log(`✓ Found pdftotext at: ${pdftotextPath}`);
    return pdftotextPath;
  } catch (err) {
    if (err instanceof Error && err.name === 'BinaryNotFoundError') {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export { locatePdftotext, setupPdftotext, convertPdfToText };
