#!/usr/bin/env bun
import { createHash } from 'crypto';
import { existsSync, mkdirSync, statSync, watch, type FSWatcher } from 'fs';
import { basename, dirname, extname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

export type ModelStatus = {
  status: 'idle' | 'ready' | 'error';
  id: number;
  model: string;
  modelUrl: string;
  reason?: string;
  message?: string;
  kind?: string;
  sizeBytes?: number;
  updatedAt: string;
};

export type CadCoderOptions = {
  model: string;
  port: number;
  host: string;
  projectRoot: string;
  stateRoot: string;
  staticRoot: string;
  watch: boolean;
};

type PartialOptions = Partial<CadCoderOptions> & { model: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_ROOT = join(HERE, 'static');
const GSTACK_ROOT = resolve(HERE, '..', '..');
const encoder = new TextEncoder();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.svg': 'image/svg+xml',
};

export function defaultStateRoot(): string {
  if (process.env.GSTACK_HOME) return process.env.GSTACK_HOME;
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  if (process.env.HOME) return join(process.env.HOME, '.gstack');
  return resolve('.gstack');
}

export function resolveModelPath(model: string, projectRoot = process.cwd()): string {
  const expanded = model.startsWith('~/') && process.env.HOME
    ? join(process.env.HOME, model.slice(2))
    : model;
  return resolve(projectRoot, expanded);
}

export function artifactDirFor(stateRoot: string, modelPath: string): string {
  const hash = createHash('sha1').update(modelPath).digest('hex').slice(0, 12);
  const stem = basename(modelPath).replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/\.glb$/, '');
  return join(stateRoot, 'cad-coder', `${stem}-${hash}`);
}

export function parseArgs(argv: string[]): CadCoderOptions {
  const options: CadCoderOptions = {
    model: process.env.CAD_CODER_MODEL || 'cad/out/model.glb',
    port: Number(process.env.CAD_CODER_PORT || 8765),
    host: process.env.CAD_CODER_HOST || '127.0.0.1',
    projectRoot: process.cwd(),
    stateRoot: defaultStateRoot(),
    staticRoot: DEFAULT_STATIC_ROOT,
    watch: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--model') options.model = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--host') options.host = next();
    else if (arg === '--project-root') options.projectRoot = resolve(next());
    else if (arg === '--state-root') options.stateRoot = resolve(next());
    else if (arg === '--static-root') options.staticRoot = resolve(next());
    else if (arg === '--no-watch') options.watch = false;
    else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      options.model = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  options.projectRoot = resolve(options.projectRoot);
  options.stateRoot = resolve(options.stateRoot);
  options.model = resolveModelPath(options.model, options.projectRoot);
  return options;
}

export function printHelp(): void {
  console.log(`cad-coder live preview

Usage:
  bun cad-coder/ui/server.ts [path/to/model.glb]
  bun cad-coder/ui/server.ts --model path/to/model.glb --port 8765

Options:
  --model <path>          GLB model file to watch. Defaults to cad/out/model.glb.
  --project-root <path>   Resolve relative model paths from here. Defaults to cwd.
  --state-root <path>     State root. Defaults to GSTACK_HOME or ~/.gstack.
  --port <n>              Local port. Defaults to 8765.
  --host <addr>           Local host. Defaults to 127.0.0.1.
  --no-watch              Do not watch for file changes.
`);
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

function safeJoin(root: string, pathname: string): string | null {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, clean);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

function staticResponse(root: string, pathname: string): Response {
  const filePath = safeJoin(root, pathname === '/' ? 'index.html' : pathname);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(Bun.file(filePath), {
    headers: {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    },
  });
}

export class CadCoderServer {
  readonly options: CadCoderOptions;
  readonly artifactDir: string;
  readonly url: string;
  private server: ReturnType<typeof Bun.serve>;
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private watcher: FSWatcher | null = null;
  private debounce: Timer | null = null;
  current: ModelStatus;

  constructor(options: CadCoderOptions) {
    this.options = options;
    this.artifactDir = artifactDirFor(options.stateRoot, options.model);
    mkdirSync(this.artifactDir, { recursive: true });

    this.current = {
      status: 'idle',
      id: 0,
      model: options.model,
      modelUrl: '/model.glb',
      updatedAt: new Date().toISOString(),
    };

    this.server = Bun.serve({
      hostname: options.host,
      port: options.port,
      fetch: (request) => this.fetch(request),
    });
    this.url = `http://${this.server.hostname}:${this.server.port}`;
  }

  start(): void {
    if (this.options.watch) this.startWatcher();
    this.refreshModel('initial');
  }

  async close(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignored
      }
    }
    this.clients.clear();
    this.server.stop(true);
  }

  refreshModel(reason = 'manual'): ModelStatus {
    const nextId = this.current.id + 1;
    const fileState = this.readModelFile();
    this.current = {
      ...fileState,
      id: nextId,
      model: this.options.model,
      modelUrl: fileState.status === 'ready' ? `/model.glb?v=${nextId}` : '/model.glb',
      reason,
      updatedAt: new Date().toISOString(),
    };
    this.broadcast(this.current.status, this.current);
    return this.current;
  }

  private startWatcher(): void {
    if (!existsSync(this.options.model)) {
      const parent = dirname(this.options.model);
      if (!existsSync(parent)) return;
      this.watcher = watch(parent, { persistent: true }, (_event, filename) => {
        if (filename && filename.toString() !== basename(this.options.model)) return;
        this.scheduleRefresh('file-change');
      });
      return;
    }

    this.watcher = watch(this.options.model, { persistent: true }, () => {
      this.scheduleRefresh('file-change');
    });
  }

  private scheduleRefresh(reason: string): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.refreshModel(reason);
    }, 150);
  }

  private readModelFile(): Partial<ModelStatus> {
    if (!existsSync(this.options.model)) {
      return {
        status: 'error',
        kind: 'missing-model',
        message: `GLB model file not found: ${this.options.model}`,
      };
    }

    const stat = statSync(this.options.model);
    if (!stat.isFile()) {
      return {
        status: 'error',
        kind: 'invalid-model-path',
        message: `GLB model path is not a file: ${this.options.model}`,
      };
    }

    return {
      status: 'ready',
      sizeBytes: stat.size,
      message: `Loaded ${basename(this.options.model)}`,
    };
  }

  private fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === '/api/status') return json(this.current);
    if (url.pathname === '/api/reload' && request.method === 'POST') {
      this.refreshModel('api');
      return json({ ok: true });
    }
    if (url.pathname === '/events') return this.events();
    if (url.pathname === '/model.glb') {
      if (!existsSync(this.options.model)) return new Response('No model file yet', { status: 404 });
      return new Response(Bun.file(this.options.model), {
        headers: {
          'content-type': 'model/gltf-binary',
          'cache-control': 'no-store',
        },
      });
    }
    if (url.pathname.startsWith('/vendor/three/')) {
      const threeRoot = join(GSTACK_ROOT, 'node_modules', 'three');
      return staticResponse(threeRoot, url.pathname.replace('/vendor/three/', ''));
    }
    return staticResponse(this.options.staticRoot, url.pathname);
  }

  private events(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.clients.add(controller);
        controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify(this.current)}\n\n`));
      },
      cancel: (controller) => {
        this.clients.delete(controller);
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      },
    });
  }

  private broadcast(event: string, payload: ModelStatus): void {
    const frame = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const client of this.clients) {
      try {
        client.enqueue(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export async function startCadCoderServer(options: PartialOptions): Promise<CadCoderServer> {
  const full: CadCoderOptions = {
    port: 8765,
    host: '127.0.0.1',
    projectRoot: process.cwd(),
    stateRoot: defaultStateRoot(),
    staticRoot: DEFAULT_STATIC_ROOT,
    watch: true,
    ...options,
  };
  full.projectRoot = resolve(full.projectRoot);
  full.stateRoot = resolve(full.stateRoot);
  full.model = resolveModelPath(full.model, full.projectRoot);
  const server = new CadCoderServer(full);
  server.start();
  return server;
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const server = await startCadCoderServer(options);
    console.log(`cad-coder UI: ${server.url}`);
    console.log(`model: ${server.options.model}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
