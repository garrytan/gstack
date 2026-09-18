import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SHARD_TIMEOUT_MS } from '../scripts/test-paid-shards';

const casePath = path.join(import.meta.dir, 'skill-e2e-office-hours-section-loading.test.ts');

// Evaluate the real case registration with inert test/describe functions.
// Imports are removed, and the captured paid callback is never invoked.
function registeredOptions(): { timeout: number; retry: number } {
  const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(fs.readFileSync(casePath, 'utf8'))
    .replace(/^import\b[^;]*;\s*$/gm, '');
  const registrations: unknown[] = [];
  new Function('test', 'describeE2ETier', source)(
    (_name: string, _callback: unknown, options: unknown) => registrations.push(options),
    () => (_name: string, register: () => void) => register(),
  );
  expect(registrations).toHaveLength(1);
  return registrations[0] as { timeout: number; retry: number };
}

test('office-hours has one bounded attempt even under the paid runner CLI retry default', () => {
  const options = registeredOptions();
  expect(options).toEqual({ timeout: 1_260_000, retry: 0 });
  expect(options.timeout + 120_000).toBeLessThanOrEqual(DEFAULT_SHARD_TIMEOUT_MS);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-office-hours-retry-'));
  try {
    const fake = path.join(dir, 'retry.test.ts');
    fs.writeFileSync(fake, `import { afterAll, expect, test } from 'bun:test';
let defaults = 0, officeHours = 0, two = 0;
test('default retry', () => { defaults++; expect(defaults).toBe(2); });
test('office-hours retry', () => {
  officeHours++; throw new Error('intentional single-attempt failure');
}, ${JSON.stringify(options)});
test('existing two retries', () => { two++; expect(two).toBe(3); }, { retry: 2 });
afterAll(() => console.log('ATTEMPTS=' + JSON.stringify({ defaults, officeHours, two })));
`);
    const child = Bun.spawnSync([process.execPath, 'test', '--retry', '1', fake], {
      cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode).toBe(1); // the deliberate single-attempt failure stays failed
    const attempts = output.match(/ATTEMPTS=(\{[^\n]+\})/);
    expect(attempts, output).not.toBeNull();
    expect(JSON.parse(attempts![1])).toEqual({ defaults: 2, officeHours: 1, two: 3 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
