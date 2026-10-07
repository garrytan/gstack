/** One-time plan-review policy notice, emitted only at an actual role-bearing invocation. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MODEL_POLICY_VERSION, PROVIDER_ENV_OVERRIDES, describeSelection, modelPolicyCommands, type ModelSelection } from './model-policy';
import { resolveStateRoot, type StateRootEnv } from './state-root';

export function modelPolicyNoticeMarker(env: StateRootEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(resolveStateRoot(env, platform), `.model-policy-notice-v${MODEL_POLICY_VERSION}`);
}

export function modelPolicyNoticeText(selection: ModelSelection): string {
  const commands = modelPolicyCommands();
  return [
    'NOTICE: gstack plan reviews now use an independent plan-review model (default: frontier tier), not your general coding-model setting.',
    `This review: ${describeSelection(selection)}.`,
    `Explicit choices still win, in order: a model named for the request, ${PROVIDER_ENV_OVERRIDES[selection.provider]}, then the per-tier config override.`,
    `Use the smart tier: ${commands.useSmart}. Keep host model settings: ${commands.useHost}. Shown once. Docs: https://github.com/garrytan/gstack/blob/main/docs/model-policy.md`,
  ].join('\n');
}

/**
 * Show before the paid call; record the marker only afterwards. A marker that
 * cannot be written repeats the notice next time instead of hiding it.
 */
export function emitModelPolicyNotice(selection: ModelSelection, opts: {
  env?: StateRootEnv;
  platform?: NodeJS.Platform;
  write?: (text: string) => void;
} = {}): boolean {
  let marker: string;
  try {
    marker = modelPolicyNoticeMarker(opts.env, opts.platform);
    if (fs.existsSync(marker)) return false;
  } catch {
    marker = '';
  }
  (opts.write ?? ((text: string) => process.stderr.write(text)))(`${modelPolicyNoticeText(selection)}\n`);
  if (!marker) return true;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
  } catch {}
  return true;
}
