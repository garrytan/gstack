import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureRuntimePayloads,
  REQUIRED_RUNTIME_PAYLOADS,
  type RuntimePayloadEntry,
} from '../scripts/gstack2/ensure-runtime-payloads';

const ROOT = path.resolve(import.meta.dir, '..');
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gstack2-runtime-payloads-'));
  temporaryRoots.push(root);
  return root;
}

async function writePayloads(root: string, entries: readonly RuntimePayloadEntry[]): Promise<void> {
  for (const entry of entries) {
    const target = path.join(root, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'fixture payload\n');
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('GStack 2 generated runtime payload prerequisites', () => {
  test('builds all absent parity payloads once and verifies the result', async () => {
    const root = await temporaryRoot();
    const calls: RuntimePayloadEntry[][] = [];

    const result = await ensureRuntimePayloads({
      sourceDir: root,
      builder: async ({ missing }) => {
        calls.push([...missing]);
        await writePayloads(root, missing);
      },
    });

    expect(result.built).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].map((entry) => entry.path)).toEqual(REQUIRED_RUNTIME_PAYLOADS.map((entry) => entry.path));
    expect(new Set(calls[0].map((entry) => entry.build))).toEqual(new Set(['core']));
  });

  test('does not rebuild payloads that already exist', async () => {
    const root = await temporaryRoot();
    await writePayloads(root, REQUIRED_RUNTIME_PAYLOADS);

    const result = await ensureRuntimePayloads({
      sourceDir: root,
      builder: async () => { throw new Error('complete payloads must not rebuild'); },
    });

    expect(result.built).toBe(false);
  });

  test('fails when the builder leaves a required payload absent', async () => {
    const root = await temporaryRoot();

    await expect(ensureRuntimePayloads({
      sourceDir: root,
      builder: async ({ missing }) => writePayloads(root, missing.slice(0, -1)),
    })).rejects.toThrow(`Runtime payload build did not produce: ${REQUIRED_RUNTIME_PAYLOADS.at(-1)?.path}`);
  });

  test('canonical generation and parity commands prepare payloads before use', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const buildScript = await fs.readFile(path.join(ROOT, 'scripts', 'build.sh'), 'utf8');
    const cleanVerifier = await fs.readFile(
      path.join(ROOT, 'scripts', 'gstack2', 'verify-clean-generation.ts'),
      'utf8',
    );

    expect(pkg.scripts['gen:gstack2']).toStartWith('bun run ensure:gstack2-runtime');
    expect(pkg.scripts['test:gstack2:parity']).toStartWith('bun run ensure:gstack2-runtime');
    expect(pkg.scripts['verify:gstack2-clean-generation'])
      .toBe('bun run scripts/gstack2/verify-clean-generation.ts');
    expect(cleanVerifier).toContain("spawnSync(process.execPath, ['run', 'gen:gstack2']");
    expect(cleanVerifier).toContain('Clean-generation probe requires absent runtime payloads');
    expect(buildScript.indexOf('build --compile browse/src/cli.ts')).toBeLessThan(
      buildScript.indexOf('run gen:gstack2'),
    );
  });
});
