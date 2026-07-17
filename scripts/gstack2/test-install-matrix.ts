#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_ASSIGNMENTS } from './assignments';

export const PUBLIC_SKILLS = ['debug', 'design', 'plan', 'qa', 'review', 'ship'] as const;
export const COLLISION_SKILLS = ['qa', 'review', 'ship'] as const;
export type PublicSkill = (typeof PUBLIC_SKILLS)[number];
export type InstallScope = 'project' | 'global';

export interface AgentMatrixEntry {
  agent: string;
  label: string;
  projectPath: readonly string[];
  globalPath: readonly string[];
}

/**
 * Destination paths are the contract exposed by skills CLI 1.5.x. Several
 * standards-native hosts intentionally share the canonical .agents/skills
 * location. Every matrix case gets its own project and HOME, so a shared path
 * cannot make one host's result pass on another host's installation.
 */
export const AGENT_MATRIX: readonly AgentMatrixEntry[] = [
  {
    agent: 'claude-code',
    label: 'Claude Code',
    projectPath: ['.claude', 'skills'],
    globalPath: ['.claude', 'skills'],
  },
  {
    agent: 'codex',
    label: 'Codex',
    projectPath: ['.agents', 'skills'],
    globalPath: ['.agents', 'skills'],
  },
  {
    agent: 'cursor',
    label: 'Cursor',
    projectPath: ['.agents', 'skills'],
    globalPath: ['.agents', 'skills'],
  },
  {
    agent: 'pi',
    label: 'Pi',
    projectPath: ['.pi', 'skills'],
    globalPath: ['.pi', 'agent', 'skills'],
  },
  {
    agent: 'openclaw',
    label: 'OpenClaw',
    projectPath: ['skills'],
    globalPath: ['.openclaw', 'skills'],
  },
  {
    agent: 'github-copilot',
    label: 'GitHub Copilot',
    projectPath: ['.agents', 'skills'],
    globalPath: ['.agents', 'skills'],
  },
] as const;

export interface CheckResult {
  id: string;
  passed: boolean;
  detail: string;
}

export interface RepositoryInspection {
  publicSkills: string[];
  skillFiles: string[];
  checks: CheckResult[];
  passed: boolean;
}

export interface CommandEvidence {
  argv: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface InstallCaseEvidence {
  id: string;
  agent: string;
  agentLabel: string;
  scope: InstallScope;
  sourceKind: 'path-with-spaces' | 'source-symlink' | 'repository-root';
  expectedRoot: string;
  expectedSkills: string[];
  installedSkills: string[];
  checks: CheckResult[];
  command: CommandEvidence;
  passed: boolean;
}

export interface RemovalEvidence {
  id: string;
  agent: string;
  scope: InstallScope;
  supported: boolean;
  removedSkills: string[];
  checks: CheckResult[];
  command?: CommandEvidence;
  passed: boolean;
}

export interface InstallMatrixEvidence {
  schemaVersion: 1;
  mode: 'full';
  generatedAt: string;
  platform: NodeJS.Platform;
  architecture: string;
  repositoryRoot: string;
  sourceProjection: 'repository-root-and-canonical-projection';
  cli: {
    executable: string;
    version: string;
    supportsCopy: boolean;
    supportsRemoval: boolean;
    versionCommand: CommandEvidence;
    helpCommand: CommandEvidence;
  };
  repository: RepositoryInspection;
  discovery: {
    count: number | null;
    names: string[];
    checks: CheckResult[];
    command: CommandEvidence;
    passed: boolean;
  };
  installs: InstallCaseEvidence[];
  removals: RemovalEvidence[];
  summary: {
    passed: boolean;
    checks: number;
    passedChecks: number;
    failedChecks: number;
    installCases: number;
    removalCases: number;
  };
  limitations: string[];
}

export interface FullMatrixOptions {
  repoRoot: string;
  outputPath: string;
  npxExecutable?: string;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

function normalizeRelative(file: string): string {
  return file.split(path.sep).join('/');
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) results.push(normalizeRelative(path.relative(root, absolute)));
    }
  };
  visit(root);
  return results.sort();
}

function frontmatterName(content: string): string | null {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return frontmatter?.match(/^name:\s*([^\s#]+)\s*$/m)?.[1] ?? null;
}

function record(checks: CheckResult[], id: string, passed: unknown, detail: string): boolean {
  const result = Boolean(passed);
  checks.push({ id, passed: result, detail });
  return result;
}

export function inspectRepository(repoRoot = DEFAULT_REPO_ROOT): RepositoryInspection {
  const skillsRoot = path.join(repoRoot, 'skills');
  const checks: CheckResult[] = [];
  const publicSkills = fs.existsSync(skillsRoot)
    ? fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort()
    : [];
  const skillFiles = walkFiles(skillsRoot)
    .filter((file) => {
      const parts = file.split('/');
      return parts.length === 2 && parts[1] === 'SKILL.md' && (PUBLIC_SKILLS as readonly string[]).includes(parts[0]);
    })
    .sort();
  const expectedFiles = PUBLIC_SKILLS.map((skill) => `${skill}/SKILL.md`).sort();

  record(
    checks,
    'repository.public-skill-names',
    JSON.stringify(publicSkills) === JSON.stringify([...PUBLIC_SKILLS]),
    `expected ${PUBLIC_SKILLS.join(', ')}; found ${publicSkills.join(', ') || '(none)'}`,
  );
  record(
    checks,
    'repository.public-skill-files',
    JSON.stringify(skillFiles) === JSON.stringify(expectedFiles),
    `expected only ${expectedFiles.join(', ')}; found ${skillFiles.join(', ') || '(none)'}`,
  );

  const seenNames = new Map<string, string>();
  for (const skill of PUBLIC_SKILLS) {
    const file = path.join(skillsRoot, skill, 'SKILL.md');
    const exists = fs.existsSync(file);
    record(checks, `repository.${skill}.exists`, exists, exists ? normalizeRelative(path.relative(repoRoot, file)) : `missing ${file}`);
    if (!exists) continue;
    const name = frontmatterName(fs.readFileSync(file, 'utf8'));
    record(checks, `repository.${skill}.frontmatter-name`, name === skill, `expected ${skill}; found ${name ?? '(missing)'}`);
    if (name) {
      const prior = seenNames.get(name);
      record(checks, `repository.${skill}.unique-name`, !prior, prior ? `${name} also appears in ${prior}` : `${name} is unique`);
      seenNames.set(name, normalizeRelative(path.relative(repoRoot, file)));
    }
    const references = path.join(skillsRoot, skill, 'references', 'legacy');
    record(
      checks,
      `repository.${skill}.preserved-modules`,
      fs.existsSync(references) && walkFiles(references).length > 0,
      fs.existsSync(references) ? `${walkFiles(references).length} preserved module files` : `missing ${references}`,
    );
  }

  for (const skill of COLLISION_SKILLS) {
    record(
      checks,
      `repository.collision.${skill}.canonical`,
      seenNames.get(skill) === `skills/${skill}/SKILL.md`,
      `frontmatter name ${skill} resolves to ${seenNames.get(skill) ?? '(missing)'}`,
    );
  }

  const compatibilityRoot = path.join(skillsRoot, '.compat');
  const compatibilityAliases = fs.existsSync(compatibilityRoot)
    ? fs.readdirSync(compatibilityRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(compatibilityRoot, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort()
    : [];
  const expectedAliases = SOURCE_ASSIGNMENTS
    .map((entry) => entry.source)
    .filter((source) => !(PUBLIC_SKILLS as readonly string[]).includes(source))
    .sort();
  record(
    checks,
    'repository.compatibility-aliases',
    JSON.stringify(compatibilityAliases) === JSON.stringify(expectedAliases),
    `expected ${expectedAliases.length} aliases; found ${compatibilityAliases.length}`,
  );
  for (const assignment of SOURCE_ASSIGNMENTS) {
    const aliasFile = path.join(compatibilityRoot, assignment.source, 'SKILL.md');
    if (!fs.existsSync(aliasFile)) continue;
    const alias = fs.readFileSync(aliasFile, 'utf8');
    record(checks, `repository.compat.${assignment.source}.name`, frontmatterName(alias) === assignment.source, `name=${frontmatterName(alias) ?? '(missing)'}`);
    record(checks, `repository.compat.${assignment.source}.internal`, /^metadata:\s*\n(?:[ \t]+.*\n)*?[ \t]+internal:\s*true\s*$/m.test(alias.slice(0, alias.indexOf('\n---', 4))), 'alias is internal');
    record(checks, `repository.compat.${assignment.source}.thin`, alias.includes(assignment.replacement) && !alias.includes('GSTACK2_LEGACY_BODY_START') && alias.split('\n').length < 30, `replacement=${assignment.replacement}`);
  }

  return {
    publicSkills,
    skillFiles,
    checks,
    passed: checks.every((check) => check.passed),
  };
}

/** Project the clean-checkout discovery surface. Ignored host trees are absent,
 * while tracked 1.x compatibility entries remain present and internal. */
export function createCanonicalSourceProjection(repoRoot: string, destination: string): void {
  const inspection = inspectRepository(repoRoot);
  if (!inspection.passed) {
    const failures = inspection.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`);
    throw new Error(`Cannot project an invalid public skill tree:\n${failures.join('\n')}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'skills'), path.join(destination, 'skills'), {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'skills' || entry.name.startsWith('.')) continue;
    const legacySkill = path.join(repoRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(legacySkill)) continue;
    const content = fs.readFileSync(legacySkill, 'utf8');
    if (!/^metadata:\s*\n(?:[ \t]+.*\n)*?[ \t]+internal:\s*true\s*$/m.test(content.slice(0, content.indexOf('\n---', 4)))) {
      throw new Error(`Legacy compatibility skill is not internal: ${legacySkill}`);
    }
    const target = path.join(destination, entry.name, 'SKILL.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(legacySkill, target);
  }
}

export function expectedInstallRoot(
  entry: AgentMatrixEntry,
  scope: InstallScope,
  projectRoot: string,
  homeRoot: string,
): string {
  return path.join(scope === 'project' ? projectRoot : homeRoot, ...(scope === 'project' ? entry.projectPath : entry.globalPath));
}

function directoryHash(directory: string): string | null {
  if (!fs.existsSync(directory)) return null;
  const digest = createHash('sha256');
  for (const relative of walkFiles(directory)) {
    const absolute = path.join(directory, ...relative.split('/'));
    const stat = fs.lstatSync(absolute);
    digest.update(relative);
    digest.update('\0');
    if (stat.isSymbolicLink()) digest.update(`symlink:${fs.readlinkSync(absolute)}`);
    else digest.update(fs.readFileSync(absolute));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function listInstalledSkills(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

export function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?=[^\n])/g, '')
    .trim();
}

function trimEvidenceOutput(value: string, maxCharacters = 16_000): string {
  const clean = stripTerminalControls(value);
  if (clean.length <= maxCharacters) return clean;
  return `${clean.slice(0, maxCharacters)}\n[output truncated at ${maxCharacters} characters]`;
}

function execute(argv: string[], cwd: string, env: NodeJS.ProcessEnv): CommandEvidence {
  const started = performance.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    shell: false,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    argv,
    exitCode: result.status,
    signal: result.signal,
    durationMs: Math.round(performance.now() - started),
    stdout: trimEvidenceOutput(result.stdout ?? ''),
    stderr: trimEvidenceOutput(`${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`),
  };
}

export function skillsCliArgv(npxExecutable: string, args: readonly string[]): string[] {
  return [npxExecutable, '--yes', 'skills', ...args];
}

function isolatedEnvironment(home: string, npmCache: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
    DISABLE_TELEMETRY: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  // Host-specific state overrides would defeat HOME isolation if inherited.
  for (const variable of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENCLAW_HOME', 'PI_CONFIG_DIR']) delete env[variable];
  return env;
}

function parseDiscovery(output: string): { count: number | null; names: string[] } {
  const clean = stripTerminalControls(output);
  const count = Number(clean.match(/Found\s+(\d+)\s+skills?/)?.[1]);
  const names = clean
    .split('\n')
    .map((line) => line.match(/^\s*│\s{4}([a-z][a-z0-9-]*)\s*$/)?.[1] ?? null)
    .filter((name): name is string => Boolean(name))
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();
  return { count: Number.isFinite(count) ? count : null, names };
}

function verifyInstalledCase(
  id: string,
  entry: AgentMatrixEntry,
  scope: InstallScope,
  sourceKind: InstallCaseEvidence['sourceKind'],
  expectedSkills: readonly string[],
  sourceRoot: string,
  sourceSkillSegments: readonly string[],
  projectRoot: string,
  homeRoot: string,
  command: CommandEvidence,
): InstallCaseEvidence {
  const checks: CheckResult[] = [];
  const targetRoot = expectedInstallRoot(entry, scope, projectRoot, homeRoot);
  const installedSkills = listInstalledSkills(targetRoot);
  const sortedExpected = [...expectedSkills].sort();
  record(checks, `${id}.command`, command.exitCode === 0, `exit=${command.exitCode}; signal=${command.signal ?? 'none'}`);
  record(
    checks,
    `${id}.selected-skills`,
    JSON.stringify(installedSkills) === JSON.stringify(sortedExpected),
    `expected ${sortedExpected.join(', ')}; found ${installedSkills.join(', ') || '(none)'}`,
  );

  for (const skill of sortedExpected) {
    const source = path.join(sourceRoot, ...sourceSkillSegments, skill);
    const installed = path.join(targetRoot, skill);
    const sourceHash = directoryHash(source);
    const installedHash = directoryHash(installed);
    record(checks, `${id}.${skill}.content`, sourceHash !== null && sourceHash === installedHash, `source=${sourceHash}; installed=${installedHash}`);
    const copied = fs.existsSync(installed)
      && !fs.lstatSync(installed).isSymbolicLink()
      && !fs.lstatSync(path.join(installed, 'SKILL.md')).isSymbolicLink();
    record(checks, `${id}.${skill}.copy`, copied, copied ? 'directory and SKILL.md are physical copies' : 'symlink detected or file missing');
    const installedName = fs.existsSync(path.join(installed, 'SKILL.md'))
      ? frontmatterName(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'))
      : null;
    record(checks, `${id}.${skill}.canonical-name`, installedName === skill, `expected ${skill}; found ${installedName ?? '(missing)'}`);
  }

  return {
    id,
    agent: entry.agent,
    agentLabel: entry.label,
    scope,
    sourceKind,
    expectedRoot: targetRoot,
    expectedSkills: sortedExpected,
    installedSkills,
    checks,
    command,
    passed: checks.every((check) => check.passed),
  };
}

function runInstallCase(options: {
  id: string;
  entry: AgentMatrixEntry;
  scope: InstallScope;
  sourceKind: InstallCaseEvidence['sourceKind'];
  sourceArgument: string;
  sourceRoot: string;
  expectedSkills: readonly string[];
  explicitSelection: boolean;
  sourceSkillSegments?: readonly string[];
  workspaceRoot: string;
  npmCache: string;
  npxExecutable: string;
}): { evidence: InstallCaseEvidence; projectRoot: string; homeRoot: string; env: NodeJS.ProcessEnv } {
  const caseRoot = path.join(options.workspaceRoot, 'cases', options.id);
  const projectRoot = path.join(caseRoot, 'project with spaces');
  const homeRoot = path.join(caseRoot, 'home with spaces');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });
  const env = isolatedEnvironment(homeRoot, options.npmCache);
  const args = ['add', options.sourceArgument];
  if (options.explicitSelection) args.push('--skill', ...options.expectedSkills);
  args.push('--agent', options.entry.agent, '--copy', '--yes');
  if (options.scope === 'global') args.push('--global');
  const command = execute(skillsCliArgv(options.npxExecutable, args), projectRoot, env);
  return {
    evidence: verifyInstalledCase(
      options.id,
      options.entry,
      options.scope,
      options.sourceKind,
      options.expectedSkills,
      options.sourceRoot,
      options.sourceSkillSegments ?? ['skills'],
      projectRoot,
      homeRoot,
      command,
    ),
    projectRoot,
    homeRoot,
    env,
  };
}

function runRemoval(options: {
  id: string;
  entry: AgentMatrixEntry;
  scope: InstallScope;
  skills: readonly string[];
  projectRoot: string;
  homeRoot: string;
  env: NodeJS.ProcessEnv;
  npxExecutable: string;
  supported: boolean;
}): RemovalEvidence {
  if (!options.supported) {
    return {
      id: options.id,
      agent: options.entry.agent,
      scope: options.scope,
      supported: false,
      removedSkills: [...options.skills],
      checks: [],
      passed: true,
    };
  }
  const args = ['remove', '--skill', ...options.skills, '--agent', options.entry.agent, '--yes'];
  if (options.scope === 'global') args.push('--global');
  const command = execute(skillsCliArgv(options.npxExecutable, args), options.projectRoot, options.env);
  const targetRoot = expectedInstallRoot(options.entry, options.scope, options.projectRoot, options.homeRoot);
  const checks: CheckResult[] = [];
  record(checks, `${options.id}.command`, command.exitCode === 0, `exit=${command.exitCode}; signal=${command.signal ?? 'none'}`);
  for (const skill of options.skills) {
    const removed = !fs.existsSync(path.join(targetRoot, skill));
    record(checks, `${options.id}.${skill}.removed`, removed, removed ? 'removed' : `still present at ${path.join(targetRoot, skill)}`);
  }
  return {
    id: options.id,
    agent: options.entry.agent,
    scope: options.scope,
    supported: true,
    removedSkills: [...options.skills],
    checks,
    command,
    passed: checks.every((check) => check.passed),
  };
}

export function runFastChecks(repoRoot = DEFAULT_REPO_ROOT): RepositoryInspection {
  return inspectRepository(repoRoot);
}

export function runFullMatrix(options: FullMatrixOptions): InstallMatrixEvidence {
  if (!options.outputPath) throw new Error('Full install matrix requires a caller-supplied outputPath');
  const repoRoot = path.resolve(options.repoRoot);
  const outputPath = path.resolve(options.outputPath);
  const npxExecutable = options.npxExecutable ?? (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const repository = inspectRepository(repoRoot);
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack install matrix '));
  const npmCache = path.join(workspaceRoot, 'npm cache');
  const sourceRoot = path.join(workspaceRoot, 'canonical package', 'source with spaces');
  const sourceLink = path.join(workspaceRoot, 'linked canonical source');
  fs.mkdirSync(npmCache, { recursive: true });

  let evidence: InstallMatrixEvidence | null = null;
  try {
    createCanonicalSourceProjection(repoRoot, sourceRoot);
    fs.symlinkSync(sourceRoot, sourceLink, process.platform === 'win32' ? 'junction' : 'dir');

    const controlHome = path.join(workspaceRoot, 'control home');
    const controlProject = path.join(workspaceRoot, 'control project');
    fs.mkdirSync(controlHome, { recursive: true });
    fs.mkdirSync(controlProject, { recursive: true });
    const controlEnv = isolatedEnvironment(controlHome, npmCache);
    const versionCommand = execute(skillsCliArgv(npxExecutable, ['--version']), controlProject, controlEnv);
    const helpCommand = execute(skillsCliArgv(npxExecutable, ['--help']), controlProject, controlEnv);
    const version = versionCommand.stdout.split(/\s+/).find((part) => /^\d+\.\d+\.\d+/.test(part)) ?? 'unknown';
    const supportsCopy = /--copy\b/.test(helpCommand.stdout);
    const supportsRemoval = /remove\s+\[skills\]/.test(helpCommand.stdout) && /Remove Options/.test(helpCommand.stdout);

    const discoveryCommand = execute(
      // Exercise the repository root exactly as the documented
      // `npx skills add time-attack/gstack` path will after checkout. The
      // curated projection alone could hide stray root-level SKILL.md files.
      skillsCliArgv(npxExecutable, ['add', repoRoot, '--list']),
      controlProject,
      controlEnv,
    );
    const parsedDiscovery = parseDiscovery(discoveryCommand.stdout);
    const discoveryChecks: CheckResult[] = [];
    record(discoveryChecks, 'discovery.command', discoveryCommand.exitCode === 0, `exit=${discoveryCommand.exitCode}`);
    record(discoveryChecks, 'discovery.copy-supported', supportsCopy, supportsCopy ? '--copy is supported' : '--copy missing from CLI help');
    record(discoveryChecks, 'discovery.count', parsedDiscovery.count === PUBLIC_SKILLS.length, `expected 6; found ${parsedDiscovery.count ?? '(unparsed)'}`);
    record(
      discoveryChecks,
      'discovery.names',
      JSON.stringify(parsedDiscovery.names) === JSON.stringify([...PUBLIC_SKILLS]),
      `expected ${PUBLIC_SKILLS.join(', ')}; found ${parsedDiscovery.names.join(', ') || '(unparsed)'}`,
    );

    const installs: InstallCaseEvidence[] = [];
    for (const [agentIndex, entry] of AGENT_MATRIX.entries()) {
      for (const scope of ['project', 'global'] as const) {
        const sourceKind: InstallCaseEvidence['sourceKind'] = (agentIndex + (scope === 'global' ? 1 : 0)) % 2 === 0
          ? 'path-with-spaces'
          : 'source-symlink';
        const id = `${entry.agent}-${scope}-default`;
        installs.push(runInstallCase({
          id,
          entry,
          scope,
          sourceKind,
          sourceArgument: sourceKind === 'source-symlink' ? sourceLink : sourceRoot,
          sourceRoot,
          expectedSkills: PUBLIC_SKILLS,
          explicitSelection: false,
          workspaceRoot,
          npmCache,
          npxExecutable,
        }).evidence);
      }
    }

    const cursor = AGENT_MATRIX.find((entry) => entry.agent === 'cursor')!;
    const selectedProject = runInstallCase({
      id: 'collision-selection-project',
      entry: cursor,
      scope: 'project',
      sourceKind: 'repository-root',
      sourceArgument: repoRoot,
      sourceRoot: repoRoot,
      expectedSkills: COLLISION_SKILLS,
      explicitSelection: true,
      workspaceRoot,
      npmCache,
      npxExecutable,
    });
    installs.push(selectedProject.evidence);

    const codex = AGENT_MATRIX.find((entry) => entry.agent === 'codex')!;
    const selectedGlobal = runInstallCase({
      id: 'collision-selection-global',
      entry: codex,
      scope: 'global',
      sourceKind: 'path-with-spaces',
      sourceArgument: sourceRoot,
      sourceRoot,
      expectedSkills: COLLISION_SKILLS,
      explicitSelection: true,
      workspaceRoot,
      npmCache,
      npxExecutable,
    });
    installs.push(selectedGlobal.evidence);

    const openclaw = AGENT_MATRIX.find((entry) => entry.agent === 'openclaw')!;
    const shipOnly = runInstallCase({
      id: 'single-skill-ship-project',
      entry: openclaw,
      scope: 'project',
      sourceKind: 'path-with-spaces',
      sourceArgument: sourceRoot,
      sourceRoot,
      expectedSkills: ['ship'],
      explicitSelection: true,
      workspaceRoot,
      npmCache,
      npxExecutable,
    });
    installs.push(shipOnly.evidence);

    const compatibilityAlias = runInstallCase({
      id: 'compatibility-alias-office-hours',
      entry: codex,
      scope: 'project',
      sourceKind: 'repository-root',
      sourceArgument: repoRoot,
      sourceRoot: repoRoot,
      sourceSkillSegments: ['skills', '.compat'],
      expectedSkills: ['office-hours'],
      explicitSelection: true,
      workspaceRoot,
      npmCache,
      npxExecutable,
    });
    installs.push(compatibilityAlias.evidence);

    const removals = [
      runRemoval({
        id: 'collision-removal-project',
        entry: cursor,
        scope: 'project',
        skills: COLLISION_SKILLS,
        projectRoot: selectedProject.projectRoot,
        homeRoot: selectedProject.homeRoot,
        env: selectedProject.env,
        npxExecutable,
        supported: supportsRemoval,
      }),
      runRemoval({
        id: 'collision-removal-global',
        entry: codex,
        scope: 'global',
        skills: COLLISION_SKILLS,
        projectRoot: selectedGlobal.projectRoot,
        homeRoot: selectedGlobal.homeRoot,
        env: selectedGlobal.env,
        npxExecutable,
        supported: supportsRemoval,
      }),
    ];

    const allChecks = [
      ...repository.checks,
      ...discoveryChecks,
      ...installs.flatMap((install) => install.checks),
      ...removals.flatMap((removal) => removal.checks),
    ];
    const failedChecks = allChecks.filter((check) => !check.passed).length;
    const limitations = [
      'The full matrix exercises the current local canonical skills/ tree through the published npx skills CLI; it does not fetch the not-yet-published branch from GitHub.',
      'The source projection excludes ignored/generated legacy host trees because those files are not part of a clean standards-based package checkout.',
      'This run proves filesystem installation/removal contracts; launching each host UI or agent process is outside the installer matrix.',
    ];
    if (!supportsRemoval) limitations.push('The installed skills CLI did not advertise safe non-interactive removal, so removal cases were recorded as unsupported and skipped.');

    evidence = {
      schemaVersion: 1,
      mode: 'full',
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      repositoryRoot: repoRoot,
    sourceProjection: 'repository-root-and-canonical-projection',
      cli: {
        executable: npxExecutable,
        version,
        supportsCopy,
        supportsRemoval,
        versionCommand,
        helpCommand,
      },
      repository,
      discovery: {
        count: parsedDiscovery.count,
        names: parsedDiscovery.names,
        checks: discoveryChecks,
        command: discoveryCommand,
        passed: discoveryChecks.every((check) => check.passed),
      },
      installs,
      removals,
      summary: {
        passed: failedChecks === 0,
        checks: allChecks.length,
        passedChecks: allChecks.length - failedChecks,
        failedChecks,
        installCases: installs.length,
        removalCases: removals.length,
      },
      limitations,
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const portableEvidence = replaceEvidencePaths(evidence, [
      [repoRoot, '<REPOSITORY_ROOT>'],
      [workspaceRoot, '<TEMP_MATRIX_ROOT>'],
    ]);
    fs.writeFileSync(outputPath, `${JSON.stringify(portableEvidence, null, 2)}\n`, 'utf8');
    return evidence;
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function replaceEvidencePaths<T>(value: T, replacements: Array<[string, string]>): T {
  if (typeof value === 'string') {
    return replacements.reduce((current, [from, to]) => current.split(from).join(to), value) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => replaceEvidencePaths(entry, replacements)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceEvidencePaths(child, replacements)]),
    ) as T;
  }
  return value;
}

interface CliOptions {
  full: boolean;
  repoRoot: string;
  outputPath?: string;
  npxExecutable?: string;
}

function usage(): string {
  return [
    'Usage: bun run scripts/gstack2/test-install-matrix.ts [options]',
    '',
    'Default mode performs deterministic, network-free repository checks.',
    '',
    'Options:',
    '  --full             Run the real npx skills install/remove matrix',
    '  --repo <path>      Repository root (default: detected root)',
    '  --output <path>    Machine-readable JSON evidence (defaults to the OS temp directory)',
    '  --npx <path>       Override npx executable (useful on Windows/CI)',
    '  --help             Show this help',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { full: false, repoRoot: DEFAULT_REPO_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--full') options.full = true;
    else if (argument === '--repo') options.repoRoot = path.resolve(argv[++index] ?? '');
    else if (argument === '--output') options.outputPath = path.resolve(argv[++index] ?? '');
    else if (argument === '--npx') options.npxExecutable = argv[++index];
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }
  if (options.full && !options.outputPath) {
    options.outputPath = path.join(os.tmpdir(), `gstack2-install-matrix-${process.pid}.json`);
  }
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.full) {
      const result = runFullMatrix({
        repoRoot: options.repoRoot,
        outputPath: options.outputPath!,
        npxExecutable: options.npxExecutable,
      });
      process.stdout.write(
        `GStack 2 install matrix ${result.summary.passed ? 'passed' : 'failed'}: `
        + `${result.summary.passedChecks}/${result.summary.checks} checks, `
        + `${result.summary.installCases} install cases, ${result.summary.removalCases} removal cases; `
        + `skills CLI ${result.cli.version}. Evidence: ${path.resolve(options.outputPath!)}\n`,
      );
      if (!result.summary.passed) process.exitCode = 1;
    } else {
      const result = runFastChecks(options.repoRoot);
      process.stdout.write(
        `GStack 2 install surface ${result.passed ? 'passed' : 'failed'}: `
        + `${result.checks.filter((check) => check.passed).length}/${result.checks.length} checks; `
        + `${result.publicSkills.length} public skills.\n`,
      );
      if (!result.passed) {
        for (const failure of result.checks.filter((check) => !check.passed)) {
          process.stderr.write(`- ${failure.id}: ${failure.detail}\n`);
        }
        process.exitCode = 1;
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
