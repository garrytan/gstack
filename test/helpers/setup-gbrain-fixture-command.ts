/** Child-only CLI for the owned setup-gbrain fixtures. Never log raw argv/env. */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const [controlPath, command, ...args] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(controlPath!, 'utf8')) as {
  root: string; repo: string; token: string; url: string;
};
const redact = (text: string) => text.replaceAll(control.token, '[REDACTED_FIXTURE_TOKEN]');
const logPath = path.join(control.root, 'commands.jsonl');
const statePath = path.join(control.root, 'mcp-state.json');
const configPath = path.join(control.root, 'home', '.gbrain', 'config.json');
const id = randomUUID();
function log(record: Record<string, unknown>) {
  fs.appendFileSync(logPath, redact(JSON.stringify({ id, command, ...record })) + '\n', { mode: 0o600 });
}
const auth = args.find((arg) => /^Authorization: Bearer /i.test(arg))?.slice('Authorization: Bearer '.length);
log({
  phase: 'start', args,
  tokenPresent: !!process.env.GBRAIN_MCP_TOKEN,
  tokenMatches: process.env.GBRAIN_MCP_TOKEN === control.token,
  authorizationPresent: !!auth, authorizationMatches: auth === control.token,
  homeMatches: process.env.HOME === path.join(control.root, 'home'),
  gstackHomeMatches: process.env.GSTACK_HOME === path.join(control.root, 'state'),
});

let stdout = '';
let stderr = '';
let exitCode = 0;
try {
  if (command === 'claude') {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    switch (args.slice(0, 2).join(' ')) {
      case 'mcp get':
        if (!state.registered) exitCode = 1;
        else stdout = JSON.stringify({ type: 'http', url: state.url }) + '\n';
        break;
      case 'mcp list':
        stdout = state.registered ? `gbrain: ${state.url} (HTTP) — ✓ Connected\n` : 'No MCP servers configured\n';
        break;
      case 'mcp remove':
        fs.writeFileSync(statePath, JSON.stringify({ registered: false }), { mode: 0o600 });
        break;
      case 'mcp add': {
        const transport = args.indexOf('--transport');
        const url = args.find((arg) => /^https?:\/\//.test(arg));
        if (transport < 0 || args[transport + 1] !== 'http' || url !== control.url || auth !== control.token) {
          stderr = 'fixture MCP registration requires the configured HTTP URL and bearer\n';
          exitCode = 1;
        } else {
          // Credential presence/match is evidence; the credential itself is never persisted here.
          fs.writeFileSync(statePath, JSON.stringify({ registered: true, url }), { mode: 0o600 });
        }
        break;
      }
      default: stderr = 'fixture claude only supports mcp commands\n'; exitCode = 2;
    }
  } else if (command === 'gbrain') {
    if (args[0] === '--version') stdout = 'gbrain 0.33.1.0\n';
    else if (args[0] === 'init' && args.includes('--pglite')) {
      fs.writeFileSync(configPath, JSON.stringify({ engine: 'pglite', database_url: 'pglite:///fake' }));
      stdout = '{"status":"ok","engine":"pglite"}\n';
    } else if (args[0] === 'doctor') {
      stdout = JSON.stringify({ status: fs.existsSync(configPath) ? 'ok' : 'error' }) + '\n';
    } else if (args[0] === 'sources' && args[1] === 'list') stdout = '[]\n';
    else if (args[0] === 'search') stdout = '[]\n';
    else { stderr = 'unsupported fixture gbrain command\n'; exitCode = 2; }
  } else if (command === 'gstack-gbrain-install') {
    stdout = 'fixture gbrain CLI ready\n';
  } else {
    // Execute the checked-in helper at its real location so relative imports
    // and the verifier's egress receipt library still resolve correctly.
    const child = Bun.spawn([path.join(control.repo, 'bin', command!), ...args], {
      env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
  }
} catch (error) {
  stderr = error instanceof Error ? error.message : String(error);
  exitCode = 1;
}
log({ phase: 'end', exitCode, stdout, stderr });
process.stdout.write(redact(stdout));
process.stderr.write(redact(stderr));
process.exit(exitCode);
