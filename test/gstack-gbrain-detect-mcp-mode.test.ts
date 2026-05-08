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
      'gbrain_mcp_mode',
      'gbrain_on_path',
      'gbrain_version',
      'gstack_artifacts_remote',
      'gstack_brain_git',
      'gstack_brain_sync_mode',
    ]);
  });
});
