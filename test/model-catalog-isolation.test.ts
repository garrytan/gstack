import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('replacing the shipped catalog changes role choices, not eval rulers, overlays or no-role defaults', () => {
  const source = path.resolve(import.meta.dir, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-catalog-isolation-'));
  try {
    const files = [
      'lib/model-catalog.ts', 'lib/model-policy.ts', 'lib/model-policy-notice.ts', 'lib/state-root.ts',
      'lib/eval-model.ts', 'lib/claude-code.ts', 'lib/claude-bin.ts', 'lib/claude-code-windows-job.ts',
      'lib/design-catalog.ts', 'scripts/resolve-codex-generation-model.ts', 'scripts/models.ts',
      'scripts/resolvers/constants.ts', 'scripts/resolvers/model-overlay.ts',
      ...fs.readdirSync(path.join(source, 'hosts')).filter(file => file.endsWith('.ts')).map(file => `hosts/${file}`),
      ...fs.readdirSync(path.join(source, 'model-overlays')).filter(file => file.endsWith('.md')).map(file => `model-overlays/${file}`),
    ];
    for (const file of files) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, file), target);
    }
    const entry = path.join(root, 'inspect.ts');
    fs.writeFileSync(entry, `
import { createHash } from 'node:crypto';
import { resolvePlanReviewModel, resolveImplementationModels } from './lib/model-policy';
import { CLAUDE_FRONTIER_EVAL_MODEL, resolveEvalModel } from './lib/eval-model';
import { CODEX_FRONTIER_MODEL } from './scripts/resolvers/constants';
import { resolveCodexRuntimeModel, resolveCodexGenerationModel } from './scripts/resolve-codex-generation-model';
import { ALL_MODEL_NAMES, resolveClaudeOverlay } from './scripts/models';
import { generateModelOverlay } from './scripts/resolvers/model-overlay';
import { ALL_HOST_CONFIGS } from './hosts/index';
import { claudeCodeArgs } from './lib/claude-code';
const scope = { env: process.env, cwd: process.cwd(), claudeManagedDir: './managed', codexSystemConfig: null };
console.log(JSON.stringify({
  roles: ['anthropic', 'openai'].map(provider => resolvePlanReviewModel({ ...scope, provider }).requestedModel)
    .concat(resolveImplementationModels(scope).map(selection => selection.requestedModel)),
  independent: {
    claudeRuler: CLAUDE_FRONTIER_EVAL_MODEL, openaiRuler: CODEX_FRONTIER_MODEL,
    capture: resolveEvalModel('capture'), judge: resolveEvalModel('judge'),
    codexExec: resolveCodexRuntimeModel({ kind: 'exec' }).model,
    codexReview: resolveCodexRuntimeModel({ kind: 'review' }).model,
    codexOverlay: resolveCodexGenerationModel().model,
    claudeOverlay: resolveClaudeOverlay('claude-opus-5-5'),
    claudeArgs: claudeCodeArgs({ access: 'none' }, { command: 'claude', argsPrefix: [] }, {}),
    hostDefaults: ALL_HOST_CONFIGS.map(host => [host.name, host.defaultModel]),
    overlays: ALL_MODEL_NAMES.map(model => [model, createHash('sha256').update(generateModelOverlay({ model })).digest('hex')]),
  },
}));
`);
    const env = {
      PATH: process.env.PATH ?? '', HOME: path.join(root, 'home'),
      CODEX_HOME: path.join(root, 'home', '.codex'), GSTACK_STATE_ROOT: path.join(root, 'state'),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    };
    const inspect = () => {
      const result = spawnSync(process.execPath, [entry], { cwd: root, env, encoding: 'utf-8', timeout: 30_000 });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout);
    };
    const before = inspect();
    expect(before.roles).toEqual(['claude-fable-5-1', 'gpt-6-astra', 'claude-opus-5-5', 'gpt-6.1-sol']);
    expect(before.independent).toMatchObject({
      claudeRuler: 'claude-fable-5-1', openaiRuler: 'gpt-6-astra', capture: 'claude-fable-5-1',
      judge: 'claude-fable-5-1', codexExec: 'gpt-6-astra', codexReview: 'gpt-6-astra', codexOverlay: 'gpt-6-astra',
    });
    expect(before.independent.claudeArgs.some((arg: string) => arg.startsWith('--model'))).toBe(false);
    const catalog = path.join(root, 'lib/model-catalog.ts');
    expect(fs.realpathSync(catalog).startsWith(`${fs.realpathSync(root)}${path.sep}`)).toBe(true);
    const replacements = ['claude-sonnet-5', 'gpt-5.4', 'claude-opus-4-8', 'gpt-5.6-sol'];
    let text = fs.readFileSync(catalog, 'utf-8');
    for (let i = 0; i < before.roles.length; i++) text = text.replace(`model: '${before.roles[i]}'`, `model: '${replacements[i]}'`);
    fs.writeFileSync(catalog, text);
    const after = inspect();
    expect(after.roles).toEqual(replacements);
    expect(after.independent).toEqual(before.independent);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
