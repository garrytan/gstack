/**
 * bin/gstack-modules (GSTA-140, PR 1a): the module catalog and loadout renders.
 *
 *   gstack-modules list [--json] [--pinned]
 *   gstack-modules validate
 *   gstack-modules render --host <h> (--loadout <name> | --modules <base>,-id,+id) --out-dir <d>
 *                         [--install-root <abs>] [--model <id>] [--plan-mode on|off]
 *                         [--bind-model <id> --full-root <abs>]
 *   gstack-modules resolve [--model <id>] [--loadout <name>]
 *   gstack-modules install --full-root <abs> [--model <id>] [--loadout <name>] [--store <dir>] [--plan-mode on|off]
 *
 * resolve and install pick the loadout through lib/model-detect.ts. install
 * prints `LOADOUT: …` and `SKILL_ROOT: <dir>`: the full root for full, else
 * the published lite tree (scripts/modules-install.ts). A lite render that
 * fails prints LOADOUT_FALLBACK and serves full, exit 0.
 *
 * Exit 0 on success, 2 on a refused input (ModuleError, printed with its code,
 * fix and docs anchor), 1 on an unexpected failure.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveHostArg } from '../hosts/index';
import { resolveModel } from './models';
import { LOADOUTS_FILE, MODEL_ID_RE, ModuleError, loadLoadouts, moduleCatalog, normalizeModelId, selectModules, validateLoadouts } from './modules';
import { renderLoadout } from './modules-render';
import { installLoadout } from './modules-install';
import { describeResolution, resolveLoadout } from '../lib/model-detect';
import { resolveStateRoot } from '../lib/state-root';
import type { Host } from './resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const USAGE = `Usage:
  gstack-modules list [--json] [--pinned]   every module id with its kind, source and pin
  gstack-modules validate                   check ${LOADOUTS_FILE} against the catalog
  gstack-modules render --host <h> (--loadout <name> | --modules <base>,-id,+id) --out-dir <d>
                        [--install-root <abs>] [--model <id>] [--plan-mode on|off]
                        [--bind-model <id> --full-root <abs>]
                                            render one loadout and write loadout.lock.json;
                                            --bind-model bakes the start lines an install
                                            for that model serves
  gstack-modules resolve [--model <id>] [--loadout <name>]
                                            the loadout an install would serve, and why
  gstack-modules install --full-root <abs> [--model <id>] [--loadout <name>] [--store <dir>] [--plan-mode on|off]
                                            publish that loadout and print SKILL_ROOT
Guide: docs/loadouts.md`;

export interface CliResult { code: number; stdout: string; stderr: string }

function flag(args: string[], name: string): string | undefined {
  const index = args.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (index < 0) return undefined;
  const value = args[index].startsWith(`${name}=`) ? args[index].slice(name.length + 1) : args[index + 1];
  if (!value || value.startsWith('--')) throw new ModuleError('MODULE_SPEC_INVALID', `${name} requires a value`, `gstack-modules --help`);
  return value;
}

export async function modulesMain(args: string[]): Promise<CliResult> {
  const [command, ...rest] = args;
  try {
    if (!command || command === '--help' || command === '-h' || command === 'help') return { code: 0, stdout: USAGE + '\n', stderr: '' };
    if (command === 'list') {
      const manifest = loadLoadouts();
      const catalog = moduleCatalog(manifest).filter(e => !rest.includes('--pinned') || e.pinned);
      const rows = catalog.map(e => {
        const bytes = fs.readFileSync(path.join(ROOT, e.source));
        return { ...e, source_bytes: bytes.length, source_sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      });
      if (rest.includes('--json')) return { code: 0, stdout: JSON.stringify({ loadouts: Object.keys(manifest.loadouts), modules: rows }, null, 2) + '\n', stderr: '' };
      const lines = rows.map(r => `${r.id.padEnd(48)} ${r.kind.padEnd(8)} ${r.pinned ? 'pinned' : '      '} ${r.source}`);
      return { code: 0, stdout: [`loadouts: ${Object.keys(manifest.loadouts).join(', ')}`, ...lines].join('\n') + '\n', stderr: '' };
    }
    if (command === 'validate') {
      const manifest = loadLoadouts();
      const problems = validateLoadouts(manifest, moduleCatalog(manifest));
      if (problems.length) return { code: 2, stdout: '', stderr: problems.map(p => `LOADOUTS_INVALID: ${p}`).join('\n') + '\n' };
      return { code: 0, stdout: `LOADOUTS: ok (${Object.keys(manifest.loadouts).length} loadouts)\n`, stderr: '' };
    }
    if (command === 'render') {
      const hostValue = flag(rest, '--host');
      const outDir = flag(rest, '--out-dir');
      if (!hostValue || !outDir) throw new ModuleError('MODULE_SPEC_INVALID', 'render needs --host and --out-dir', 'gstack-modules render --host claude --loadout full --out-dir <dir>');
      let host: Host;
      try { host = resolveHostArg(hostValue) as Host; } catch (error) { throw new ModuleError('MODULE_SPEC_INVALID', (error as Error).message, 'pass a host from docs/hosts.md, for example --host claude'); }
      const loadout = flag(rest, '--loadout');
      const modules = flag(rest, '--modules');
      if (loadout === undefined && modules === undefined) throw new ModuleError('MODULE_SPEC_INVALID', 'render needs --loadout or --modules', 'add --loadout full for the control arm');
      const modelValue = flag(rest, '--model');
      const model = modelValue === undefined ? null : resolveModel(modelValue);
      if (modelValue !== undefined && !model) throw new ModuleError('MODULE_SPEC_INVALID', `--model ${JSON.stringify(modelValue.slice(0, 80))} is not a model gstack knows`, 'pass the same --model setup uses, for example gpt-6-astra');
      const planMode = flag(rest, '--plan-mode');
      if (planMode !== undefined && planMode !== 'on' && planMode !== 'off') throw new ModuleError('MODULE_SPEC_INVALID', '--plan-mode takes on or off', 'drop it, or pass --plan-mode off');
      const installRoot = flag(rest, '--install-root');
      if (installRoot !== undefined && !/^\/[A-Za-z0-9_.@+\/-]*$/.test(installRoot)) throw new ModuleError('MODULE_SPEC_INVALID', '--install-root must be a plain absolute path', 'pass the absolute install root setup would use');
      const bindModel = flag(rest, '--bind-model');
      const fullRoot = flag(rest, '--full-root');
      const selected = selectModules({ loadout, modules });
      if ((bindModel === undefined) !== (fullRoot === undefined)) throw new ModuleError('MODULE_SPEC_INVALID', '--bind-model and --full-root go together', 'pass both, or neither');
      if (bindModel !== undefined && !selected) throw new ModuleError('MODULE_SPEC_INVALID', '--bind-model needs a loadout that excludes something', 'drop --bind-model for the full loadout');
      if (bindModel !== undefined && !MODEL_ID_RE.test(normalizeModelId(bindModel))) throw new ModuleError('MODULE_SPEC_INVALID', '--bind-model is not a plain model id', 'pass an id such as claude-opus-5-5');
      if (fullRoot !== undefined && !/^\/[A-Za-z0-9_.@+\/-]*$/.test(fullRoot)) throw new ModuleError('MODULE_SPEC_INVALID', '--full-root must be a plain absolute path', 'pass the full install root, for example --full-root "$HOME/.claude/skills"');
      const selection = selected && bindModel !== undefined ? { ...selected, boundModel: normalizeModelId(bindModel), fullRoot } : selected;
      const lock = await renderLoadout({ host, selection, outDir, installRoot: installRoot ?? null, model, planMode: planMode !== 'off' });
      return { code: 0, stdout: `RENDERED: loadout=${lock.loadout} host=${host} files=${lock.files.length} bytes=${lock.total_bytes} excluded=${lock.excluded.length} lock=${path.join(path.resolve(outDir), 'loadout.lock.json')}\n`, stderr: '' };
    }
    if (command === 'resolve' || command === 'install') {
      const resolution = resolveLoadout({ loadout: flag(rest, '--loadout'), model: flag(rest, '--model') });
      const notice = resolution.notice ? `${resolution.notice}\n` : '';
      if (command === 'resolve') return { code: 0, stdout: describeResolution(resolution) + '\n', stderr: notice };
      const fullRoot = flag(rest, '--full-root');
      if (!fullRoot || !/^\/[A-Za-z0-9_.@+\/-]*$/.test(fullRoot)) throw new ModuleError('MODULE_SPEC_INVALID', 'install needs --full-root <plain absolute path>', 'pass the full install root, for example --full-root "$HOME/.claude/skills"');
      const planMode = flag(rest, '--plan-mode');
      if (planMode !== undefined && planMode !== 'on' && planMode !== 'off') throw new ModuleError('MODULE_SPEC_INVALID', '--plan-mode takes on or off', 'drop it, or pass --plan-mode off');
      const full = (line: string) => ({ code: 0, stdout: `${line}\nSKILL_ROOT: ${fullRoot}\n`, stderr: notice });
      if (resolution.loadout === 'full') return full(describeResolution(resolution));
      try {
        const selection = selectModules({ loadout: resolution.loadout });
        if (!selection) return full(describeResolution(resolution));
        const store = flag(rest, '--store') ?? path.join(resolveStateRoot(), 'loadouts');
        const result = await installLoadout({ selection, boundModel: resolution.model, fullRoot, store, planMode: planMode !== 'off' });
        return { code: 0, stdout: `${describeResolution(resolution)} digest=${result.lock.identity_sha256.slice(0, 12)} reused=${result.reused ? 'yes' : 'no'}\nSKILL_ROOT: ${result.root}\n`, stderr: notice };
      } catch (error) {
        const why = error instanceof ModuleError ? `${error.code}: ${error.message}` : (error as Error).message;
        return { code: 0, stdout: `${describeResolution({ ...resolution, loadout: 'full', model: null, reason: 'render-failed' })}\nSKILL_ROOT: ${fullRoot}\n`, stderr: `${notice}LOADOUT_FALLBACK: ${why.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 400)}; serving full (docs/troubleshooting.md#loadout-fallback)\n` };
      }
    }
    return { code: 2, stdout: '', stderr: `Unknown command ${JSON.stringify(command.slice(0, 40))}.\n${USAGE}\n` };
  } catch (error) {
    if (error instanceof ModuleError) return { code: 2, stdout: '', stderr: `${error.code}: ${error.message}\n` };
    return { code: 1, stdout: '', stderr: `gstack-modules: unexpected failure: ${(error as Error).message}\n` };
  }
}
