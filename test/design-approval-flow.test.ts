/**
 * Stubbed two-round design flow: round two lands at bumped names, the board
 * block archives round one's Submit, approval maps the letter through this
 * board's board-images.json, and a fresh session (relocated directory)
 * resolves the approved image. Runs the generated SKILL.md bash blocks with
 * the image API stubbed (no spend).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL = fs.readFileSync(path.join(ROOT, 'plan-design-review/SKILL.md'), 'utf8');

function bashBlockAfter(marker: string): string {
  const at = SKILL.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return SKILL.slice(at).match(/```bash\n([\s\S]*?)```/)![1];
}

const BOARD = bashBlockAfter('<!-- design:board -->');
// The save block follows the feedback-file block.
const APPROVAL = SKILL.slice(SKILL.indexOf('**Save the approved choice.**')).match(/```bash\n(_IMG=[\s\S]*?)```/)![1];

let dir: string;
let designDir: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-approval-flow-'));
  designDir = path.join(dir, 'state', 'designs', 'home-20261003');
  const preload = path.join(dir, 'stub.ts');
  fs.writeFileSync(preload, `let n = 0;
globalThis.fetch = (async () => Response.json({ id: "r", output: [{ type: "image_generation_call", result: Buffer.from("round image " + (n++)).toString("base64") }] })) as typeof fetch;
`);
  const design = path.join(dir, 'design');
  fs.writeFileSync(design, `#!/bin/sh
if [ "$1" = compare ]; then printf '%s\\n' "$*" > "$COMPARE_ARGS"; exit 0; fi
exec ${JSON.stringify(process.execPath)} --no-env-file --preload ${JSON.stringify(preload)} ${JSON.stringify(path.join(ROOT, 'design/src/cli.ts'))} "$@"
`, { mode: 0o755 });
  env = {
    PATH: process.env.PATH!, HOME: dir, GSTACK_HOME: path.join(dir, 'gstack'), TMPDIR: dir,
    OPENAI_API_KEY: 'fixture-not-a-real-key', D: design, _DESIGN_DIR: designDir, COMPARE_ARGS: path.join(dir, 'compare-args'),
  };
});

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const sh = (script: string) => spawnSync('bash', ['-c', script], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
const variants = () => JSON.parse(sh('"$D" variants --brief "home page" --count 2 --output-dir "$_DESIGN_DIR/"').stdout);
// CEO-12: the feedback travels in an agent-written file under the project's .gstack/tmp, never in the command.
const approve = (letter: string) => {
  fs.mkdirSync(path.join(dir, '.gstack', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gstack', 'tmp', 'feedback.fixture'), 'calmer "quoted" `not run` $(not run)\n');
  return sh(APPROVAL.replaceAll('<VARIANT>', letter).replaceAll('<feedback-file-name>', 'feedback.fixture').replaceAll('<SCREEN>', 'home'));
};

// Value: protects=round two's approval comes from round two's board, never round one's stale feedback.json or the newest-file listing;
//   fails_when=the board block stops archiving feedback.json or approval maps letters through the directory; why_new=eng feedback-binding; seam=none
test('round two board archives round one Submit and approval maps to the bumped image', () => {
  const round1 = variants();
  fs.writeFileSync(path.join(designDir, 'board-images.json'), JSON.stringify(round1.paths));
  fs.writeFileSync(path.join(designDir, 'feedback.json'), JSON.stringify({ preferred: 'B', regenerated: false }));

  const round2 = variants();
  expect(round2.paths.map((p: string) => path.basename(p))).toEqual(['variant-A-2.png', 'variant-B-2.png']);
  fs.writeFileSync(path.join(designDir, 'board-images.json'), JSON.stringify(round2.paths));
  const board = sh(BOARD);
  expect(board.status, board.stderr).toBe(0);
  expect(fs.existsSync(path.join(designDir, 'feedback.json'))).toBe(false);
  const archived = fs.readdirSync(designDir).filter(f => /^feedback-\d{8}T\d{6}Z\.json$/.test(f));
  expect(archived).toHaveLength(1);
  expect(fs.readFileSync(env.COMPARE_ARGS, 'utf8')).toContain(`--images-file ${path.join(designDir, 'board-images.json')}`);

  const approved = approve('A');
  expect(approved.status, approved.stderr).toBe(0);
  expect(approved.stdout).toContain(`APPROVED_IMAGE: ${path.join(designDir, 'variant-A-2.png')}`);
  const record = JSON.parse(fs.readFileSync(path.join(designDir, 'approved.json'), 'utf8'));
  expect(record).toMatchObject({ approved_variant: 'A', approved_path: 'variant-A-2.png', screen: 'home', feedback: 'calmer "quoted" `not run` $(not run)' });
  expect(fs.existsSync(path.join(dir, '.gstack', 'tmp', 'feedback.fixture'))).toBe(false);

  const missing = approve('C');
  expect(missing.stdout).toContain('NO_BOARD_IMAGE');
  expect(JSON.parse(fs.readFileSync(path.join(designDir, 'approved.json'), 'utf8')).approved_path).toBe('variant-A-2.png');
});

// Value: protects=a fresh session in a relocated state root opens round two's approved image, not variant-A.png;
//   fails_when=approved_path is stored absolute or readers resolve by letter; why_new=DX relocation + CEO fresh-session recovery; seam=none
test('fresh session resolves the approved bumped image after relocation', () => {
  variants();
  const round2 = variants();
  fs.writeFileSync(path.join(designDir, 'board-images.json'), JSON.stringify(round2.paths));
  expect(approve('A').status).toBe(0);
  const moved = path.join(dir, 'moved', 'home-20261003');
  fs.cpSync(designDir, moved, { recursive: true });
  fs.rmSync(path.join(dir, 'state'), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/gstack-design-approved'), path.join(moved, 'approved.json')], { encoding: 'utf8', timeout: 30_000 });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout.trim()).toBe(path.join(moved, 'variant-A-2.png'));
  expect(fs.readFileSync(r.stdout.trim(), 'utf8')).toBe('round image 0');
});
