export type Host = 'claude' | 'codex' | 'factory' | 'gemini';

export interface HostPaths {
  skillRoot: string;
  localSkillRoot: string;
  binDir: string;
  browseDir: string;
  designDir: string;
  configFile: string;
}

export const HOST_PATHS: Record<Host, HostPaths> = {
  claude: {
    skillRoot: '~/.claude/skills/gstack',
    localSkillRoot: '.claude/skills/gstack',
    binDir: '~/.claude/skills/gstack/bin',
    browseDir: '~/.claude/skills/gstack/browse/dist',
    designDir: '~/.claude/skills/gstack/design/dist',
    configFile: 'CLAUDE.md',
  },
  codex: {
    skillRoot: '$GSTACK_ROOT',
    localSkillRoot: '.agents/skills/gstack',
    binDir: '$GSTACK_BIN',
    browseDir: '$GSTACK_BROWSE',
    designDir: '$GSTACK_DESIGN',
    configFile: 'CLAUDE.md',
  },
  factory: {
    skillRoot: '$GSTACK_ROOT',
    localSkillRoot: '.factory/skills/gstack',
    binDir: '$GSTACK_BIN',
    browseDir: '$GSTACK_BROWSE',
    designDir: '$GSTACK_DESIGN',
    configFile: 'CLAUDE.md',
  },
  gemini: {
    skillRoot: '$GSTACK_ROOT',
    localSkillRoot: '.agents/skills/gstack',
    binDir: '$GSTACK_BIN',
    browseDir: '$GSTACK_BROWSE',
    designDir: '$GSTACK_DESIGN',
    configFile: 'GEMINI.md',
  },
};

export interface TemplateContext {
  skillName: string;
  tmplPath: string;
  benefitsFrom?: string[];
  host: Host;
  paths: HostPaths;
  preambleTier?: number;  // 1-4, controls which preamble sections are included
}

/** Resolver function signature. args is populated for parameterized placeholders like {{INVOKE_SKILL:name}}. */
export type ResolverFn = (ctx: TemplateContext, args?: string[]) => string;
