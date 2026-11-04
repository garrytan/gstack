/**
 * gstack-gbrain-detect — gbrain_mcp_mode + gstack_artifacts_remote tests.
 *
 * The script has a 3-tier fallback chain for resolving gbrain_mcp_mode:
 *   1. `claude mcp get gbrain --json` (preferred — public CLI surface)
 *   2. `claude mcp list` text-grep (older claude versions without --json)
 *   3. `~/.claude.json` jq read (fallback if claude binary is absent)
 *
 * Each layer is tested by mocking the layer it depends on. Per codex
 * Finding #3 (defense-in-depth ordering): if Anthropic moves the
 * ~/.claude.json file format, the first two tiers should still work.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const DETECT_BIN = path.join(ROOT, 'bin', 'gstack-gbrain-detect');

let tmpHome: string;
let fakeBinDir: string;

function makeFakeClaude(opts: {
  hasGetJson?: boolean;
  getJsonOutput?: string; // raw JSON string
  hasMcpList?: boolean;
  mcpListOutput?: string;
  exitOnAll?: number; // if set, claude always exits with this code
}) {
  const { hasGetJson, getJsonOutput, hasMcpList, mcpListOutput, exitOnAll } = opts;
  const script = `#!/bin/bash
${exitOnAll !== undefined ? `exit ${exitOnAll}` : ''}
case "$1 $2" in
  "mcp get")
    if [ "$3" = "gbrain" ] && [ "$4" = "--json" ]; then
      ${hasGetJson ? `cat <<'JSON'
${getJsonOutput || '{}'}
JSON` : 'exit 1'}
      exit 0
    fi
    ;;
  "mcp list")
    ${hasMcpList ? `cat <<'EOM'
${mcpListOutput || ''}
EOM` : 'exit 1'}
    exit 0
    ;;
esac
exit 1
`;
  fs.writeFileSync(path.join(fakeBinDir, 'claude'), script, { mode: 0o755 });
}

function runDetect(extraEnv: Record<string, string> = {}): { code: number; json: any; stderr: string } {
  const realPath = process.env.PATH ?? '';
  const r = spawnSync(DETECT_BIN, [], {
    env: {
      // Put fakeBinDir first so our claude shim wins; include the project bin
      // for any sibling scripts and standard paths for jq/etc.
      PATH: `${fakeBinDir}:${path.join(ROOT, 'bin')}:${realPath}`,
      HOME: tmpHome,
      GSTACK_HOME: path.join(tmpHome, '.gstack'),
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout || '{}');
  } catch {
    json = null;
  }
  return { code: r.status ?? -1, json, stderr: r.stderr || '' };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-mcp-mode-'));
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-fake-bin-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

describe('gbrain_mcp_mode — Tier 1: claude mcp get --json', () => {
  test('type=http → remote-http', () => {
    makeFakeClaude({
      hasGetJson: true,
      getJsonOutput: JSON.stringify({ type: 'http', url: 'https://example.com/mcp' }),
    });
    const r = runDetect();
    expect(r.code).toBe(0);
    expect(r.json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('type=stdio → local-stdio', () => {
    makeFakeClaude({
      hasGetJson: true,
      getJsonOutput: JSON.stringify({ type: 'stdio', command: '/usr/local/bin/gbrain' }),
    });
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });

  test('type=sse → remote-http', () => {
    makeFakeClaude({
      hasGetJson: true,
      getJsonOutput: JSON.stringify({ type: 'sse', url: 'https://example.com/sse' }),
    });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('no type field but has url → remote-http (newer claude shape)', () => {
    makeFakeClaude({
      hasGetJson: true,
      getJsonOutput: JSON.stringify({ url: 'https://example.com/mcp' }),
    });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('no type field but has command → local-stdio', () => {
    makeFakeClaude({
      hasGetJson: true,
      getJsonOutput: JSON.stringify({ command: '/path/to/gbrain' }),
    });
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });
});

describe('gbrain_mcp_mode — Tier 2: claude mcp list text-grep', () => {
  test('falls back to mcp list when get --json fails', () => {
    makeFakeClaude({
      hasGetJson: false,
      hasMcpList: true,
      mcpListOutput: 'gbrain: https://wintermute.tail554574.ts.net:3131/mcp (HTTP) - ✓ Connected',
    });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('mcp list text-grep with stdio entry → local-stdio', () => {
    makeFakeClaude({
      hasGetJson: false,
      hasMcpList: true,
      mcpListOutput: 'gbrain: /usr/local/bin/gbrain serve - ✓ Connected',
    });
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });

  test('mcp list with no gbrain entry → none', () => {
    makeFakeClaude({
      hasGetJson: false,
      hasMcpList: true,
      mcpListOutput: 'posthog: https://mcp.posthog.com/mcp (HTTP)\nslack: https://slack.com/mcp (HTTP)',
    });
    expect(runDetect().json.gbrain_mcp_mode).toBe('none');
  });
});

describe('gbrain_mcp_mode — Tier 3: ~/.claude.json jq read', () => {
  test('reads mcpServers.gbrain.type=url → remote-http', () => {
    // No fake claude binary; force fallback to file read.
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { gbrain: { type: 'url', url: 'https://example.com/mcp' } },
      })
    );
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('reads mcpServers.gbrain.type=stdio → local-stdio', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { gbrain: { type: 'stdio', command: '/path/gbrain' } },
      })
    );
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });

  test('infers from url field if type is missing', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { gbrain: { url: 'https://example.com/mcp' } },
      })
    );
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('infers from command field if type is missing', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { gbrain: { command: '/path/gbrain' } },
      })
    );
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });

  test('no gbrain entry in ~/.claude.json → none', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({ mcpServers: { posthog: { type: 'url', url: 'https://x' } } })
    );
    expect(runDetect().json.gbrain_mcp_mode).toBe('none');
  });

  // #2051 name generalization: a gbrain server registered under a variant
  // name still counts. Identification order: url-match against the config's
  // remote_mcp.mcp_url (deterministic — gbrain mounts at generic /mcp so
  // URL-path heuristics are impossible) → name pattern gbrain[-_]* → stdio
  // command token.
  test('server named gbrain-remote (name pattern) → remote-http', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { 'gbrain-remote': { type: 'url', url: 'https://brain.corp.example/mcp' } },
      })
    );
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('arbitrarily-named server whose url matches config remote_mcp.mcp_url → remote-http', () => {
    fs.mkdirSync(path.join(tmpHome, '.gbrain'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gbrain', 'config.json'),
      JSON.stringify({ remote_mcp: { mcp_url: 'https://team-brain.example.com/mcp' } })
    );
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { 'our-team-brain': { type: 'url', url: 'https://team-brain.example.com/mcp' } },
      })
    );
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('unrelated server with a non-matching url does NOT false-positive → none', () => {
    fs.mkdirSync(path.join(tmpHome, '.gbrain'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gbrain', 'config.json'),
      JSON.stringify({ remote_mcp: { mcp_url: 'https://team-brain.example.com/mcp' } })
    );
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { linear: { type: 'url', url: 'https://mcp.linear.app/mcp' } },
      })
    );
    expect(runDetect().json.gbrain_mcp_mode).toBe('none');
  });

  test('stdio server with gbrain in the command token → local-stdio', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { 'my-brain': { type: 'stdio', command: '/usr/local/bin/gbrain' } },
      })
    );
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });
});

// #3539: a loopback `gbrain serve --http` over this machine's own engine is a
// local brain. It reports local-stdio (the local-engine mode every consumer
// already understands), in all three tiers.
describe('gbrain_mcp_mode — loopback serve --http over a local engine (#3539)', () => {
  const LOOPBACK = 'http://127.0.0.1:3131/mcp';
  function localEngine(extra: Record<string, unknown> = {}, dir = tmpHome): void {
    fs.mkdirSync(path.join(dir, '.gbrain'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: 'postgresql://u@localhost:5432/brain', ...extra }),
    );
  }

  test('tier 1: loopback http entry + local engine → local-stdio', () => {
    localEngine();
    makeFakeClaude({ hasGetJson: true, getJsonOutput: JSON.stringify({ type: 'http', url: LOOPBACK }) });
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });

  test('tier 2: loopback URL on the mcp list line + local engine → local-stdio', () => {
    localEngine();
    makeFakeClaude({ hasGetJson: false, hasMcpList: true, mcpListOutput: `gbrain: ${LOOPBACK} (HTTP) - ✓ Connected` });
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });

  test('tier 3: loopback http entry + local engine under GBRAIN_HOME → local-stdio', () => {
    const gbrainHome = path.join(tmpHome, 'gb');
    localEngine({}, gbrainHome);
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({ mcpServers: { gbrain: { type: 'http', url: LOOPBACK, headers: { Authorization: 'Bearer x' } } } })
    );
    expect(runDetect({ GBRAIN_HOME: gbrainHome }).json.gbrain_mcp_mode).toBe('local-stdio');
  });

  test('loopback entry without a local engine config stays remote-http', () => {
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { type: 'http', url: LOOPBACK } } }));
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('loopback entry with remote_mcp in the config stays remote-http', () => {
    localEngine({ remote_mcp: { mcp_url: 'https://team-brain.example.com/mcp' } });
    makeFakeClaude({ hasGetJson: false, hasMcpList: true, mcpListOutput: `gbrain: ${LOOPBACK} (HTTP) - ✓ Connected` });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('non-loopback entry with a local engine stays remote-http', () => {
    localEngine();
    makeFakeClaude({ hasGetJson: true, getJsonOutput: JSON.stringify({ type: 'http', url: 'https://brain.example.com/mcp' }) });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  // Tier 2 classifies the whole URL token. A URL cut at ")" or at whitespace
  // would read these remote hosts as 127.0.0.1 / localhost.
  test.each([
    'gbrain: http://127.0.0.1)@evil.com/mcp (HTTP) - ✓ Connected',
    'gbrain: http://localhost)@evil.com/mcp (HTTP) - ✓ Connected',
    'gbrain: http://127.0.0.1 (HTTP)@evil.com/mcp (HTTP) - ✓ Connected',
    'gbrain: http://127.0.0.1\t.evil.com/mcp (HTTP) - ✓ Connected',
    'gbrain: ws://127.0.0.1:3131/mcp (HTTP) - ✓ Connected',
    'gbrain: http://127.0.0.1.evil.example/mcp (HTTP) - ✓ Connected',
    'gbrain: HTTP server, url hidden - ✓ Connected',
  ])('tier 2: %s → remote-http (local engine present)', (line: string) => {
    localEngine();
    makeFakeClaude({ hasGetJson: false, hasMcpList: true, mcpListOutput: line });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('tier 2: a loopback URL with a ")" in its path is still local', () => {
    localEngine();
    makeFakeClaude({ hasGetJson: false, hasMcpList: true, mcpListOutput: 'gbrain: http://127.0.0.1:3131/mcp(x) (HTTP) - ✓ Connected' });
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });

  // (SSE) lines carry no "http" word. Before, they fell through to
  // local-stdio even for a remote host.
  test('tier 2: remote (SSE) line → remote-http', () => {
    localEngine();
    makeFakeClaude({ hasGetJson: false, hasMcpList: true, mcpListOutput: 'gbrain: https://brain.example.com/sse (SSE) - ✓ Connected' });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('tier 2: loopback (SSE) line over a local engine → local-stdio', () => {
    localEngine();
    makeFakeClaude({ hasGetJson: false, hasMcpList: true, mcpListOutput: 'gbrain: http://localhost:3131/sse (SSE) - ✓ Connected' });
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });

  // Several gbrain servers: the exact `gbrain:` line wins whatever the list
  // order (the .claude.json insertion order), as in tier 3 and memory-ingest.
  test.each([
    ['variant first', `gbrain-a: ${LOOPBACK} (HTTP) - ✓ Connected\ngbrain: https://team.example.com/mcp (HTTP) - ✓ Connected`],
    ['exact first', `gbrain: https://team.example.com/mcp (HTTP) - ✓ Connected\ngbrain-a: ${LOOPBACK} (HTTP) - ✓ Connected`],
  ])('tier 2: loopback gbrain-a + remote gbrain (%s) → remote-http', (_order: string, list: string) => {
    localEngine();
    makeFakeClaude({ hasGetJson: false, hasMcpList: true, mcpListOutput: list });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test.each([
    ['variant first', `gbrain_work: https://team.example.com/mcp (HTTP) - ✓ Connected\ngbrain: ${LOOPBACK} (HTTP) - ✓ Connected`],
    ['exact first', `gbrain: ${LOOPBACK} (HTTP) - ✓ Connected\ngbrain_work: https://team.example.com/mcp (HTTP) - ✓ Connected`],
  ])('tier 2: loopback gbrain + remote gbrain_work (%s) → local-stdio', (_order: string, list: string) => {
    localEngine();
    makeFakeClaude({ hasGetJson: false, hasMcpList: true, mcpListOutput: list });
    expect(runDetect().json.gbrain_mcp_mode).toBe('local-stdio');
  });

  test('tier 2: with no exact gbrain line, the first gbrain[-_]* line counts', () => {
    localEngine();
    makeFakeClaude({
      hasGetJson: false,
      hasMcpList: true,
      mcpListOutput: `posthog: https://mcp.posthog.com/mcp (HTTP)\ngbrain-remote: https://team.example.com/mcp (HTTP) - ✓ Connected\ngbrain-a: ${LOOPBACK} (HTTP) - ✓ Connected`,
    });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  test('tier 2: loopback (SSE) line without a local engine → remote-http', () => {
    makeFakeClaude({ hasGetJson: false, hasMcpList: true, mcpListOutput: 'gbrain: http://localhost:3131/sse (SSE) - ✓ Connected' });
    expect(runDetect().json.gbrain_mcp_mode).toBe('remote-http');
  });

  // detect's two fields must agree for the same loopback entry: local-stdio
  // never sits next to thin-client, and remote-http never next to a local
  // engine's own failure.
  function fakeGbrainSourcesFails(message: string): void {
    fs.writeFileSync(
      path.join(fakeBinDir, 'gbrain'),
      [
        '#!/bin/bash',
        'case "$1" in',
        '  --version|version) echo "gbrain 0.60.472.0"; exit 0 ;;',
        `  sources) echo "${message}" >&2; exit 1 ;;`,
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }

  test('a loopback entry over a locked local PGLite reads remote-http + thin-client (Path 4 split-engine)', () => {
    fs.mkdirSync(path.join(tmpHome, '.gbrain'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: '/x/brain.pglite' }));
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { type: 'http', url: LOOPBACK } } }));
    fakeGbrainSourcesFails("GBrain's local database is already open through gbrain serve (MCP, PID 4242). This brain uses PGLite");
    const { json } = runDetect();
    expect(json.gbrain_mcp_mode).toBe('remote-http');
    expect(json.gbrain_local_status).toBe('thin-client');
  });

  test('a loopback entry over a failing local Postgres stays local-stdio and keeps its own status', () => {
    localEngine();
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { type: 'http', url: LOOPBACK } } }));
    fakeGbrainSourcesFails('error: connect ECONNREFUSED 127.0.0.1:5432');
    const { json } = runDetect();
    expect(json.gbrain_mcp_mode).toBe('local-stdio');
    expect(json.gbrain_local_status).not.toBe('thin-client');
  });
});

describe('gbrain_mcp_mode — no info anywhere', () => {
  test('no claude binary AND no ~/.claude.json → none', () => {
    // No fake claude, no file.
    expect(runDetect().json.gbrain_mcp_mode).toBe('none');
  });
});

describe('gstack_artifacts_remote', () => {
  test('reads ~/.gstack-artifacts-remote.txt when present', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-artifacts-remote.txt'),
      'https://github.com/garrytan/gstack-artifacts-garrytan\n'
    );
    expect(runDetect().json.gstack_artifacts_remote).toBe(
      'https://github.com/garrytan/gstack-artifacts-garrytan'
    );
  });

  test('migration-window fallback: reads ~/.gstack-brain-remote.txt if artifacts file is missing', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-brain-remote.txt'),
      'git@github.com:garrytan/gstack-brain-garrytan.git\n'
    );
    expect(runDetect().json.gstack_artifacts_remote).toBe(
      'git@github.com:garrytan/gstack-brain-garrytan.git'
    );
  });

  test('artifacts file wins over brain file when both exist', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-artifacts-remote.txt'),
      'https://github.com/x/new\n'
    );
    fs.writeFileSync(
      path.join(tmpHome, '.gstack-brain-remote.txt'),
      'https://github.com/x/old\n'
    );
    expect(runDetect().json.gstack_artifacts_remote).toBe('https://github.com/x/new');
  });

  test('empty when neither file exists', () => {
    expect(runDetect().json.gstack_artifacts_remote).toBe('');
  });
});

describe('schema regression', () => {
  test('output JSON has all expected keys (sync-gbrain compat)', () => {
    const r = runDetect();
    expect(r.code).toBe(0);
    const keys = Object.keys(r.json).sort();
    expect(keys).toEqual([
      'gbrain_config_exists',
      'gbrain_doctor_ok',
      'gbrain_engine',
      'gbrain_local_status',
      'gbrain_mcp_mode',
      'gbrain_on_path',
      // PR #1591 added gbrain_pooler_mode for PgBouncer transaction-mode
      // detection. Keep alphabetized; downstream sync-gbrain ignores unknown
      // keys so adding here is forward-compat.
      'gbrain_pooler_mode',
      'gbrain_version',
      'gstack_artifacts_remote',
      'gstack_brain_git',
      'gstack_brain_sync_mode',
    ]);
  });
});
