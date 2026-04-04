export type Host = 'antigravity' | 'antigravity' | 'factory' | 'antigravity';

export interface HostPaths {
  skillRoot: string;
  localSkillRoot: string;
  binDir: string;
  browseDir: string;
  designDir: string;
}

export const HOST_PATHS: Record<Host, HostPaths> = {
  antigravity: {
    skillRoot: '~/.antigravity/skills/gstack',
    localSkillRoot: '.antigravity/skills/gstack',
    binDir: '~/.antigravity/skills/gstack/bin',
    browseDir: '~/.antigravity/skills/gstack/browse/dist',
    designDir: '~/.antigravity/skills/gstack/design/dist',
  },
  antigravity: {
    skillRoot: '$GSTACK_ROOT',
    localSkillRoot: '.agents/skills/gstack',
    binDir: '$GSTACK_BIN',
    browseDir: '$GSTACK_BROWSE',
    designDir: '$GSTACK_DESIGN',
  },
  factory: {
    skillRoot: '$GSTACK_ROOT',
    localSkillRoot: '.factory/skills/gstack',
    binDir: '$GSTACK_BIN',
    browseDir: '$GSTACK_BROWSE',
    designDir: '$GSTACK_DESIGN',
  },
  antigravity: {
    skillRoot: '~/.gemini/antigravity/skills',
    localSkillRoot: '.gemini/antigravity/skills',
    binDir: '~/.gemini/antigravity/skills/bin',
    browseDir: '~/.gemini/antigravity/skills/browse/dist',
    designDir: '~/.gemini/antigravity/skills/design/dist',
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
