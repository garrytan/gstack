/**
 * Upload files to Supabase Storage.
 *
 * Used by bin/gstack-upload to host screenshots in QA and design review
 * reports. Falls back gracefully to local paths when Supabase is not
 * configured, auth is expired, or the network is down.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTeamConfig, getAuthTokens } from './sync-config';
import { getRemoteSlug } from './util';
import { spawnSync } from 'child_process';

const STORAGE_BUCKET = 'screenshots';

/** Upload a screenshot to Supabase Storage, return public URL. */
export async function uploadScreenshot(
  filePath: string,
  slug?: string,
  branch?: string,
): Promise<{ url: string; isLocal: boolean }> {
  const resolvedSlug = slug || getRemoteSlug();
  const resolvedBranch = branch || getGitBranch();

  const team = getTeamConfig();
  if (!team) {
    return localFallback(filePath, 'No .gstack-sync.json found');
  }

  const auth = getAuthTokens(team.supabase_url);
  if (!auth || !auth.access_token) {
    return localFallback(filePath, 'No auth tokens — run gstack sync login');
  }

  const filename = path.basename(filePath);
  const storagePath = `${auth.team_id}/${resolvedSlug}/${resolvedBranch}/${filename}`;

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const contentType = getContentType(filename);

    const response = await fetch(
      `${team.supabase_url}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.access_token}`,
          'apikey': team.supabase_anon_key,
          'Content-Type': contentType,
          'x-upsert': 'true',
        },
        body: fileBuffer,
      },
    );

    if (!response.ok) {
      const text = await response.text();
      return localFallback(filePath, `Upload failed (${response.status}): ${text}`);
    }

    // Public URL via Supabase CDN
    const publicUrl = `${team.supabase_url}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
    return { url: publicUrl, isLocal: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return localFallback(filePath, `Network error: ${msg}`);
  }
}

function localFallback(filePath: string, reason: string): { url: string; isLocal: boolean } {
  process.stderr.write(`gstack-upload: ${reason} — using local path\n`);
  return { url: path.resolve(filePath), isLocal: true };
}

function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  return types[ext] || 'application/octet-stream';
}

function getGitBranch(): string {
  try {
    const proc = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: 'pipe',
      timeout: 2_000,
    });
    return proc.stdout?.toString().trim().replace(/\//g, '-') || 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- CLI entry point ---

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: gstack-upload <file> [--slug X] [--branch Y]');
    process.exit(1);
  }

  const file = args[0];
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  let slug: string | undefined;
  let branch: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--slug' && args[i + 1]) slug = args[++i];
    if (args[i] === '--branch' && args[i + 1]) branch = args[++i];
  }

  uploadScreenshot(file, slug, branch).then(({ url }) => {
    console.log(url);
  });
}
