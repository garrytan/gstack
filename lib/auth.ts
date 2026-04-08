/**
 * Device auth flow for team sync.
 *
 * Opens a browser for Supabase OAuth/magic link, polls for completion,
 * and saves tokens to ~/.gstack/auth.json.
 *
 * Two modes:
 *   1. Magic link: user enters email → receives link → CLI detects auth via polling
 *   2. Browser OAuth: opens Supabase auth page → callback to localhost → CLI captures token
 *
 * For CI: set GSTACK_SUPABASE_ACCESS_TOKEN env var to skip interactive auth.
 */

import * as http from 'http';
import { saveAuthTokens, type TeamConfig, type AuthTokens } from './sync-config';

const AUTH_CALLBACK_PORT = 54321;
const AUTH_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Run the interactive device auth flow.
 *
 * 1. Starts a local HTTP server on port 54321
 * 2. Opens the Supabase auth page in the browser (with redirect to localhost)
 * 3. Waits for the auth callback with tokens
 * 4. Saves tokens and returns them
 */
export async function runDeviceAuth(team: TeamConfig): Promise<AuthTokens> {
  return new Promise<AuthTokens>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Auth timed out after 5 minutes. Please try again.'));
    }, AUTH_TIMEOUT_MS);

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${AUTH_CALLBACK_PORT}`);

      // Handle the OAuth callback
      if (url.pathname === '/auth/callback') {
        const accessToken = url.searchParams.get('access_token') || url.hash?.match(/access_token=([^&]+)/)?.[1];
        const refreshToken = url.searchParams.get('refresh_token') || '';
        const expiresIn = parseInt(url.searchParams.get('expires_in') || '3600', 10);

        if (!accessToken) {
          // Serve a page that extracts tokens from the URL hash (Supabase puts them there)
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(authCallbackHTML(AUTH_CALLBACK_PORT));
          return;
        }

        const tokens: AuthTokens = {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: Math.floor(Date.now() / 1000) + expiresIn,
          user_id: url.searchParams.get('user_id') || '',
          team_id: '',
          email: url.searchParams.get('email') || '',
        };

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(authSuccessHTML());

        clearTimeout(timeout);
        server.close();

        // Resolve team_id from team_members table before saving
        try {
          const teamId = await resolveTeamId(team, tokens.access_token, tokens.user_id);
          if (teamId) tokens.team_id = teamId;
        } catch { /* non-fatal — team_id can be resolved later */ }

        // Save tokens
        try {
          saveAuthTokens(team.supabase_url, tokens);
        } catch (err: any) {
          reject(new Error(`Failed to save auth tokens: ${err.message}`));
          return;
        }

        resolve(tokens);
        return;
      }

      // Handle token POST from the callback page
      if (url.pathname === '/auth/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const tokens: AuthTokens = {
              access_token: data.access_token || '',
              refresh_token: data.refresh_token || '',
              expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
              user_id: data.user?.id || '',
              team_id: '',
              email: data.user?.email || '',
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

            clearTimeout(timeout);
            server.close();

            // Resolve team_id before saving
            try {
              const teamId = await resolveTeamId(team, tokens.access_token, tokens.user_id);
              if (teamId) tokens.team_id = teamId;
            } catch { /* non-fatal */ }

            saveAuthTokens(team.supabase_url, tokens);
            resolve(tokens);
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(AUTH_CALLBACK_PORT, '127.0.0.1', () => {
      const authUrl = buildAuthUrl(team.supabase_url, AUTH_CALLBACK_PORT);
      console.log(`\nOpening browser for authentication...`);
      console.log(`If the browser doesn't open, visit:\n  ${authUrl}\n`);
      openBrowser(authUrl);
    });

    server.on('error', (err: any) => {
      clearTimeout(timeout);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${AUTH_CALLBACK_PORT} is in use. Close the other process and try again.`));
      } else {
        reject(err);
      }
    });
  });
}

/** Build the Supabase auth URL with localhost callback. */
function buildAuthUrl(supabaseUrl: string, port: number): string {
  const redirectTo = `http://localhost:${port}/auth/callback`;
  return `${supabaseUrl}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(redirectTo)}`;
}

/** Open a URL in the default browser. */
function openBrowser(url: string): void {
  const { spawnSync } = require('child_process');
  // macOS
  if (process.platform === 'darwin') {
    spawnSync('open', [url], { stdio: 'ignore' });
    return;
  }
  // Linux
  if (process.platform === 'linux') {
    spawnSync('xdg-open', [url], { stdio: 'ignore' });
    return;
  }
  // Windows
  if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', url], { stdio: 'ignore' });
  }
}

/** HTML page that extracts tokens from URL hash and POSTs them to the local server. */
function authCallbackHTML(port: number): string {
  return `<!DOCTYPE html>
<html>
<head><title>gstack auth</title></head>
<body>
<h2>Completing authentication...</h2>
<p id="status">Extracting tokens...</p>
<script>
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const data = {
    access_token: params.get('access_token'),
    refresh_token: params.get('refresh_token'),
    expires_in: parseInt(params.get('expires_in') || '3600'),
    user: { id: '', email: '' }
  };
  if (data.access_token) {
    fetch('http://localhost:${port}/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(() => {
      document.getElementById('status').textContent = 'Authenticated! You can close this tab.';
    }).catch(err => {
      document.getElementById('status').textContent = 'Error: ' + err.message;
    });
  } else {
    document.getElementById('status').textContent = 'No tokens found in URL. Please try again.';
  }
</script>
</body>
</html>`;
}

/** HTML page shown after successful auth. */
function authSuccessHTML(): string {
  return `<!DOCTYPE html>
<html>
<head><title>gstack auth</title></head>
<body>
<h2>Authenticated!</h2>
<p>You can close this tab and return to your terminal.</p>
</body>
</html>`;
}

/**
 * Check if the current auth token is expired (or will expire within 5 minutes).
 */
export function isTokenExpired(tokens: AuthTokens): boolean {
  if (!tokens.expires_at) return false;  // env-var tokens don't expire
  const buffer = 300; // 5-minute buffer
  return Math.floor(Date.now() / 1000) >= tokens.expires_at - buffer;
}

/**
 * Look up the user's team_id from team_members table after auth.
 * Returns the first team_id found, or null if the lookup fails.
 */
async function resolveTeamId(team: TeamConfig, accessToken: string, userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const url = `${team.supabase_url}/rest/v1/team_members?user_id=eq.${userId}&select=team_id&limit=1`;
    const res = await fetch(url, {
      headers: {
        'apikey': team.supabase_anon_key,
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) return null;
    const rows = await res.json() as Array<{ team_id: string }>;
    return rows.length > 0 ? rows[0].team_id : null;
  } catch {
    return null;
  }
}
