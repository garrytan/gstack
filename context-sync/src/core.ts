import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CONTEXT_SYNC_SCHEMA_VERSION = 1;
export const DEFAULT_DRIVE_FOLDER_NAME = 'AI Context Sync Spine';

export type SourceKind = 'chat' | 'files' | 'index';

export interface ContextSyncSource {
  id: string;
  kind: SourceKind;
  path: string;
  label?: string;
}

export interface ContextSyncConfig {
  schemaVersion: number;
  deviceId: string;
  driveRoot: string;
  sources: ContextSyncSource[];
  createdAt: string;
  updatedAt: string;
}

export interface InitOptions {
  configPath?: string;
  deviceId?: string;
  driveRoot?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  force?: boolean;
}

export interface InitResult {
  created: boolean;
  configPath: string;
  config: ContextSyncConfig;
}

export interface SkippedItem {
  sourceId: string;
  path: string;
  reason: string;
}

export interface SensitiveFinding {
  sourceId: string;
  relativePath: string;
  patterns: string[];
}

export interface PlannedCopy {
  id: string;
  logicalId: string;
  sourceId: string;
  sourceKind: SourceKind;
  sourcePath: string;
  absolutePath: string;
  relativePath: string;
  rawRelativePath: string;
  readableRelativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  hashStatus: 'computed' | 'pending-until-commit';
  sensitivePatterns: string[];
}

export interface SourceInventory {
  sourceId: string;
  kind: SourceKind;
  path: string;
  exists: boolean;
  plannedCount: number;
  skippedCount: number;
  estimatedBytes: number;
}

export interface DryRunReport {
  schemaVersion: number;
  dryRun: true;
  generatedAt: string;
  deviceId: string;
  driveRoot: string;
  configPath?: string;
  inventory: SourceInventory[];
  plannedCopies: PlannedCopy[];
  estimatedBytes: number;
  sensitiveFindings: SensitiveFinding[];
  skippedRisk: SkippedItem[];
}

export interface ManifestAction {
  action: 'copied' | 'deduped' | 'conflict';
  logicalId: string;
  sourceId: string;
  relativePath: string;
  sha256: string;
  rawRelativePath: string;
  readableRelativePath: string;
  conflictRelativePath?: string;
  conflictWith?: Array<{ deviceId: string; sourceId: string; relativePath: string; sha256: string }>;
}

export interface RunManifest {
  schemaVersion: number;
  dryRun: false;
  runId: string;
  generatedAt: string;
  deviceId: string;
  driveRoot: string;
  plannedCount: number;
  copiedCount: number;
  dedupedCount: number;
  conflictCount: number;
  estimatedBytes: number;
  sensitiveFindings: SensitiveFinding[];
  skippedRisk: SkippedItem[];
  actions: ManifestAction[];
}

export interface RunResult {
  manifest: RunManifest;
  manifestPath: string;
}

export interface StatusReport {
  schemaVersion: number;
  generatedAt: string;
  configPath: string;
  configExists: boolean;
  deviceId?: string;
  driveRoot?: string;
  driveRootExists: boolean;
  sources: Array<{ sourceId: string; kind: SourceKind; path: string; exists: boolean }>;
  devices: Array<{ deviceId: string; path: string; updatedAt?: string }>;
  indexExists: boolean;
}

interface ExistingVersion {
  logicalId: string;
  deviceId: string;
  sourceId: string;
  relativePath: string;
  sha256: string;
  rawRelativePath: string;
}

const TEXT_EXTENSIONS = new Set([
  '.json',
  '.jsonl',
  '.md',
  '.mdx',
  '.txt',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.log',
]);

const RISKY_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'cache',
  'caches',
  'gpucache',
  'code cache',
  'dawncache',
  'crashpad',
  'blob_storage',
  'indexeddb',
  'local storage',
  'session storage',
  'service worker',
  'browser profiles',
  'network',
]);

const RISKY_EXTENSIONS = new Set([
  '.sqlite',
  '.sqlite3',
  '.db',
  '.ldb',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.crt',
  '.cer',
]);

const RISKY_FILE_EXACT = new Set([
  '.env',
  '.env.local',
  'cookies',
  'login data',
  'web data',
  'local state',
  'preferences',
]);

const RISKY_NAME_FRAGMENTS = [
  'credential',
  'secret',
  'token',
  'password',
  'apikey',
  'api_key',
  'oauth',
  'auth.db',
  'keychain',
];

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'github-token', regex: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'openai-key', regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'pem-block', regex: /-----BEGIN [A-Z ]{3,}-----/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: 'json-secret-field',
    regex: /"(authorization|api[_-]?key|apikey|token|secret|password)"\s*:\s*"(Bearer |Basic |Token )?[A-Za-z0-9_./+=-]{16,}"/gi,
  },
];

export function getHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function getGstackHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GSTACK_HOME || path.join(getHomeDir(env), '.gstack');
}

export function getDefaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getGstackHome(env), 'context-sync', 'config.json');
}

export function defaultDeviceId(platform: NodeJS.Platform = process.platform): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  return `${host || 'device'}-${platform}`;
}

export function detectDefaultDriveRoot(
  homeDir = getHomeDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return `G:\\My Drive\\${DEFAULT_DRIVE_FOLDER_NAME}`;
  }

  const cloudStorage = path.join(homeDir, 'Library', 'CloudStorage');
  try {
    for (const entry of fs.readdirSync(cloudStorage, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith('googledrive')) continue;
      const candidate = path.join(cloudStorage, entry.name, 'My Drive', DEFAULT_DRIVE_FOLDER_NAME);
      return candidate;
    }
  } catch {}

  return path.join(homeDir, 'Google Drive', 'My Drive', DEFAULT_DRIVE_FOLDER_NAME);
}

export function defaultSources(
  homeDir = getHomeDir(),
  platform: NodeJS.Platform = process.platform,
): ContextSyncSource[] {
  const appData = platform === 'win32'
    ? path.join(homeDir, 'AppData', 'Roaming', 'Claude')
    : path.join(homeDir, 'Library', 'Application Support', 'Claude');

  return [
    {
      id: 'codex-sessions',
      kind: 'chat',
      path: path.join(homeDir, '.codex', 'sessions'),
      label: 'Codex chat sessions',
    },
    {
      id: 'codex-session-index',
      kind: 'index',
      path: path.join(homeDir, '.codex', 'session_index.jsonl'),
      label: 'Codex session index',
    },
    {
      id: 'codex-documents',
      kind: 'files',
      path: path.join(homeDir, 'Documents', 'Codex'),
      label: 'Codex local folders',
    },
    {
      id: 'claude-home',
      kind: 'files',
      path: path.join(homeDir, '.claude'),
      label: 'Claude local folders',
    },
    {
      id: 'claude-code-sessions',
      kind: 'chat',
      path: path.join(appData, 'claude-code-sessions'),
      label: 'Claude Code sessions',
    },
    {
      id: 'claude-cowork-sessions',
      kind: 'chat',
      path: path.join(appData, 'local-agent-mode-sessions'),
      label: 'Claude Cowork sessions',
    },
  ];
}

export function makeDefaultConfig(options: InitOptions = {}): ContextSyncConfig {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || getHomeDir();
  const now = new Date().toISOString();

  return {
    schemaVersion: CONTEXT_SYNC_SCHEMA_VERSION,
    deviceId: options.deviceId || defaultDeviceId(platform),
    driveRoot: options.driveRoot || detectDefaultDriveRoot(homeDir, platform),
    sources: defaultSources(homeDir, platform),
    createdAt: now,
    updatedAt: now,
  };
}

export function loadConfig(configPath = getDefaultConfigPath()): ContextSyncConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (parsed.schemaVersion !== CONTEXT_SYNC_SCHEMA_VERSION) {
    throw new Error(`Unsupported context-sync schemaVersion: ${parsed.schemaVersion}`);
  }
  if (!parsed.deviceId || !parsed.driveRoot || !Array.isArray(parsed.sources)) {
    throw new Error(`Invalid context-sync config: ${configPath}`);
  }
  return parsed as ContextSyncConfig;
}

export function saveConfig(config: ContextSyncConfig, configPath = getDefaultConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function initConfig(options: InitOptions = {}): InitResult {
  const configPath = options.configPath || getDefaultConfigPath();
  if (fs.existsSync(configPath) && !options.force) {
    return { created: false, configPath, config: loadConfig(configPath) };
  }

  const config = makeDefaultConfig(options);
  saveConfig(config, configPath);
  return { created: true, configPath, config };
}

export function normalizePathForId(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

export function logicalIdFor(sourceId: string, relativePath: string): string {
  return crypto
    .createHash('sha256')
    .update(`${sourceId}:${normalizePathForId(relativePath)}`)
    .digest('hex')
    .slice(0, 32);
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
  }
  return redacted;
}

export async function scanConfig(
  config: ContextSyncConfig,
  opts: { configPath?: string; hashFiles?: boolean } = {},
): Promise<DryRunReport> {
  const generatedAt = new Date().toISOString();
  const inventory: SourceInventory[] = [];
  const plannedCopies: PlannedCopy[] = [];
  const skippedRisk: SkippedItem[] = [];
  const sensitiveFindings: SensitiveFinding[] = [];

  for (const source of config.sources) {
    const sourceInventory: SourceInventory = {
      sourceId: source.id,
      kind: source.kind,
      path: source.path,
      exists: fs.existsSync(source.path),
      plannedCount: 0,
      skippedCount: 0,
      estimatedBytes: 0,
    };

    if (!sourceInventory.exists) {
      skippedRisk.push({ sourceId: source.id, path: source.path, reason: 'source path missing' });
      sourceInventory.skippedCount++;
      inventory.push(sourceInventory);
      continue;
    }

    const files = collectSourceFiles(source, skippedRisk);
    for (const filePath of files) {
      const stat = fs.statSync(filePath);
      const relativePath = relativePathFor(source.path, filePath);
      const shouldHash = opts.hashFiles !== false;
      const sha256 = shouldHash ? await hashFile(filePath) : 'pending-until-commit';
      const logicalId = logicalIdFor(source.id, relativePath);
      const sensitivePatterns = await detectSensitivePatterns(filePath);
      if (sensitivePatterns.length > 0) {
        sensitiveFindings.push({
          sourceId: source.id,
          relativePath,
          patterns: sensitivePatterns,
        });
      }

      const rawRelativePath = joinRelative(
        'devices',
        config.deviceId,
        source.id,
        'raw',
        safeRelativePath(relativePath),
      );
      const readableRelativePath = `${joinRelative(
        'devices',
        config.deviceId,
        source.id,
        'readable',
        safeRelativePath(relativePath),
      )}.md`;

      plannedCopies.push({
        id: crypto.createHash('sha256').update(`${filePath}:${sha256}`).digest('hex').slice(0, 16),
        logicalId,
        sourceId: source.id,
        sourceKind: source.kind,
        sourcePath: source.path,
        absolutePath: filePath,
        relativePath,
        rawRelativePath,
        readableRelativePath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256,
        hashStatus: shouldHash ? 'computed' : 'pending-until-commit',
        sensitivePatterns,
      });

      sourceInventory.plannedCount++;
      sourceInventory.estimatedBytes += stat.size;
    }

    sourceInventory.skippedCount += skippedRisk.filter(item => item.sourceId === source.id).length;
    inventory.push(sourceInventory);
  }

  return {
    schemaVersion: CONTEXT_SYNC_SCHEMA_VERSION,
    dryRun: true,
    generatedAt,
    deviceId: config.deviceId,
    driveRoot: config.driveRoot,
    configPath: opts.configPath,
    inventory,
    plannedCopies,
    estimatedBytes: plannedCopies.reduce((sum, copy) => sum + copy.sizeBytes, 0),
    sensitiveFindings,
    skippedRisk,
  };
}

export async function runCommit(config: ContextSyncConfig, opts: { configPath?: string } = {}): Promise<RunResult> {
  const report = await scanConfig(config, opts);
  const runId = makeRunId();
  ensureDriveLayout(config.driveRoot);
  writeControlFiles(config, runId);

  const existingVersions = readExistingVersions(config.driveRoot);
  const actions: ManifestAction[] = [];

  for (const planned of report.plannedCopies) {
    const rawTarget = path.join(config.driveRoot, ...planned.rawRelativePath.split('/'));
    const readableTarget = path.join(config.driveRoot, ...planned.readableRelativePath.split('/'));
    const copyAction = await copyRawPreservingConflicts(planned, rawTarget, config.driveRoot, runId);
    const conflictingVersions = existingVersions.filter(
      existing => existing.logicalId === planned.logicalId && existing.sha256 !== planned.sha256,
    );

    fs.mkdirSync(path.dirname(readableTarget), { recursive: true });
    fs.writeFileSync(readableTarget, buildReadableMarkdown(planned, config));

    const metadata = buildMetadata(planned, config, copyAction.rawRelativePath);
    const metadataTarget = `${readableTarget}.metadata.json`;
    fs.writeFileSync(metadataTarget, `${JSON.stringify(metadata, null, 2)}\n`);
    existingVersions.push(metadata);

    let action: ManifestAction['action'] = copyAction.action;
    let conflictRelativePath = copyAction.conflictRelativePath;
    if (conflictingVersions.length > 0) {
      action = 'conflict';
      conflictRelativePath = writeLogicalConflictRecord(
        config.driveRoot,
        planned,
        config,
        runId,
        conflictingVersions,
      );
    }

    actions.push({
      action,
      logicalId: planned.logicalId,
      sourceId: planned.sourceId,
      relativePath: planned.relativePath,
      sha256: planned.sha256,
      rawRelativePath: copyAction.rawRelativePath,
      readableRelativePath: planned.readableRelativePath,
      conflictRelativePath,
      conflictWith: conflictingVersions.map(v => ({
        deviceId: v.deviceId,
        sourceId: v.sourceId,
        relativePath: v.relativePath,
        sha256: v.sha256,
      })),
    });
  }

  rebuildIndexes(config.driveRoot);

  const manifest: RunManifest = {
    schemaVersion: CONTEXT_SYNC_SCHEMA_VERSION,
    dryRun: false,
    runId,
    generatedAt: new Date().toISOString(),
    deviceId: config.deviceId,
    driveRoot: config.driveRoot,
    plannedCount: report.plannedCopies.length,
    copiedCount: actions.filter(a => a.action === 'copied').length,
    dedupedCount: actions.filter(a => a.action === 'deduped').length,
    conflictCount: actions.filter(a => a.action === 'conflict').length,
    estimatedBytes: report.estimatedBytes,
    sensitiveFindings: report.sensitiveFindings,
    skippedRisk: report.skippedRisk,
    actions,
  };

  const date = manifest.generatedAt.slice(0, 10);
  const manifestDir = path.join(config.driveRoot, 'manifests', date);
  fs.mkdirSync(manifestDir, { recursive: true });
  const runManifestPath = path.join(manifestDir, `${config.deviceId}--${runId}.json`);
  const latestManifestPath = path.join(manifestDir, `${config.deviceId}.json`);
  fs.writeFileSync(runManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(latestManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifest, manifestPath: latestManifestPath };
}

export function getStatus(configPath = getDefaultConfigPath()): StatusReport {
  const generatedAt = new Date().toISOString();
  const configExists = fs.existsSync(configPath);
  if (!configExists) {
    return {
      schemaVersion: CONTEXT_SYNC_SCHEMA_VERSION,
      generatedAt,
      configPath,
      configExists: false,
      driveRootExists: false,
      sources: [],
      devices: [],
      indexExists: false,
    };
  }

  const config = loadConfig(configPath);
  const devicesDir = path.join(config.driveRoot, '_control', 'devices');
  const devices: StatusReport['devices'] = [];
  if (fs.existsSync(devicesDir)) {
    for (const entry of fs.readdirSync(devicesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const devicePath = path.join(devicesDir, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(devicePath, 'utf-8'));
        devices.push({
          deviceId: parsed.deviceId || entry.name.replace(/\.json$/, ''),
          path: devicePath,
          updatedAt: parsed.updatedAt,
        });
      } catch {
        devices.push({ deviceId: entry.name.replace(/\.json$/, ''), path: devicePath });
      }
    }
  }

  return {
    schemaVersion: CONTEXT_SYNC_SCHEMA_VERSION,
    generatedAt,
    configPath,
    configExists: true,
    deviceId: config.deviceId,
    driveRoot: config.driveRoot,
    driveRootExists: fs.existsSync(config.driveRoot),
    sources: config.sources.map(source => ({
      sourceId: source.id,
      kind: source.kind,
      path: source.path,
      exists: fs.existsSync(source.path),
    })),
    devices,
    indexExists: fs.existsSync(path.join(config.driveRoot, 'index', 'chats.jsonl'))
      || fs.existsSync(path.join(config.driveRoot, 'index', 'files.jsonl')),
  };
}

function collectSourceFiles(source: ContextSyncSource, skipped: SkippedItem[]): string[] {
  const root = source.path;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    skipped.push({ sourceId: source.id, path: root, reason: 'symlink skipped' });
    return [];
  }
  if (stat.isFile()) {
    const risk = riskyReason(root, path.basename(root));
    if (risk) {
      skipped.push({ sourceId: source.id, path: root, reason: risk });
      return [];
    }
    return [root];
  }
  if (!stat.isDirectory()) return [];

  const out: string[] = [];
  walk(root, root, source.id, skipped, out);
  return out;
}

function walk(root: string, current: string, sourceId: string, skipped: SkippedItem[], out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    skipped.push({ sourceId, path: current, reason: 'unreadable path' });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const rel = path.relative(root, fullPath) || entry.name;
    const risk = riskyReason(fullPath, rel);
    if (risk) {
      skipped.push({ sourceId, path: fullPath, reason: risk });
      continue;
    }
    if (entry.isSymbolicLink()) {
      skipped.push({ sourceId, path: fullPath, reason: 'symlink skipped' });
      continue;
    }
    if (entry.isDirectory()) {
      walk(root, fullPath, sourceId, skipped, out);
      continue;
    }
    if (entry.isFile()) out.push(fullPath);
  }
}

function riskyReason(fullPath: string, relativePath: string): string | null {
  const normalized = normalizePathForId(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  for (const segment of segments) {
    if (RISKY_DIR_NAMES.has(segment)) return `risk path skipped: ${segment}`;
  }

  const base = path.basename(fullPath).toLowerCase();
  if (RISKY_FILE_EXACT.has(base)) return `credential or browser data skipped: ${base}`;
  if (RISKY_EXTENSIONS.has(path.extname(base))) return `opaque app database or key file skipped: ${path.extname(base)}`;
  for (const fragment of RISKY_NAME_FRAGMENTS) {
    if (base.includes(fragment)) return `credential-like file skipped: ${fragment}`;
  }
  return null;
}

function relativePathFor(sourcePath: string, filePath: string): string {
  const sourceStat = fs.statSync(sourcePath);
  const rel = sourceStat.isFile() ? path.basename(filePath) : path.relative(sourcePath, filePath);
  return rel.replace(/\\/g, '/');
}

function safeRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .map(part => part.replace(/[<>:"|?*\x00-\x1F]/g, '_'))
    .join('/');
}

function joinRelative(...parts: string[]): string {
  return parts
    .flatMap(part => part.split(/[\\/]+/))
    .filter(Boolean)
    .join('/');
}

async function detectSensitivePatterns(filePath: string): Promise<string[]> {
  if (!isLikelyText(filePath)) return [];
  const text = await readFilePrefix(filePath, 64 * 1024);
  const found: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) found.push(pattern.name);
  }
  return found;
}

function isLikelyText(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return !buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  }
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await fd.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead).toString('utf-8');
  } finally {
    await fd.close();
  }
}

function ensureDriveLayout(driveRoot: string): void {
  for (const rel of ['_control/devices', 'devices', 'index', 'manifests', 'conflicts']) {
    fs.mkdirSync(path.join(driveRoot, ...rel.split('/')), { recursive: true });
  }
}

function writeControlFiles(config: ContextSyncConfig, runId: string): void {
  const schema = {
    schemaVersion: CONTEXT_SYNC_SCHEMA_VERSION,
    name: DEFAULT_DRIVE_FOLDER_NAME,
    layout: ['_control', 'devices', 'index', 'manifests', 'conflicts'],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(config.driveRoot, '_control', 'schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
  fs.writeFileSync(
    path.join(config.driveRoot, '_control', 'devices', `${config.deviceId}.json`),
    `${JSON.stringify({
      schemaVersion: CONTEXT_SYNC_SCHEMA_VERSION,
      deviceId: config.deviceId,
      driveRoot: config.driveRoot,
      sourceCount: config.sources.length,
      updatedAt: new Date().toISOString(),
      lastRunId: runId,
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(config.driveRoot, '_control', 'sync-state.json'),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), lastRunId: runId }, null, 2)}\n`,
  );
}

async function copyRawPreservingConflicts(
  planned: PlannedCopy,
  rawTarget: string,
  driveRoot: string,
  runId: string,
): Promise<{ action: 'copied' | 'deduped' | 'conflict'; rawRelativePath: string; conflictRelativePath?: string }> {
  fs.mkdirSync(path.dirname(rawTarget), { recursive: true });
  if (!fs.existsSync(rawTarget)) {
    fs.copyFileSync(planned.absolutePath, rawTarget);
    return { action: 'copied', rawRelativePath: planned.rawRelativePath };
  }

  const existingHash = await hashFile(rawTarget);
  if (existingHash === planned.sha256) {
    return { action: 'deduped', rawRelativePath: planned.rawRelativePath };
  }

  const conflictRelativePath = joinRelative(
    'conflicts',
    planned.logicalId,
    `${runId}__${planned.sourceId}__${path.basename(safeRelativePath(planned.relativePath))}`,
  );
  const conflictTarget = path.join(driveRoot, ...conflictRelativePath.split('/'));
  fs.mkdirSync(path.dirname(conflictTarget), { recursive: true });
  fs.copyFileSync(planned.absolutePath, conflictTarget);
  return { action: 'conflict', rawRelativePath: conflictRelativePath, conflictRelativePath };
}

function buildReadableMarkdown(planned: PlannedCopy, config: ContextSyncConfig): string {
  const preview = buildPreview(planned.absolutePath, planned.sourceKind);
  const lines = [
    `# ${path.basename(planned.relativePath)}`,
    '',
    `- Device: ${config.deviceId}`,
    `- Source: ${planned.sourceId}`,
    `- Source kind: ${planned.sourceKind}`,
    `- Relative path: ${planned.relativePath}`,
    `- Size: ${planned.sizeBytes} bytes`,
    `- SHA-256: ${planned.sha256}`,
    `- Updated: ${new Date(planned.mtimeMs).toISOString()}`,
    `- Sensitive findings: ${planned.sensitivePatterns.length > 0 ? planned.sensitivePatterns.join(', ') : 'none detected'}`,
    '',
    '## Redacted Preview',
    '',
    preview || '_No readable preview available._',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function buildPreview(filePath: string, sourceKind: SourceKind): string {
  if (!isLikelyText(filePath)) return '';
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf-8').slice(0, 32 * 1024);
  } catch {
    return '';
  }

  if (sourceKind === 'chat' || path.extname(filePath).toLowerCase() === '.jsonl') {
    const parsed = summarizeJsonl(text);
    if (parsed) return parsed;
  }

  const redacted = redactSecrets(text).trim();
  if (!redacted) return '';
  const capped = redacted.slice(0, 4000);
  return `\`\`\`text\n${capped}\n\`\`\``;
}

function summarizeJsonl(text: string): string | null {
  const rows = text.split(/\r?\n/).filter(Boolean);
  if (rows.length === 0) return null;
  const summaries: string[] = [];
  let parsedCount = 0;
  for (const row of rows.slice(0, 60)) {
    try {
      const obj = JSON.parse(row);
      parsedCount++;
      const role = obj.role || obj.message?.role || obj.type || obj.event || 'entry';
      const content = extractTextContent(obj);
      if (content) summaries.push(`- ${role}: ${redactSecrets(content).replace(/\s+/g, ' ').slice(0, 240)}`);
    } catch {}
    if (summaries.length >= 20) break;
  }
  if (parsedCount === 0) return null;
  return [`Parsed JSONL entries: ${parsedCount}`, '', ...summaries].join('\n');
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  for (const key of ['content', 'text', 'summary']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }
  if (Array.isArray(obj.content)) {
    return obj.content
      .map(item => typeof item === 'string' ? item : extractTextContent(item))
      .filter(Boolean)
      .join(' ');
  }
  if (obj.message) return extractTextContent(obj.message);
  return '';
}

function buildMetadata(planned: PlannedCopy, config: ContextSyncConfig, rawRelativePath: string): ExistingVersion {
  return {
    logicalId: planned.logicalId,
    deviceId: config.deviceId,
    sourceId: planned.sourceId,
    relativePath: planned.relativePath,
    sha256: planned.sha256,
    rawRelativePath,
  };
}

function readExistingVersions(driveRoot: string): ExistingVersion[] {
  const versions: ExistingVersion[] = [];
  const devicesRoot = path.join(driveRoot, 'devices');
  if (!fs.existsSync(devicesRoot)) return versions;
  for (const file of walkFiles(devicesRoot)) {
    if (!file.endsWith('.metadata.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (parsed.logicalId && parsed.deviceId && parsed.sourceId && parsed.relativePath && parsed.sha256) {
        versions.push(parsed);
      }
    } catch {}
  }
  return versions;
}

function writeLogicalConflictRecord(
  driveRoot: string,
  planned: PlannedCopy,
  config: ContextSyncConfig,
  runId: string,
  conflictingVersions: ExistingVersion[],
): string {
  const conflictRelativePath = joinRelative('conflicts', planned.logicalId, `${runId}__${config.deviceId}__${planned.sourceId}.json`);
  const conflictPath = path.join(driveRoot, ...conflictRelativePath.split('/'));
  fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
  fs.writeFileSync(
    conflictPath,
    `${JSON.stringify({
      logicalId: planned.logicalId,
      detectedAt: new Date().toISOString(),
      current: {
        deviceId: config.deviceId,
        sourceId: planned.sourceId,
        relativePath: planned.relativePath,
        sha256: planned.sha256,
        rawRelativePath: planned.rawRelativePath,
      },
      conflictingVersions,
    }, null, 2)}\n`,
  );
  return conflictRelativePath;
}

function rebuildIndexes(driveRoot: string): void {
  const versions = readExistingVersions(driveRoot);
  fs.mkdirSync(path.join(driveRoot, 'index'), { recursive: true });
  const chatRows: string[] = [];
  const fileRows: string[] = [];
  for (const version of versions.sort((a, b) => `${a.sourceId}:${a.relativePath}`.localeCompare(`${b.sourceId}:${b.relativePath}`))) {
    const row = JSON.stringify(version);
    if (version.sourceId.includes('session') || version.sourceId.includes('claude')) {
      chatRows.push(row);
    } else {
      fileRows.push(row);
    }
  }
  fs.writeFileSync(path.join(driveRoot, 'index', 'chats.jsonl'), chatRows.length ? `${chatRows.join('\n')}\n` : '');
  fs.writeFileSync(path.join(driveRoot, 'index', 'files.jsonl'), fileRows.length ? `${fileRows.join('\n')}\n` : '');
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function makeRunId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
}
