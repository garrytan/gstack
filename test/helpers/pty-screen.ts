import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/** The existing xterm package ships this headless source beside its browser bundle. */
let terminalConstructor: Promise<any> | undefined;
function loadTerminal(): Promise<any> {
  return terminalConstructor ??= (async () => {
    try {
      const source = path.join(path.dirname(createRequire(import.meta.url).resolve('xterm/package.json')), 'src');
      const entry = path.join(source, 'headless/public/Terminal.ts');
      if (!fs.existsSync(entry)) throw new Error(`Installed xterm headless source is missing: ${entry}`);
      const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun', trimUnusedImports: true,
        tsconfig: JSON.stringify({ compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }) });
      const build = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm',
        // xterm5 detects Node by navigator absence. This changes only the
        // compiled module; Bun's global navigator and other tests stay intact.
        define: { navigator: 'undefined' },
        plugins: [{ name: 'installed-xterm-headless', setup(builder) {
          builder.onResolve({ filter: /^(common|headless)\// }, args => {
            const stem = path.join(source, args.path);
            return { path: fs.existsSync(`${stem}.ts`) ? `${stem}.ts` : `${stem}.d.ts` };
          });
          builder.onLoad({ filter: /[/\\]xterm[/\\]src[/\\].*\.ts$/ }, async args => ({
            contents: transpiler.transformSync(await Bun.file(args.path).text()), loader: 'js',
          }));
        } }],
      });
      if (!build.success) throw new AggregateError(build.logs, 'Installed xterm headless build failed');
      const encoded = Buffer.from(await build.outputs[0].text()).toString('base64');
      return (await import(`data:text/javascript;base64,${encoded}`)).Terminal;
    } catch (cause) {
      throw new Error('PTY screen unavailable; cannot safely observe terminal input.', { cause });
    }
  })();
}

export interface PtyScreen {
  write(text: string): void;
  read(): Promise<string>;
  dispose(): Promise<void>;
}

/** One terminal per session; read only the actual viewport, never scrollback. */
export async function createPtyScreen(cols: number, rows: number): Promise<PtyScreen> {
  const Terminal = await loadTerminal();
  const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  let pending = 0;
  let failure: unknown;
  let final: string | undefined;
  let closing: Promise<void> | undefined;
  const waiting = new Set<() => void>();
  const settled = () => { if (pending === 0) { for (const done of waiting) done(); waiting.clear(); } };
  const drain = async () => {
    while (pending > 0) await new Promise<void>(resolve => waiting.add(resolve));
    if (failure) throw new Error('PTY screen parse failed.', { cause: failure });
  };
  const viewport = () => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '').join('\n');
  };
  return {
    write(text) {
      if (closing) throw new Error('Cannot write to a disposed PTY screen.');
      if (!text) return;
      pending++;
      try { terminal.write(text, () => { pending--; settled(); }); }
      catch (error) { failure = error; pending--; settled(); }
    },
    async read() {
      if (closing) { await closing; return final!; }
      await drain();
      return viewport();
    },
    dispose() {
      return closing ??= (async () => {
        try { await drain(); final = viewport(); }
        finally { terminal.dispose(); }
      })();
    },
  };
}
