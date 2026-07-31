import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  if (start === -1) return '';
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe('setup runtime roots include lib/ beside bin/', () => {
  test('Codex .agents sidecar links lib/ with runtime assets', () => {
    const body = fnBody(SETUP, 'create_agents_sidecar');
    expect(body).toContain('for asset in bin browse review qa lib');
  });

  test('Codex, Factory, OpenCode, and Kiro runtime roots install lib/', () => {
    expect(fnBody(SETUP, 'create_codex_runtime_root')).toContain('_link_or_copy "$gstack_dir/lib" "$codex_gstack/lib"');
    expect(fnBody(SETUP, 'create_factory_runtime_root')).toContain('_link_or_copy "$gstack_dir/lib" "$factory_gstack/lib"');
    expect(fnBody(SETUP, 'create_opencode_runtime_root')).toContain('_link_or_copy "$gstack_dir/lib" "$opencode_gstack/lib"');
    expect(SETUP).toContain('_link_or_copy "$SOURCE_GSTACK_DIR/lib" "$KIRO_GSTACK/lib"');
  });
});

describe.skipIf(process.platform === 'win32')('gstack-learnings-log sidecar runtime', () => {
  test('runs from .agents/skills/gstack/bin when lib/ is linked beside bin/', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sidecar-lib-'));
    try {
      const project = path.join(tmp, 'project');
      const runtime = path.join(project, '.agents', 'skills', 'gstack');
      const gstackHome = path.join(tmp, 'gstack-home');
      fs.mkdirSync(runtime, { recursive: true });
      fs.mkdirSync(gstackHome, { recursive: true });
      fs.symlinkSync(path.join(ROOT, 'bin'), path.join(runtime, 'bin'), 'dir');
      fs.symlinkSync(path.join(ROOT, 'lib'), path.join(runtime, 'lib'), 'dir');

      fs.mkdirSync(project, { recursive: true });
      spawnSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: project, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: project, stdio: 'ignore' });
      fs.writeFileSync(path.join(project, 'app.ts'), 'console.log("hello");\n');
      spawnSync('git', ['add', '.'], { cwd: project, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: project, stdio: 'ignore' });

      const learning = JSON.stringify({
        skill: 'ship',
        type: 'operational',
        key: 'sidecar-lib-import',
        insight: 'sidecar runtime can import shared jsonl-store',
        confidence: 9,
        source: 'observed',
      });
      const result = spawnSync(path.join(runtime, 'bin', 'gstack-learnings-log'), [learning], {
        cwd: project,
        env: { ...process.env, HOME: tmp, GSTACK_HOME: gstackHome },
        encoding: 'utf-8',
        timeout: 15_000,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Cannot find module');

      const projectDirs = fs.readdirSync(path.join(gstackHome, 'projects'));
      expect(projectDirs.length).toBeGreaterThan(0);
      const learningsFile = path.join(gstackHome, 'projects', projectDirs[0], 'learnings.jsonl');
      expect(fs.readFileSync(learningsFile, 'utf-8')).toContain('sidecar-lib-import');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
