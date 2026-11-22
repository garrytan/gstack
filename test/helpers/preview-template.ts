/** Start design-review/templates/preview-fixtures.mjs under isolated Bun and wait for its ready line. */
import * as path from 'node:path';
import { bunIsolationArgs } from '../../lib/bun-isolation';

export const PREVIEW_TEMPLATE = path.join(import.meta.dir, '..', '..', 'design-review', 'templates', 'preview-fixtures.mjs');

export interface Preview { url: string; port: number; proc: ReturnType<typeof Bun.spawn>; ready: string }

export async function startPreview(args: string[], timeoutMs = 15_000): Promise<Preview> {
  const proc = Bun.spawn([process.execPath, ...bunIsolationArgs(), PREVIEW_TEMPLATE, 'start', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const reader = proc.stdout.getReader();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (!/PREVIEW: ready .*\n/.test(text)) {
    if (Date.now() > deadline) { proc.kill(); throw new Error('preview did not start: ' + text); }
    const chunk = await Promise.race([reader.read(), Bun.sleep(200).then(() => null)]);
    if (chunk && chunk.done) throw new Error('preview exited: ' + text + (await new Response(proc.stderr).text()));
    if (chunk?.value) text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  const ready = /PREVIEW: ready .*/.exec(text)![0];
  const url = /url=(\S+)/.exec(ready)![1]!;
  return { url, port: Number(new URL(url).port), proc, ready };
}

export function runPreview(args: string[]) {
  const r = Bun.spawnSync([process.execPath, ...bunIsolationArgs(), PREVIEW_TEMPLATE, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
