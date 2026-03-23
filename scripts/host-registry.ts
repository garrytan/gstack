#!/usr/bin/env bun

import * as path from 'path';

export type SkillLayoutId = 'claude' | 'agents';
export type GeneratedHostId = 'claude' | 'codex';
export type HostId = GeneratedHostId | 'gemini';
export type InstallScope = 'user' | 'workspace';
export type DiscoveryMode = 'global' | 'workspace-sidecar' | 'both';
export type FrontmatterProfile = 'full' | 'minimal';
export type PathRewriteProfile = 'none' | 'shared-runtime';
export type ArtifactMaterializationStrategy = 'source' | 'generated';
export type LocalFirstResolutionPolicy = 'global-first' | 'workspace-first' | 'workspace-validated';
export type SessionRunnerId = 'claude' | 'codex' | 'gemini';
export type HostArg = GeneratedHostId | 'agents' | 'gemini';

export interface LayoutPaths {
  sharedRuntimeRoot: string;
  workspaceRuntimeRoot: string;
  sharedBinDir: string;
  sharedBrowseDir: string;
  sharedReviewDir: string;
}

export interface PathRewriteRule {
  pattern: RegExp;
  replacement: string;
}

export interface SkillLayoutProfile {
  id: SkillLayoutId;
  paths: LayoutPaths;
  frontmatterProfile: FrontmatterProfile;
  pathRewriteProfile: PathRewriteProfile;
  excludedSkills: string[];
  artifactMaterializationStrategy: ArtifactMaterializationStrategy;
  localFirstResolutionPolicy: LocalFirstResolutionPolicy;
  outputPath(root: string, skillDir: string): string;
  skillName(skillDir: string): string;
  pathRewrites: PathRewriteRule[];
}

export interface HostCapabilities {
  supportsGeneratedSkills: boolean;
  supportsGlobalInstall: boolean;
  supportsWorkspaceSidecar: boolean;
  supportsFrontmatterTransform: boolean;
  supportsPathRewrite: boolean;
  supportsSessionRunner: boolean;
  sessionRunnerId: SessionRunnerId;
}

export interface HostDefinition {
  id: HostId;
  layoutId: SkillLayoutId;
  supportedInstallModes: InstallScope[];
  discoveryMode: DiscoveryMode;
  globalSkillRoot: string | null;
  workspaceSkillRoot: string | null;
  generatedRootSkillPath: string;
  runtimeRoot: string;
  runtimeAssetSidecarRoot: string | null;
  discoverableSkillEntries: string[];
  runtimeSidecarAssets: string[];
  artifactMaterializationStrategy: ArtifactMaterializationStrategy;
  localFirstResolutionPolicy: LocalFirstResolutionPolicy;
  capabilities: HostCapabilities;
}

export interface ResolvedGenerationTarget {
  arg: HostArg;
  hostId: GeneratedHostId;
  layoutId: SkillLayoutId;
  host: HostDefinition;
  layout: SkillLayoutProfile;
}

export const SHARED_RUNTIME_ROOT = '~/.gstack';
export const WORKSPACE_RUNTIME_ROOT = '.gstack';
export const SHARED_RUNTIME_ASSETS = [
  'bin',
  'browse',
  '.agents',
  'ETHOS.md',
  'VERSION',
  'CHANGELOG.md',
  'SKILL.md',
  'SKILL.md.tmpl',
  'package.json',
  'scripts',
  'setup',
  'supabase',
  'review',
  'qa',
  'gstack-upgrade',
] as const;
export const RUNTIME_SIDECAR_ASSETS = SHARED_RUNTIME_ASSETS;

const SHARED_LAYOUT_PATHS: LayoutPaths = {
  sharedRuntimeRoot: SHARED_RUNTIME_ROOT,
  workspaceRuntimeRoot: WORKSPACE_RUNTIME_ROOT,
  sharedBinDir: `${SHARED_RUNTIME_ROOT}/bin`,
  sharedBrowseDir: `${SHARED_RUNTIME_ROOT}/browse/dist`,
  sharedReviewDir: `${SHARED_RUNTIME_ROOT}/review`,
};

const AGENTS_GENERATED_SKILL_ROOT = path.posix.join('.agents', 'skills');
const AGENTS_WORKSPACE_SKILL_ROOT = path.posix.join(
  WORKSPACE_RUNTIME_ROOT,
  AGENTS_GENERATED_SKILL_ROOT,
);
const AGENTS_GENERATED_ROOT_SKILL_PATH = path.posix.join(
  AGENTS_GENERATED_SKILL_ROOT,
  'gstack',
  'SKILL.md',
);

const SHARED_RUNTIME_PATH_REWRITES: PathRewriteRule[] = [
  { pattern: /~\/\.claude\/skills\/gstack/g, replacement: SHARED_RUNTIME_ROOT },
  { pattern: /\.claude\/skills\/gstack/g, replacement: SHARED_RUNTIME_ROOT },
  { pattern: /~\/\.claude\/skills\/review/g, replacement: `${SHARED_RUNTIME_ROOT}/review` },
  { pattern: /\.claude\/skills\/review/g, replacement: `${SHARED_RUNTIME_ROOT}/review` },
  { pattern: /~\/\.claude\/skills/g, replacement: SHARED_RUNTIME_ROOT },
  { pattern: /\.claude\/skills/g, replacement: SHARED_RUNTIME_ROOT },
];

export function codexSkillName(skillDir: string): string {
  if (skillDir === '.' || skillDir === '') return 'gstack';
  if (skillDir.startsWith('gstack-')) return skillDir;
  return `gstack-${skillDir}`;
}

export const LAYOUTS: Record<SkillLayoutId, SkillLayoutProfile> = {
  claude: {
    id: 'claude',
    paths: SHARED_LAYOUT_PATHS,
    frontmatterProfile: 'full',
    pathRewriteProfile: 'shared-runtime',
    excludedSkills: [],
    artifactMaterializationStrategy: 'source',
    localFirstResolutionPolicy: 'workspace-validated',
    outputPath(root, skillDir) {
      const baseDir = skillDir === '.' ? root : path.join(root, skillDir);
      return path.join(baseDir, 'SKILL.md');
    },
    skillName(skillDir) {
      return skillDir === '.' || skillDir === '' ? 'gstack' : skillDir;
    },
    pathRewrites: SHARED_RUNTIME_PATH_REWRITES,
  },
  agents: {
    id: 'agents',
    paths: SHARED_LAYOUT_PATHS,
    frontmatterProfile: 'minimal',
    pathRewriteProfile: 'shared-runtime',
    excludedSkills: ['codex'],
    artifactMaterializationStrategy: 'generated',
    localFirstResolutionPolicy: 'workspace-validated',
    outputPath(root, skillDir) {
      return path.join(root, AGENTS_GENERATED_SKILL_ROOT, codexSkillName(skillDir), 'SKILL.md');
    },
    skillName(skillDir) {
      return codexSkillName(skillDir);
    },
    pathRewrites: SHARED_RUNTIME_PATH_REWRITES,
  },
};

export const HOSTS: Record<HostId, HostDefinition> = {
  claude: {
    id: 'claude',
    layoutId: 'claude',
    supportedInstallModes: ['user', 'workspace'],
    discoveryMode: 'global',
    globalSkillRoot: '~/.claude/skills',
    workspaceSkillRoot: '.claude/skills',
    generatedRootSkillPath: 'SKILL.md',
    runtimeRoot: SHARED_RUNTIME_ROOT,
    runtimeAssetSidecarRoot: WORKSPACE_RUNTIME_ROOT,
    discoverableSkillEntries: ['~/.claude/skills/gstack', '~/.claude/skills/<skill>'],
    runtimeSidecarAssets: [...SHARED_RUNTIME_ASSETS],
    artifactMaterializationStrategy: 'source',
    localFirstResolutionPolicy: 'workspace-validated',
    capabilities: {
      supportsGeneratedSkills: true,
      supportsGlobalInstall: true,
      supportsWorkspaceSidecar: false,
      supportsFrontmatterTransform: false,
      supportsPathRewrite: true,
      supportsSessionRunner: true,
      sessionRunnerId: 'claude',
    },
  },
  codex: {
    id: 'codex',
    layoutId: 'agents',
    supportedInstallModes: ['user', 'workspace'],
    discoveryMode: 'both',
    globalSkillRoot: '~/.codex/skills',
    workspaceSkillRoot: AGENTS_WORKSPACE_SKILL_ROOT,
    generatedRootSkillPath: AGENTS_GENERATED_ROOT_SKILL_PATH,
    runtimeRoot: SHARED_RUNTIME_ROOT,
    runtimeAssetSidecarRoot: WORKSPACE_RUNTIME_ROOT,
    discoverableSkillEntries: [
      '~/.codex/skills/gstack',
      '~/.codex/skills/gstack-*',
      `${AGENTS_WORKSPACE_SKILL_ROOT}/gstack`,
      `${AGENTS_WORKSPACE_SKILL_ROOT}/gstack-*`,
    ],
    runtimeSidecarAssets: [...SHARED_RUNTIME_ASSETS],
    artifactMaterializationStrategy: 'generated',
    localFirstResolutionPolicy: 'workspace-validated',
    capabilities: {
      supportsGeneratedSkills: true,
      supportsGlobalInstall: true,
      supportsWorkspaceSidecar: true,
      supportsFrontmatterTransform: true,
      supportsPathRewrite: true,
      supportsSessionRunner: true,
      sessionRunnerId: 'codex',
    },
  },
  gemini: {
    id: 'gemini',
    layoutId: 'agents',
    supportedInstallModes: ['workspace'],
    discoveryMode: 'workspace-sidecar',
    globalSkillRoot: null,
    workspaceSkillRoot: AGENTS_WORKSPACE_SKILL_ROOT,
    generatedRootSkillPath: AGENTS_GENERATED_ROOT_SKILL_PATH,
    runtimeRoot: SHARED_RUNTIME_ROOT,
    runtimeAssetSidecarRoot: WORKSPACE_RUNTIME_ROOT,
    discoverableSkillEntries: [
      `${AGENTS_WORKSPACE_SKILL_ROOT}/gstack`,
      `${AGENTS_WORKSPACE_SKILL_ROOT}/gstack-*`,
    ],
    runtimeSidecarAssets: [...SHARED_RUNTIME_ASSETS],
    artifactMaterializationStrategy: 'generated',
    localFirstResolutionPolicy: 'workspace-validated',
    capabilities: {
      supportsGeneratedSkills: true,
      supportsGlobalInstall: false,
      supportsWorkspaceSidecar: true,
      supportsFrontmatterTransform: true,
      supportsPathRewrite: true,
      supportsSessionRunner: true,
      sessionRunnerId: 'gemini',
    },
  },
};

export const GENERATED_HOSTS: GeneratedHostId[] = ['claude', 'codex'];
export const GENERATION_ALIASES: Record<HostArg, GeneratedHostId> = {
  claude: 'claude',
  codex: 'codex',
  agents: 'codex',
  gemini: 'codex',
};

export function resolveGenerationTarget(rawArg?: string | null): ResolvedGenerationTarget {
  const normalized = (rawArg ?? 'claude') as HostArg;
  const hostId = GENERATION_ALIASES[normalized];
  if (!hostId) {
    throw new Error(`Unknown host: ${rawArg}. Use claude, codex, gemini, or agents.`);
  }

  const host = HOSTS[hostId];
  const layout = LAYOUTS[host.layoutId];
  return {
    arg: normalized,
    hostId,
    layoutId: host.layoutId,
    host,
    layout,
  };
}

export function parseHostArg(argv: string[]): HostArg {
  const hostArg = argv.find(arg => arg.startsWith('--host'));
  if (!hostArg) return 'claude';

  if (hostArg.includes('=')) {
    return hostArg.split('=')[1] as HostArg;
  }

  return (argv[argv.indexOf(hostArg) + 1] ?? 'claude') as HostArg;
}

export function generatedHostLabel(hostId: GeneratedHostId): string {
  return hostId === 'claude' ? 'Claude' : 'Agents';
}
