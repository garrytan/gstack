import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const macos = process.platform === 'darwin';
const required = process.env.GSTACK_CSO_MACOS_TESTS === '1';
if (required && !macos) throw new Error('GSTACK_CSO_MACOS_TESTS=1 requires native macOS; emulation does not qualify the launcher.');
let temporary = '', marker = '', library = '';

beforeAll(() => {
  if (!macos) return;
  temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gstack-cso-macos-'));
  marker = path.join(temporary, 'dyld-constructor-ran');
  library = path.join(temporary, 'hostile.dylib');
  const source = path.join(temporary, 'hostile.c');
  fs.writeFileSync(source, '#include <fcntl.h>\n#include <stdlib.h>\n#include <unistd.h>\n__attribute__((constructor)) static void mark(void){const char*p=getenv("CSO_PRELOAD_MARKER");if(p){int f=open(p,O_WRONLY|O_CREAT,0600);if(f>=0)close(f);}}\n');
  const built = spawnSync('/usr/bin/clang', ['-dynamiclib', source, '-o', library], { encoding: 'utf8', timeout: 30_000 });
  expect(built.status).toBe(0);
}, 40_000);

afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

describe('CSO native macOS build contract', () => {
  test('macOS CI runs native signature and injection checks', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/free-tests.yml'), 'utf8')) as any;
    const job = workflow.jobs['cso-macos-launcher'];
    expect(job['runs-on']).toBe('macos-latest');
    expect(job.steps.some((step: any) => step.run === 'bun run build:cso')).toBe(true);
    const gate = job.steps.find((step: any) => step.run === 'bun run test:cso:macos');
    expect(gate.env.GSTACK_CSO_MACOS_TESTS).toBe('1');
    expect(gate['continue-on-error']).not.toBe(true);
  });
});

(macos ? describe : describe.skip)('CSO native macOS startup', () => {
  test('the public launcher has a valid hardened-runtime signature', () => {
    const launcher = path.join(ROOT, 'bin', 'gstack-cso-launcher');
    const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', launcher], { encoding: 'utf8', timeout: 30_000 });
    expect(verified.status).toBe(0);
    const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', launcher], { encoding: 'utf8', timeout: 30_000 });
    expect(details.status).toBe(0);
    expect(details.stderr).toMatch(/flags=.*runtime/);
  });

  test('DYLD constructor injection cannot run before the launcher scrubs the environment', () => {
    const launcher = path.join(ROOT, 'bin', 'gstack-cso-launcher');
    const result = spawnSync(launcher, ['--version'], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: temporary, GSTACK_HOME: path.join(temporary, 'state'), DYLD_INSERT_LIBRARIES: library, CSO_PRELOAD_MARKER: marker },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: '3.0.0', abi: 3 });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
