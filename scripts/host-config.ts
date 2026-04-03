/**
 * Declarative host config system.
 *
 * Each supported host (Claude, Codex, Factory, OpenCode, OpenClaw, etc.) is
 * defined as a typed HostConfig object in hosts/*.ts. This module provides
 * the interface, loader, and validator.
 *
 * Architecture:
 *   hosts/*.ts  →  hosts/index.ts  →  host-config.ts (this file)
 *        │                                    │
 *        └── typed configs ──────────────────→ consumed by gen-skill-docs.ts,
 *                                              setup (via host-config-export.ts),
 *                                              skill-check.ts, worktree.ts,
 *                                              platform-detect, uninstall
 */

export interface HostConfig {
  /** Unique host identifier (e.g., 'opencode'). Must match filename in hosts/. */
  name: string;
  /** Human-readable name for UI/logs (e.g., 'OpenCode'). */
  displayName: string;
  /** Binary name for `command -v` detection (e.g., 'opencode'). */
  cliCommand: string;
  /** Alternative binary names (e.g., ['droid'] for factory). */
  cliAliases?: string[];

  // --- Path Configuration ---
  /** Global install path relative to $HOME (e.g., '.config/opencode/skills/gstack'). */
  globalRoot: string;
  /** Project-local skill path relative to repo root (e.g., '.opencode/skills/gstack'). */
  localSkillRoot: string;
  /** Gitignored directory under repo root for generated docs (e.g., '.opencode'). */
  hostSubdir: string;
  /** Whether preamble generates $GSTACK_ROOT env vars (true for non-Claude hosts). */
  usesEnvVars: boolean;

  // --- Frontmatter Transformation ---
  frontmatter: {
    /** 'allowlist': ONLY keepFields survive. 'denylist': strip listed fields. */
    mode: 'allowlist' | 'denylist';
    /** Fields to preserve (allowlist mode only). */
    keepFields?: string[];
    /** Fields to remove (denylist mode only). */
    stripFields?: string[];
    /** Max chars for description field. null = no limit. */
    descriptionLimit?: number | null;
    /** What to do when description exceeds limit. Default: 'error'. */
    descriptionLimitBehavior?: 'error' | 'truncate' | 'warn';
    /** Additional frontmatter fields to inject (host-wide). */
    extraFields?: Record<string, unknown>;
    /** Rename fields from template (e.g., { 'voice-triggers': 'triggers' }). */
    renameFields?: Record<string, string>;
    /** Conditionally add fields based on template frontmatter values. */
    conditionalFields?: Array<{ if: Record<string, unknown>; add: Record<string, unknown> }>;
  };

  // --- Generation ---
  generation: {
    /** Whether to create sidecar metadata file (e.g., openai.yaml for Codex). */
    generateMetadata: boolean;
    /** Metadata file format (e.g., 'openai.yaml'). */
    metadataFormat?: string | null;
    /** Skill directories to exclude from generation for this host. */
    skipSkills?: string[];
  };

  // --- Content Rewrites ---
  /** Literal string replacements on generated SKILL.md content. Order matters, replaceAll. */
  pathRewrites: Array<{ from: string; to: string }>;
  /** Tool name string replacements on content. */
  toolRewrites?: Record<string, string>;
  /** Resolver functions that return empty string for this host. */
  suppressedResolvers?: string[];

  // --- Runtime Root ---
  runtimeRoot: {
    /** Explicit asset list for global install symlinks (no globs). */
    globalSymlinks: string[];
    /** Dir → explicit file list for selective file linking. */
    globalFiles?: Record<string, string[]>;
  };
  /** Optional repo-local sidecar config (e.g., Codex uses .agents/skills/gstack). */
  sidecar?: {
    /** Sidecar path relative to repo root (e.g., '.agents/skills/gstack'). */
    path: string;
    /** Assets to symlink into sidecar (different set than global). */
    symlinks: string[];
  };

  // --- Install Behavior ---
  install: {
    /** Whether gstack-config skill_prefix applies (Claude only). */
    prefixable: boolean;
    /** How skills are linked into the host dir. */
    linkingStrategy: 'real-dir-symlink' | 'symlink-generated';
  };

  // --- Host-Specific Behavioral Config ---
  /** Git co-author trailer string. */
  coAuthorTrailer?: string;
  /** Learnings implementation: 'full' = cross-project, 'basic' = simple. */
  learningsMode?: 'full' | 'basic';
  /** Anti-prompt-injection boundary instruction for cross-model invocations. */
  boundaryInstruction?: string;

  /** Static files to copy alongside generated skills (e.g., { 'SOUL.md': 'openclaw/SOUL.md' }). */
  staticFiles?: Record<string, string>;
  /** Optional path to host-adapter module for complex transformations. */
  adapter?: string;
}

// --- Validation ---

const NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const PATH_REGEX = /^[a-zA-Z0-9_.\/${}~-]+$/;
const CLI_REGEX = /^[a-z][a-z0-9_-]*$/;

export function validateHostConfig(config: HostConfig): string[] {
  const errors: string[] = [];

  if (!NAME_REGEX.test(config.name)) {
    errors.push(`name '${config.name}' must be lowercase alphanumeric with hyphens`);
  }
  if (!config.displayName) {
    errors.push('displayName is required');
  }
  if (!CLI_REGEX.test(config.cliCommand)) {
    errors.push(`cliCommand '${config.cliCommand}' contains invalid characters`);
  }
  if (config.cliAliases) {
    for (const alias of config.cliAliases) {
      if (!CLI_REGEX.test(alias)) {
        errors.push(`cliAlias '${alias}' contains invalid characters`);
      }
    }
  }
  if (!PATH_REGEX.test(config.globalRoot)) {
    errors.push(`globalRoot '${config.globalRoot}' contains invalid characters`);
  }
  if (!PATH_REGEX.test(config.localSkillRoot)) {
    errors.push(`localSkillRoot '${config.localSkillRoot}' contains invalid characters`);
  }
  if (!PATH_REGEX.test(config.hostSubdir)) {
    errors.push(`hostSubdir '${config.hostSubdir}' contains invalid characters`);
  }
  if (!['allowlist', 'denylist'].includes(config.frontmatter.mode)) {
    errors.push(`frontmatter.mode must be 'allowlist' or 'denylist'`);
  }
  if (!['real-dir-symlink', 'symlink-generated'].includes(config.install.linkingStrategy)) {
    errors.push(`install.linkingStrategy must be 'real-dir-symlink' or 'symlink-generated'`);
  }

  return errors;
}

export function validateAllConfigs(configs: HostConfig[]): string[] {
  const errors: string[] = [];

  // Per-config validation
  for (const config of configs) {
    const configErrors = validateHostConfig(config);
    errors.push(...configErrors.map(e => `[${config.name}] ${e}`));
  }

  // Cross-config uniqueness checks
  const hostSubdirs = new Map<string, string>();
  const globalRoots = new Map<string, string>();
  const names = new Map<string, string>();

  for (const config of configs) {
    if (names.has(config.name)) {
      errors.push(`Duplicate name '${config.name}' (also used by ${names.get(config.name)})`);
    }
    names.set(config.name, config.name);

    if (hostSubdirs.has(config.hostSubdir)) {
      errors.push(`Duplicate hostSubdir '${config.hostSubdir}' (${config.name} and ${hostSubdirs.get(config.hostSubdir)})`);
    }
    hostSubdirs.set(config.hostSubdir, config.name);

    if (globalRoots.has(config.globalRoot)) {
      errors.push(`Duplicate globalRoot '${config.globalRoot}' (${config.name} and ${globalRoots.get(config.globalRoot)})`);
    }
    globalRoots.set(config.globalRoot, config.name);
  }

  return errors;
}
