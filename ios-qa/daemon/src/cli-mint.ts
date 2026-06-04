// Owner-grant CLI. Adds (or upgrades) an identity to the allowlist so a
// remote agent on the tailnet can self-service mint a session token via
// POST /auth/mint. Never auto-allowlists; explicit user intent only.
//
// Invoked from bin/gstack-ios-qa-mint.

import { grantIdentity, revokeIdentity, loadAllowlist, defaultAllowlistPath } from './allowlist';
import type { Capability } from './types';

const CAPABILITIES: Capability[] = ['observe', 'interact', 'mutate', 'restore'];

interface ParsedArgs {
  command: 'grant' | 'revoke' | 'list' | 'help';
  identity: string | null;
  capability: Capability;
  ttlSeconds: number | null;
  note: string | null;
  path: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  // Default: help. Recognized positional commands: grant | revoke | list.
  let command: ParsedArgs['command'] = 'help';
  let identity: string | null = null;
  let capability: Capability = 'interact';
  let ttlSeconds: number | null = null;
  let note: string | null = null;
  let path = defaultAllowlistPath();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case 'grant': command = 'grant'; break;
      case 'revoke': command = 'revoke'; break;
      case 'list': command = 'list'; break;
      case '--help':
      case '-h': command = 'help'; break;
      case '--remote':
      case '--identity':
        identity = argv[++i] ?? null;
        break;
      case '--capability':
      case '--cap': {
        const v = argv[++i];
        if (!CAPABILITIES.includes(v as Capability)) {
          process.stderr.write(`unknown capability: ${v} (want one of ${CAPABILITIES.join(', ')})\n`);
          process.exit(2);
        }
        capability = v as Capability;
        break;
      }
      case '--ttl': {
        const v = parseInt(argv[++i] ?? '', 10);
        if (!Number.isFinite(v) || v <= 0) {
          process.stderr.write('--ttl must be a positive integer (seconds)\n');
          process.exit(2);
        }
        ttlSeconds = v;
        break;
      }
      case '--note': note = argv[++i] ?? null; break;
      case '--allowlist-path': path = argv[++i] ?? path; break;
    }
  }
  return { command, identity, capability, ttlSeconds, note, path };
}

function printHelp() {
  const help = `gstack-ios-qa-mint — manage the tailnet allowlist for remote iOS QA agents

USAGE
  gstack-ios-qa-mint grant  --remote <identity> [--capability <tier>] [--ttl <seconds>] [--note <text>]
  gstack-ios-qa-mint revoke --remote <identity>
  gstack-ios-qa-mint list

ARGUMENTS
  --remote <identity>     Canonical tailnet identity (e.g. user@example.com or tag:ci).
  --capability <tier>     observe | interact (default) | mutate | restore
  --ttl <seconds>         Optional expiry. Omit for no-expiry entry.
  --note <text>           Free-form note kept alongside the entry.
  --allowlist-path <path> Override the allowlist file location.

EXAMPLES
  gstack-ios-qa-mint grant --remote 'alice@example.com' --capability interact
  gstack-ios-qa-mint grant --remote 'tag:ci' --capability mutate --ttl 86400 --note 'nightly run'
  gstack-ios-qa-mint revoke --remote 'alice@example.com'
  gstack-ios-qa-mint list

The allowlist lives at ~/.gstack/ios-qa-allowlist.json (mode 0600). The daemon's
self-service /auth/mint endpoint reads this file on every request.
`;
  process.stdout.write(help);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    printHelp();
    return;
  }

  if (args.command === 'list') {
    const allowlist = await loadAllowlist(args.path);
    if (allowlist.entries.length === 0) {
      process.stdout.write('(empty allowlist)\n');
      return;
    }
    for (const e of allowlist.entries) {
      const caps = e.capabilities.join(',');
      const exp = e.expires_at ? ` expires=${e.expires_at}` : '';
      const note = e.note ? ` note="${e.note}"` : '';
      process.stdout.write(`${e.identity}  cap=${caps}${exp}${note}\n`);
    }
    return;
  }

  if (!args.identity) {
    process.stderr.write('error: --remote <identity> required\n');
    process.exit(2);
  }

  if (args.command === 'grant') {
    const result = await grantIdentity({
      identity: args.identity,
      capability: args.capability,
      ttlSeconds: args.ttlSeconds,
      note: args.note ?? undefined,
      path: args.path,
    });
    const entry = result.entries.find(e => e.identity === args.identity);
    process.stdout.write(`granted ${args.identity} capability=${args.capability}` +
      (entry?.expires_at ? ` expires=${entry.expires_at}` : '') + '\n');
    return;
  }

  if (args.command === 'revoke') {
    await revokeIdentity(args.identity, args.path);
    process.stdout.write(`revoked ${args.identity}\n`);
    return;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`gstack-ios-qa-mint: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
