import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-oracle');

afterAll(() => {
  finalizeEvalCollector(evalCollector);
});

// --- Oracle E2E Tests ---

describeIfSelected('Oracle — bootstrap produces valid PRODUCT_MAP.md', ['oracle-bootstrap'], () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-oracle-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: projectDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Create a minimal app with a few features
    fs.mkdirSync(path.join(projectDir, 'src', 'pages'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src', 'components'), { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'oracle-test-app',
      version: '1.0.0',
      dependencies: { 'react': '^18.0.0', 'react-router-dom': '^6.0.0' },
    }, null, 2));

    fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'es2020', module: 'esnext', jsx: 'react-jsx' },
    }, null, 2));

    fs.writeFileSync(path.join(projectDir, 'src', 'pages', 'Dashboard.tsx'),
      'import React from "react";\nexport default function Dashboard() { return <div>Dashboard</div>; }\n');
    fs.writeFileSync(path.join(projectDir, 'src', 'pages', 'Login.tsx'),
      'import React from "react";\nexport default function Login() { return <div>Login</div>; }\n');
    fs.writeFileSync(path.join(projectDir, 'src', 'components', 'Header.tsx'),
      'import React from "react";\nexport function Header() { return <header>Header</header>; }\n');

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: initial app with dashboard and login']);
  });

  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('oracle bootstrap generates PRODUCT_MAP.md', async () => {
    const result = await runSkillTest({
      testName: 'oracle-bootstrap',
      prompt: '/oracle',
      cwd: projectDir,
      timeout: 120_000,
    });

    logCost(result);
    recordE2E(evalCollector, 'oracle-bootstrap', result);

    // Oracle should have created or attempted to create a product map
    const output = result.output?.toLowerCase() ?? '';
    const productMapPath = path.join(projectDir, 'docs', 'oracle', 'PRODUCT_MAP.md');
    const mapExists = fs.existsSync(productMapPath);

    // Either the map was created, or the output mentions product map / bootstrap
    expect(mapExists || output.includes('product map') || output.includes('bootstrap')).toBe(true);

    if (mapExists) {
      const content = fs.readFileSync(productMapPath, 'utf-8');
      // Should have required structural markers
      expect(content).toContain('## Product Arc');
      expect(content).toContain('## Features');
    }
  }, 180_000);
});

describeIfSelected('Oracle — scan produces valid manifest', ['oracle-scan'], () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-oracle-scan-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: projectDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.mkdirSync(path.join(projectDir, 'src', 'pages'), { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'oracle-scan-test',
      dependencies: { 'react': '^18.0.0', 'react-router-dom': '^6.0.0' },
    }, null, 2));

    fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'es2020', module: 'esnext', jsx: 'react-jsx' },
    }, null, 2));

    fs.writeFileSync(path.join(projectDir, 'src', 'pages', 'Home.tsx'),
      'import React from "react";\nexport default function Home() { return <div>Home</div>; }\n');

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);
  });

  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('scanner produces valid JSON manifest', () => {
    const scanBin = path.join(ROOT, 'oracle', 'bin', 'scan-imports.ts');
    const result = spawnSync('bun', ['run', scanBin, '--root', projectDir], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 30_000,
    });

    const stdout = result.stdout?.toString() ?? '';
    expect(stdout.length).toBeGreaterThan(0);

    const manifest = JSON.parse(stdout);
    expect(manifest.schema_version).toBe(1);
    expect(manifest.project).toBeTruthy();
    expect(manifest.total_files).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(manifest.routes)).toBe(true);
    expect(typeof manifest.content_hash).toBe('string');
    // head_sha should be present (design decision #4)
    expect(typeof manifest.head_sha).toBe('string');
  }, 60_000);
});
