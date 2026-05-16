#!/usr/bin/env bun
import { spawn } from 'child_process';
import { existsSync, watch } from 'fs';
import { dirname, resolve } from 'path';

type Options = {
  script: string;
  out: string;
  python: string;
  extra: string[];
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    script: '',
    out: '',
    python: process.env.CAD_CODER_PYTHON || 'python3',
    extra: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--') {
      options.extra = argv.slice(i + 1);
      break;
    }
    if (arg === '--script') options.script = resolve(next());
    else if (arg === '--out') options.out = resolve(next());
    else if (arg === '--python') options.python = next();
    else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.script) throw new Error('Missing --script');
  if (!options.out) throw new Error('Missing --out');
  return options;
}

function printHelp(): void {
  console.log(`watch-cadquery demo exporter

Usage:
  bun cad-coder/examples/watch-cadquery.ts --script cadquery-whistle.py --out /tmp/whistle.glb -- --pitch 440

The script is expected to accept --out <file>. Extra args after -- are passed
through to the Python script.`);
}

function runExport(options: Options): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(options.python, [options.script, '--out', options.out, ...options.extra], {
      cwd: dirname(options.script),
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(error.message);
      resolvePromise(1);
    });
    child.on('close', (code) => resolvePromise(code || 0));
  });
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  if (!existsSync(options.script)) throw new Error(`Script not found: ${options.script}`);

  let running = false;
  let rerun = false;
  const render = async (reason: string) => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    console.log(`[cad-coder] exporting ${options.out} (${reason})`);
    await runExport(options);
    running = false;
    if (rerun) {
      rerun = false;
      await render('queued-change');
    }
  };

  await render('initial');
  watch(options.script, { persistent: true }, () => {
    void render('script-change');
  });
  console.log(`[cad-coder] watching ${options.script}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
