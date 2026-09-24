import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dir, '../..');

export function createReadinessFixture(kind: 'ready' | 'unknown') {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-ready-'));
  const home = path.join(workDir, '.fixture-home');
  const bin = path.join(workDir, '.fixture-bin');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  const init = spawnSync('git', ['init', '--quiet'], { cwd: workDir, timeout: 10_000 });
  if (init.status !== 0) throw new Error('readiness fixture git init failed');
  fs.writeFileSync(path.join(workDir, '.gbrain-source'), 'client-fixture\n');
  const stateDir = path.join(home, '.gstack');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, '.gbrain-sync-state.json'), JSON.stringify({
    schema_version: 1, last_writer: 'gstack-gbrain-sync', last_stages: [{
      name: 'code', ran: true, ok: true,
      detail: { status: 'ok', source_id: 'client-fixture', source_path: workDir },
    }],
  }, null, 2));
  const guidance = '<!-- gstack-gbrain-search-guidance:start -->\nExisting search guidance\n<!-- gstack-gbrain-search-guidance:end -->';
  fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), kind === 'unknown' ? `# Fixture\n${guidance}\n` : '# Fixture\n');
  const skill = fs.readFileSync(path.join(root, 'sync-gbrain/SKILL.md'), 'utf8');
  const start = skill.indexOf('## Step 4: Refresh');
  const end = skill.indexOf('## Concurrency note', start);
  if (start < 0 || end < 0) throw new Error('sync-gbrain Step 4/5 fixture anchors missing');
  fs.writeFileSync(path.join(workDir, 'readiness.md'), skill.slice(start, end)
    .replaceAll('~/.claude/skills/gstack/bin/gstack-gbrain-read-capability.ts', path.join(root, 'bin/gstack-gbrain-read-capability.ts')));
  const log = path.join(home, 'gbrain-calls');
  fs.writeFileSync(path.join(bin, 'gbrain'), `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2).join(' ');
appendFileSync(${JSON.stringify(log)}, args + '\\n');
if (args === 'sources list --json') console.log(${JSON.stringify(JSON.stringify({ sources: [{ id: 'client-fixture', local_path: workDir }] }))});
else if (args === 'list --source client-fixture --limit 1') console.log('code/fixture/readme\\tcode\\t2026-09-24\\tReadme');
else if (args === 'get code/fixture/readme --source client-fixture --json') ${kind === 'ready'
    ? `console.log(${JSON.stringify(JSON.stringify({ source_id: 'client-fixture', slug: 'code/fixture/readme', content: '# Readme' }))});`
    : "{ console.error('temporary read failure'); process.exit(2); }"}
else { console.error('unsupported operation'); process.exit(3); }
`);
  fs.chmodSync(path.join(bin, 'gbrain'), 0o755);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'gbrain.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0gbrain" %*\r\n`);
  }
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const pin = fs.readFileSync(path.join(workDir, '.gbrain-source'), 'utf8');
  const state = fs.readFileSync(path.join(stateDir, '.gbrain-sync-state.json'), 'utf8');
  return {
    workDir,
    env: { HOME: home, GSTACK_HOME: stateDir, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}` },
    guidance,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [],
    content: () => fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8'),
    sourceIntact: () => fs.readFileSync(path.join(workDir, '.gbrain-source'), 'utf8') === pin
      && fs.readFileSync(path.join(stateDir, '.gbrain-sync-state.json'), 'utf8') === state
      && !fs.existsSync(path.join(workDir, 'code')),
    cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }),
  };
}
