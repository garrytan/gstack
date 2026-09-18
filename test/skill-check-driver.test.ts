/** The public checker must never certify a partial render after generation fails.
 * Preloads run in fresh Bun children, so generator mocks cannot leak into a shard.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const GENERATION_ERROR = 'fixture renderer failed: EACCES on Codex metadata';

function runChecker(mode: 'success' | 'partial' | 'throw') {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill-check-driver-'));
  const scratchRoot = path.join(fixture, 'scratch');
  const receipt = path.join(fixture, 'render-receipt.json');
  const preload = path.join(fixture, 'generation-preload.ts');
  fs.mkdirSync(scratchRoot);
  try {
    fs.writeFileSync(preload, `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs';
      import * as path from 'node:path';
      mock.module(${JSON.stringify(path.join(ROOT, 'scripts/gen-skill-docs.ts'))}, () => ({
        runGeneration: async (options) => {
          // A valid, tracked artifact would pass the ordinary content/freshness
          // checks. Only the generator's failure status prevents false success.
          const relativePath = 'health/SKILL.md';
          const destination = path.join(options.outputRoot, relativePath);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(${JSON.stringify(path.join(ROOT, 'health/SKILL.md'))}, destination);
          fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
            scratch: options.outputRoot, host: options.host,
            contentLinkRoot: options.contentLinkRoot,
            artifactWritten: fs.statSync(destination).size > 0,
          }));
          if (${JSON.stringify(mode)} === 'throw') throw new Error(${JSON.stringify(GENERATION_ERROR)});
          return {
            exitCode: ${mode === 'partial' ? 1 : 0},
            artifacts: [{ relativePath, kind: 'skill', host: 'claude' }],
            diagnostics: ${mode === 'partial'
              ? JSON.stringify([{ kind: 'error', host: 'codex', message: GENERATION_ERROR }])
              : '[]'},
          };
        },
      }));
    `);
    const child = Bun.spawnSync([
      process.execPath, '--preload', preload, path.join(ROOT, 'scripts/skill-check.ts'),
    ], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      env: { ...process.env, TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot },
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(fs.existsSync(receipt), output).toBe(true);
    const rendered = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    expect(rendered).toMatchObject({ host: 'all', contentLinkRoot: null, artifactWritten: true });
    expect(path.dirname(rendered.scratch)).toBe(scratchRoot);
    // The actual driver allocates and removes this directory, even on throws.
    expect(fs.existsSync(rendered.scratch)).toBe(false);
    expect(fs.readdirSync(scratchRoot)).toEqual([]);
    return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString(), output };
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

describe('skill:check generation completion gate', () => {
  test('the control artifact is valid and fresh, and the CLI cleans its render', () => {
    const result = runChecker('success');
    expect(result.exitCode, result.output).toBe(0);
    expect(result.stdout).toContain('Checked 1 generated artifacts; 1 tracked outputs compared.');
    expect(result.stderr).toBe('');
  });

  test('a failed all-host render cannot pass with only its valid partial output', () => {
    const result = runChecker('partial');
    expect(result.exitCode, result.output).toBe(1);
    expect(result.stdout).toContain(`ERROR: codex: ${GENERATION_ERROR}`);
    expect(result.stderr).toContain('Generation failed; freshness and content checks require a complete render.');
    expect(result.output).not.toContain('generated skills checked');
    expect(result.output).not.toContain('tracked outputs compared');
  });

  test('a thrown renderer error preserves its diagnostic and still cleans scratch', () => {
    const result = runChecker('throw');
    expect(result.exitCode, result.output).toBe(1);
    expect(result.stderr).toContain(`ERROR: ${GENERATION_ERROR}`);
    expect(result.output).not.toContain('generated skills checked');
    expect(result.output).not.toContain('tracked outputs compared');
  });
});
