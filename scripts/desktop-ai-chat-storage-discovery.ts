#!/usr/bin/env bun
/**
 * Metadata-only discovery for local desktop AI chat app storage on macOS.
 *
 * Privacy invariant: this script never prints file contents, database values,
 * localStorage values, IndexedDB keys/values, cookies, screenshots, or cached
 * attachment names. It reports known app/container roots plus structural storage
 * paths and file classifications derived from metadata and magic bytes only.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

export type ProviderDecision =
  | 'supported'
  | 'promising but brittle'
  | 'metadata-only'
  | 'not feasible';

export interface DiscoveryOptions {
  homeDir?: string;
  applicationsDirs?: string[];
  includeMissing?: boolean;
  /**
   * Off by default. Reading even a small prefix from provider cache files can
   * load private chat content into memory if the provider stores plaintext.
   * Enable only for synthetic fixtures or explicitly approved samples.
   */
  allowHeaderRead?: boolean;
}

export interface DiscoveryEntry {
  path: string;
  exists: boolean;
  kind: 'app-bundle' | 'directory' | 'file' | 'missing';
  fileType?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  bundleIdentifier?: string;
  storageTechnology?: string;
  parserFeasibility?: string;
  note?: string;
}

export interface ProviderDiscovery {
  provider: string;
  decision: ProviderDecision;
  installed: boolean;
  entries: DiscoveryEntry[];
  limitations: string[];
}

const STRUCTURAL_RELATIVE_PATHS = [
  'IndexedDB',
  'Default/IndexedDB',
  'Partitions',
  'Local Storage',
  'Local Storage/leveldb',
  'Default/Local Storage',
  'Session Storage',
  'databases',
  'Database',
  'Network',
  'Network/Cookies',
  'Cookies',
  'blob_storage',
  'Service Worker',
  'Service Worker/Database',
];

const CHATGPT_DATA_EXTENSIONS = new Set(['.data']);
const SKIPPED_DISCOVERY_DIRS = new Set([
  'Cache',
  'CacheStorage',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'Crashpad',
  'logs',
  'tmp',
  'attachments',
  'Attachments',
  'Downloads',
]);

interface ProviderSpec {
  provider: string;
  appNames: string[];
  storageRoots: (homeDir: string) => string[];
  dynamicRoots?: (homeDir: string) => string[];
  installedFromStorage?: (entry: DiscoveryEntry) => boolean;
  decision: ProviderDecision;
  limitations: string[];
  installedRequiresApp?: boolean;
  dataExtensions?: Set<string>;
}

function providerSpecs(applicationsDirs: string[]): ProviderSpec[] {
  const applicationApp = (name: string) => applicationsDirs.map(dir => path.join(dir, `${name}.app`));

  return [
    {
      provider: 'ChatGPT Desktop',
      appNames: applicationApp('ChatGPT'),
      storageRoots: homeDir => [
        path.join(homeDir, 'Library/Containers/com.openai.chat'),
        path.join(homeDir, 'Library/Application Support/ChatGPT'),
        path.join(homeDir, 'Library/Application Support/com.openai.chat'),
      ],
      dynamicRoots: homeDir => groupContainersMatching(homeDir, /openai|chatgpt/i),
      decision: 'promising but brittle',
      dataExtensions: CHATGPT_DATA_EXTENSIONS,
      limitations: [
        '.data files are discovered by metadata only by default; header classification is opt-in for synthetic fixtures or user-approved samples.',
      ],
    },
    {
      provider: 'Claude Desktop',
      appNames: applicationApp('Claude'),
      storageRoots: homeDir => [
        path.join(homeDir, 'Library/Application Support/Claude'),
        path.join(homeDir, 'Library/Containers/com.anthropic.claude'),
        path.join(homeDir, 'Library/Containers/com.anthropic.claudefordesktop'),
      ],
      dynamicRoots: homeDir => groupContainersMatching(homeDir, /anthropic|claude/i),
      decision: 'metadata-only',
      limitations: [
        'IndexedDB/LevelDB metadata can prove storage shape, but complete conversation recovery cannot be proven without reading private values.',
      ],
    },
    {
      provider: 'Gemini',
      appNames: applicationApp('Gemini'),
      storageRoots: homeDir => [
        path.join(homeDir, 'Library/Application Support/Gemini'),
        path.join(homeDir, 'Library/Containers/com.google.Gemini'),
        path.join(homeDir, 'Library/Containers/com.google.gemini'),
      ],
      dynamicRoots: homeDir => groupContainersMatching(homeDir, /gemini/i),
      decision: 'not feasible',
      installedRequiresApp: true,
      limitations: [
        'Report as not installed unless a dedicated Gemini macOS app bundle exists; browser/PWA cache discovery is out of scope.',
      ],
    },
    {
      provider: 'Grok',
      appNames: applicationApp('Grok'),
      storageRoots: homeDir => [
        path.join(homeDir, 'Library/Application Support/Grok'),
        path.join(homeDir, 'Library/Containers/ai.x.grok'),
        path.join(homeDir, 'Library/Containers/com.xai.grok'),
      ],
      dynamicRoots: homeDir => groupContainersMatching(homeDir, /grok|xai/i),
      decision: 'not feasible',
      limitations: [
        'Report as not installed/no dedicated macOS target unless a local app bundle or container exists.',
      ],
    },
    {
      provider: 'Perplexity',
      appNames: applicationApp('Perplexity'),
      storageRoots: homeDir => [
        path.join(homeDir, 'Library/Containers/ai.perplexity.mac'),
        path.join(homeDir, 'Library/Application Support/Perplexity'),
      ],
      dynamicRoots: homeDir => groupContainersMatching(homeDir, /perplexity/i),
      decision: 'promising but brittle',
      limitations: [
        'Perplexity app storage is inspectable as app/container metadata; ingestion requires synthetic fixtures or user-approved exports/cache samples.',
      ],
    },
    {
      provider: 'Comet',
      appNames: applicationApp('Comet'),
      storageRoots: homeDir => [
        path.join(homeDir, 'Library/Application Support/Comet'),
      ],
      dynamicRoots: homeDir => groupContainersMatching(homeDir, /comet|perplexity/i),
      installedFromStorage: entry =>
        entry.path.includes('/Library/Application Support/Comet')
        || entry.path.includes('/Library/Containers/ai.perplexity.comet')
        || entry.path.toLowerCase().includes('/comet'),
      decision: 'promising but brittle',
      limitations: [
        'Comet is Chromium-like browser storage; app-level ingestion is brittle unless provider-owned data formats are documented or fixture-backed.',
      ],
    },
  ];
}

export function discoverDesktopAiChatStorage(options: DiscoveryOptions = {}): ProviderDiscovery[] {
  const homeDir = options.homeDir ?? os.homedir();
  const applicationsDirs = options.applicationsDirs ?? ['/Applications', path.join(homeDir, 'Applications')];

  return providerSpecs(applicationsDirs).map(spec => {
    const candidates = uniquePaths([
      ...spec.appNames,
      ...spec.storageRoots(homeDir),
      ...(spec.dynamicRoots ? spec.dynamicRoots(homeDir) : []),
    ]);
    const directEntries = candidates
      .map(candidate => describePath(candidate, options.includeMissing ?? true, {
        allowHeaderRead: options.allowHeaderRead ?? false,
      }))
      .filter((entry): entry is DiscoveryEntry => Boolean(entry));

    const existingRoots = directEntries.filter(entry => entry.exists && entry.kind !== 'file');
    const structuralEntries = existingRoots.flatMap(entry =>
      describeStructuralStorage(entry.path, {
        dataExtensions: spec.dataExtensions,
        allowHeaderRead: options.allowHeaderRead ?? false,
      })
    );

    const entries = uniqueEntries([...directEntries, ...structuralEntries]);
    const hasApp = directEntries.some(entry => entry.exists && entry.kind === 'app-bundle');
    const hasStorage = directEntries.some(entry =>
      entry.exists
      && entry.kind !== 'missing'
      && entry.kind !== 'app-bundle'
      && (spec.installedFromStorage ? spec.installedFromStorage(entry) : true)
    );
    const installed = spec.installedRequiresApp ? hasApp : hasApp || hasStorage;

    return {
      provider: spec.provider,
      decision: installed ? spec.decision : 'not feasible',
      installed,
      entries,
      limitations: spec.limitations,
    };
  });
}

export function formatDiscoveryMarkdown(discoveries: ProviderDiscovery[]): string {
  const lines: string[] = [];
  lines.push('# Desktop AI Chat Storage Discovery');
  lines.push('');
  lines.push('Privacy mode: metadata only. No file contents, database values, localStorage values, IndexedDB values, cookies, screenshots, or cached attachment names are emitted.');
  lines.push('');

  for (const discovery of discoveries) {
    lines.push(`## ${discovery.provider}`);
    lines.push('');
    lines.push(`- Installed: ${discovery.installed ? 'yes' : 'no'}`);
    lines.push(`- Decision: ${discovery.decision}`);
    lines.push('');
    lines.push('| Path | Kind | Type/technology | Parser feasibility | Size | Modified | Bundle ID | Note |');
    lines.push('|---|---|---|---|---:|---|---|---|');

    for (const entry of discovery.entries) {
      lines.push([
        entry.path,
        entry.kind,
        entry.storageTechnology ?? entry.fileType ?? '',
        entry.parserFeasibility ?? '',
        entry.sizeBytes === undefined ? '' : String(entry.sizeBytes),
        entry.modifiedAt ?? '',
        entry.bundleIdentifier ?? '',
        entry.note ?? '',
      ].map(markdownCell).join('|').replace(/^/, '|').replace(/$/, '|'));
    }

    if (discovery.limitations.length > 0) {
      lines.push('');
      lines.push('Limitations:');
      for (const limitation of discovery.limitations) lines.push(`- ${limitation}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function describePath(
  targetPath: string,
  includeMissing: boolean,
  options: { allowHeaderRead?: boolean; displayPath?: string } = {},
): DiscoveryEntry | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return includeMissing
      ? { path: options.displayPath ?? targetPath, exists: false, kind: 'missing', note: 'not installed / not found' }
      : null;
  }

  const isApp = isAppBundle(targetPath, stat);
  const kind = isApp ? 'app-bundle' : stat.isDirectory() ? 'directory' : 'file';
  return {
    path: options.displayPath ?? targetPath,
    exists: true,
    kind,
    fileType: kind === 'file' ? classifyFile(targetPath, options.allowHeaderRead ?? false) : undefined,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    bundleIdentifier: isApp ? readBundleIdentifier(targetPath) : undefined,
    storageTechnology: inferStorageTechnology(options.displayPath ?? targetPath, kind),
  };
}

function describeStructuralStorage(
  root: string,
  options: { dataExtensions?: Set<string>; allowHeaderRead?: boolean },
): DiscoveryEntry[] {
  const entries: DiscoveryEntry[] = [];

  for (const relPath of STRUCTURAL_RELATIVE_PATHS) {
    const fullPath = path.join(root, relPath);
    const entry = describePath(fullPath, false, {
      allowHeaderRead: options.allowHeaderRead ?? false,
    });
    if (!entry) continue;
    entry.parserFeasibility = feasibilityFor(entry);
    entries.push(entry);
  }

  if (options.dataExtensions && options.dataExtensions.size > 0) {
    const filePaths = findFilesByExtension(root, options.dataExtensions, 5, 100);
    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      const entry = describePath(filePath, false, {
        allowHeaderRead: options.allowHeaderRead ?? false,
        displayPath: redactedPrivateFilePath(root, filePath, i + 1),
      });
      if (!entry) continue;
      entry.storageTechnology = options.allowHeaderRead
        ? classifyDataFile(filePath)
        : '.data file; private header/content not inspected';
      entry.parserFeasibility = options.allowHeaderRead
        ? 'header-only classification on synthetic/user-approved sample; do not parse private values'
        : 'metadata-only; rerun with --allow-header-read only for synthetic/user-approved samples';
      entries.push(entry);
    }
  }

  return entries;
}

function findFilesByExtension(root: string, extensions: Set<string>, maxDepth: number, limit: number): string[] {
  const found: string[] = [];

  function walk(current: string, depth: number) {
    if (found.length >= limit || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= limit) return;
      if (SKIPPED_DISCOVERY_DIRS.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        found.push(fullPath);
      }
    }
  }

  walk(root, 0);
  return found.sort();
}

function inferStorageTechnology(targetPath: string, kind: DiscoveryEntry['kind']): string | undefined {
  const normalized = targetPath.toLowerCase();
  if (kind === 'app-bundle') return 'macOS app bundle';
  if (normalized.includes('indexeddb')) return 'IndexedDB directory, usually LevelDB-backed in Electron/Chromium';
  if (normalized.includes('local storage')) return 'Chromium Local Storage directory; values intentionally not inspected';
  if (normalized.includes('session storage')) return 'Chromium Session Storage directory; values intentionally not inspected';
  if (normalized.includes('cookies')) return 'cookie store path; values intentionally not inspected';
  if (normalized.includes('service worker')) return 'Chromium Service Worker storage';
  if (normalized.includes('application support')) return 'Application Support root';
  if (normalized.includes('/containers/') || normalized.includes('/group containers/')) return 'macOS sandbox/group container root';
  return undefined;
}

function classifyFile(filePath: string, allowHeaderRead: boolean): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.sqlite' || ext === '.sqlite3' || ext === '.db') {
    return allowHeaderRead ? classifySqliteLike(filePath) : 'database-like file; private header/content not inspected';
  }
  if (ext === '.data') {
    return allowHeaderRead ? classifyDataFile(filePath) : '.data file; private header/content not inspected';
  }
  return ext ? `${ext.slice(1)} file` : 'file';
}

function classifySqliteLike(filePath: string): string {
  const header = readPrefix(filePath, 16);
  return header?.equals(Buffer.from('SQLite format 3\0', 'binary'))
    ? 'SQLite database'
    : 'database-like file, not SQLite header';
}

export function classifyDataFile(filePath: string): string {
  const prefix = readPrefix(filePath, 512);
  if (!prefix || prefix.length === 0) return '.data file, empty or unreadable';
  if (prefix.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'binary'))) return '.data file, SQLite database';
  if (prefix.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) return '.data file, gzip-compressed';
  if (prefix.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return '.data file, zstd-compressed';
  if (prefix.subarray(0, 4).equals(Buffer.from([0x04, 0x22, 0x4d, 0x18]))) return '.data file, lz4-compressed';
  if (prefix.subarray(0, 8).toString('ascii') === 'bplist00') return '.data file, Apple binary plist';
  if (looksLikeUtf8Text(prefix)) return '.data file, plaintext/JSON-like by byte class; contents not emitted';
  if (looksLikeMsgpack(prefix)) return '.data file, msgpack-like binary; structural guess only';
  if (looksLikeProtobuf(prefix)) return '.data file, protobuf-like binary; structural guess only';
  return '.data file, custom/encrypted binary or unknown compression';
}

function looksLikeUtf8Text(prefix: Buffer): boolean {
  let printable = 0;
  let considered = 0;
  for (const byte of prefix) {
    if (byte === 0) return false;
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) printable++;
    considered++;
  }
  return considered > 0 && printable / considered > 0.9;
}

function looksLikeMsgpack(prefix: Buffer): boolean {
  const first = prefix[0];
  return first >= 0x80 && first <= 0x9f || first >= 0xde && first <= 0xdf;
}

function looksLikeProtobuf(prefix: Buffer): boolean {
  if (prefix.length < 2) return false;
  const first = prefix[0];
  const wireType = first & 0x07;
  const fieldNumber = first >> 3;
  return fieldNumber > 0 && [0, 1, 2, 5].includes(wireType);
}

function readPrefix(filePath: string, bytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function redactedPrivateFilePath(root: string, filePath: string, index: number): string {
  const ext = path.extname(filePath) || '.file';
  const ordinal = String(index).padStart(3, '0');
  return path.join(root, '...', `<redacted-private-file-${ordinal}${ext}>`);
}

function readBundleIdentifier(appPath: string): string | undefined {
  const plistPath = path.join(appPath, 'Contents/Info.plist');
  if (!fs.existsSync(plistPath)) return undefined;

  const plutil = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plistPath], {
    encoding: 'utf8',
  });
  if (plutil.status === 0) {
    const value = plutil.stdout.trim();
    return value || undefined;
  }

  try {
    const xml = fs.readFileSync(plistPath, 'utf8');
    const match = xml.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function isAppBundle(targetPath: string, stat: fs.Stats): boolean {
  return targetPath.endsWith('.app')
    && stat.isDirectory()
    && fs.existsSync(path.join(targetPath, 'Contents/Info.plist'));
}

function groupContainersMatching(homeDir: string, pattern: RegExp): string[] {
  const root = path.join(homeDir, 'Library/Group Containers');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter(name => pattern.test(name))
    .map(name => path.join(root, name));
}

function feasibilityFor(entry: DiscoveryEntry): string {
  const tech = entry.storageTechnology ?? '';
  if (tech.includes('IndexedDB')) return 'metadata-only unless synthetic/user-approved LevelDB values are available';
  if (tech.includes('Local Storage') || tech.includes('Session Storage') || tech.includes('cookie')) {
    return 'not an ingestion source; sensitive values intentionally skipped';
  }
  return 'metadata-only';
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function uniqueEntries(entries: DiscoveryEntry[]): DiscoveryEntry[] {
  const seen = new Set<string>();
  const unique: DiscoveryEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.path}\0${entry.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.sort((a, b) => a.path.localeCompare(b.path));
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function parseArgs(argv: string[]) {
  const options: DiscoveryOptions = {};
  let format: 'json' | 'markdown' = 'json';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--format' && argv[i + 1]) {
      const next = argv[++i];
      if (next !== 'json' && next !== 'markdown') throw new Error('--format must be json or markdown');
      format = next;
    } else if (arg === '--home' && argv[i + 1]) {
      options.homeDir = argv[++i];
    } else if (arg === '--applications-dir' && argv[i + 1]) {
      options.applicationsDirs = [...(options.applicationsDirs ?? []), argv[++i]];
    } else if (arg === '--existing-only') {
      options.includeMissing = false;
    } else if (arg === '--allow-header-read') {
      options.allowHeaderRead = true;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { options, format };
}

function printHelp() {
  console.log(`Usage: bun run scripts/desktop-ai-chat-storage-discovery.ts [options]

Options:
  --format json|markdown       Output format. Default: json.
  --home PATH                  Home directory to inspect. Default: current user home.
  --applications-dir PATH      Applications directory. Can be repeated.
  --existing-only              Omit missing candidate paths.
  --allow-header-read          Opt in to magic-byte classification for synthetic
                               or explicitly approved samples. Off by default.
  --help                       Show this help.

Privacy invariant: emits metadata and structural classifications only. By default,
private cache files are not opened for header inspection.`);
}

if (import.meta.main) {
  try {
    const { options, format } = parseArgs(process.argv.slice(2));
    const discoveries = discoverDesktopAiChatStorage(options);
    if (format === 'markdown') {
      console.log(formatDiscoveryMarkdown(discoveries));
    } else {
      console.log(JSON.stringify(discoveries, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
