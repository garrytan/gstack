import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT_PATH = path.join(import.meta.dir, '../../bin/gstack-learnings-search');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const BIN_DIR = path.join(import.meta.dir, '../../bin');

describe('gstack-learnings-search injection safety', () => {
  it('must not interpolate variables into JS string literals', () => {
    const jsBlock = SCRIPT.slice(SCRIPT.indexOf('bun -e'));
    expect(jsBlock).not.toMatch(/const \w+ = '\$\{/);
    expect(jsBlock).not.toMatch(/= \$\{[A-Z_]+\};/);
    expect(jsBlock).not.toMatch(/'\$\{CROSS_PROJECT\}'/);
  });

  it('must use process.env for parameters', () => {
    const jsBlock = SCRIPT.slice(SCRIPT.indexOf('bun -e'));
    expect(jsBlock).toContain('process.env');
  });
});

describe('gstack-learnings-search injection behavioral', () => {
  it('handles single quotes in query safely', () => {
    const result = spawnSync('bash', [
      path.join(BIN_DIR, 'gstack-learnings-search'),
      '--query', "test'; process.exit(99); //",
      '--limit', '1'
    ], { encoding: 'utf-8', timeout: 5000, env: { ...process.env, HOME: '/tmp/nonexistent-gstack-test' } });
    expect(result.status).not.toBe(99);
  });
});
