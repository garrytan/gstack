#!/usr/bin/env bun
/**
 * Team admin CLI: gstack team <subcommand>
 *
 * Subcommands:
 *   create <slug> <name>    Create a new team (you become owner)
 *   members                 List team members
 *   set <key> <value>       Set a team setting (admin-only)
 */

import { resolveSyncConfig, isSyncConfigured } from './sync-config';
import { pullTable, getValidToken as getValidTokenFromSync } from './sync';

// --- Types ---

interface TeamMember {
  user_id: string;
  role: string;
  email?: string;
}

// --- Helpers ---

async function getValidTokenAndConfig(): Promise<{ token: string; config: ReturnType<typeof resolveSyncConfig> } | null> {
  const config = resolveSyncConfig();
  if (!config) {
    console.error('Team sync not configured. Run: gstack sync setup');
    return null;
  }
  const token = await getValidTokenFromSync(config);
  if (!token) {
    console.error('Not authenticated or token expired. Run: gstack sync setup');
    return null;
  }
  return { token, config };
}

async function supabaseRPC(
  supabaseUrl: string,
  anonKey: string,
  token: string,
  fnName: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data?: any; error?: string; status: number }> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text();
      let errorMsg: string;
      try {
        const json = JSON.parse(text);
        errorMsg = json.message || json.error || text;
      } catch {
        errorMsg = text;
      }
      return { ok: false, error: errorMsg, status: res.status };
    }

    const data = await res.json();
    return { ok: true, data, status: res.status };
  } catch (err: any) {
    return { ok: false, error: err.message, status: 0 };
  }
}

async function supabaseUpsert(
  supabaseUrl: string,
  anonKey: string,
  token: string,
  table: string,
  data: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        'Authorization': `Bearer ${token}`,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text();
      let errorMsg: string;
      try {
        const json = JSON.parse(text);
        errorMsg = json.message || json.error || text;
      } catch {
        errorMsg = text;
      }
      return { ok: false, error: errorMsg };
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// --- Formatting (pure functions) ---

/** Format team members as a terminal table. Pure function for testing. */
export function formatMembersTable(members: Record<string, unknown>[]): string {
  if (members.length === 0) return 'No team members found.\n';

  const lines: string[] = [];
  lines.push('');
  lines.push('Team Members');
  lines.push('═'.repeat(50));
  lines.push(
    '  ' +
    'Email / User ID'.padEnd(35) +
    'Role'
  );
  lines.push('─'.repeat(50));

  for (const m of members) {
    const who = String(m.email || m.user_id || 'unknown').slice(0, 33).padEnd(35);
    const role = String(m.role || 'member');
    lines.push(`  ${who}${role}`);
  }

  lines.push('─'.repeat(50));
  lines.push(`  ${members.length} member${members.length === 1 ? '' : 's'}`);
  lines.push('');
  return lines.join('\n');
}

// --- Subcommands ---

async function cmdCreate(slug: string, name: string): Promise<void> {
  const auth = await getValidTokenAndConfig();
  if (!auth) return;

  const { config } = auth;
  const result = await supabaseRPC(
    config!.team.supabase_url,
    config!.team.supabase_anon_key,
    auth.token,
    'create_team',
    { team_slug: slug, team_name: name },
  );

  if (!result.ok) {
    if (result.status === 409 || (result.error && result.error.includes('unique'))) {
      console.error(`Team slug "${slug}" is already taken. Try a different slug.`);
    } else {
      console.error(`Failed to create team: ${result.error}`);
    }
    process.exit(1);
  }

  console.log(`Team "${name}" created (slug: ${slug})`);
  console.log(`Team ID: ${result.data}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Share your .gstack-sync.json with team members (it\'s safe to commit)');
  console.log('  2. Team members run: gstack sync setup');
  console.log('  3. Add members via Supabase dashboard');
}

async function cmdMembers(): Promise<void> {
  if (!isSyncConfigured()) {
    console.error('Team sync not configured. Run: gstack sync setup');
    process.exit(1);
  }

  const members = await pullTable('team_members');
  console.log(formatMembersTable(members));
}

async function cmdSet(key: string, value: string): Promise<void> {
  const auth = await getValidTokenAndConfig();
  if (!auth) return;

  const { config } = auth;
  const teamId = config!.auth.team_id;

  const result = await supabaseUpsert(
    config!.team.supabase_url,
    config!.team.supabase_anon_key,
    auth.token,
    'team_settings',
    { team_id: teamId, key, value, updated_at: new Date().toISOString() },
  );

  if (!result.ok) {
    if (result.error && result.error.includes('policy')) {
      console.error('Permission denied. Only team admins/owners can change settings.');
    } else {
      console.error(`Failed to set ${key}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log(`Set ${key} = ${value}`);
}

function printUsage(): void {
  console.log(`
gstack team — team admin CLI

Usage: gstack team <command> [args]

Commands:
  create <slug> <name>    Create a new team (you become owner)
  members                 List team members
  set <key> <value>       Set a team setting (admin-only)

Settings:
  slack-webhook <url>     Slack webhook URL for alerts and digests
  digest-enabled <bool>   Enable/disable weekly digest (true/false)

Examples:
  gstack team create acme "Acme Engineering"
  gstack team members
  gstack team set slack-webhook https://hooks.slack.com/services/T.../B.../xxx
  gstack team set digest-enabled true
`);
}

// --- Main ---

if (import.meta.main) {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  switch (command) {
    case 'create': {
      if (args.length < 2) {
        console.error('Usage: gstack team create <slug> <name>');
        process.exit(1);
      }
      cmdCreate(args[0], args.slice(1).join(' '));
      break;
    }
    case 'members':
      cmdMembers();
      break;
    case 'set': {
      if (args.length < 2) {
        console.error('Usage: gstack team set <key> <value>');
        process.exit(1);
      }
      cmdSet(args[0], args.slice(1).join(' '));
      break;
    }
    case '--help': case '-h': case 'help': case undefined:
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}
