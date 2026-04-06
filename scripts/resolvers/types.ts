export type Host = 'claude' | 'codex' | 'factory';

export interface HostPaths {
  skillRoot: string;
  localSkillRoot: string;
  binDir: string;
}

export const HOST_PATHS: Record<Host, HostPaths> = {
  claude: {
    skillRoot: '~/.claude/skills/research-stack',
    localSkillRoot: '.claude/skills/research-stack',
    binDir: '~/.claude/skills/research-stack/bin',
  },
  codex: {
    skillRoot: '$RSTACK_ROOT',
    localSkillRoot: '.agents/skills/research-stack',
    binDir: '$RSTACK_BIN',
  },
  factory: {
    skillRoot: '$RSTACK_ROOT',
    localSkillRoot: '.factory/skills/research-stack',
    binDir: '$RSTACK_BIN',
  },
};

export interface TemplateContext {
  skillName: string;
  tmplPath: string;
  benefitsFrom?: string[];
  host: Host;
  paths: HostPaths;
  preambleTier?: number;
}

/** Resolver function signature. args is populated for parameterized placeholders like {{INVOKE_SKILL:name}}. */
export type ResolverFn = (ctx: TemplateContext, args?: string[]) => string;
