import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateDesignShotgunLoop } from '../scripts/resolvers/design';
import { HOST_PATHS } from '../scripts/resolvers/types';

test('generated board reload sends an expanded, JSON-escaped path as data', () => {
  const rendered = generateDesignShotgunLoop({ host: 'claude', skillName: 'design-consultation',
    tmplPath: 'design-consultation/SKILL.md.tmpl', paths: HOST_PATHS.claude });
  const command = rendered.match(/^   `(.*curl .*api\/reload.*)`$/m)?.[1];
  expect(command).toBeDefined();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-board-reload-'));
  const designDir = path.join(dir, `screens ' " $cash $(touch NEVER)\nnext`);
  try {
    // Capture curl's JSON body without a network connection, supporting either
    // the old -d argument or the corrected stdin transport.
    const result = spawnSync('bash', ['-c', `set -e -o pipefail
curl() {
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -d ]; then printf '%s' "$2"; return; fi
    if [ "$1" = --data-binary ] && [ "$2" = @- ]; then cat; return; fi
    shift
  done
  return 2
}
${command}`], { cwd: dir, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, _DESIGN_DIR: designDir, BOARD_URL: 'http://unused.invalid/board/' } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ html: `${designDir}/design-board.html` });
    expect(fs.existsSync(path.join(dir, 'NEVER'))).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
