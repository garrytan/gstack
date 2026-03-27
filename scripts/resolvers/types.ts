export type Host = 'claude' | 'codex' | 'gemini';

export interface HostPaths {
  skillRoot: string;
  localSkillRoot: string;
  binDir: string;
  browseDir: string;
  configFile: string;
}

export const HOST_PATHS: Record<Host, HostPaths> = {
  claude: {
    skillRoot: '~/.claude/skills/gstack',
    localSkillRoot: '.claude/skills/gstack',
    binDir: '~/.claude/skills/gstack/bin',
    browseDir: '~/.claude/skills/gstack/browse/dist',
    configFile: 'CLAUDE.md',
  },
  codex: {
    skillRoot: '$GSTACK_ROOT',
    localSkillRoot: '.agents/skills/gstack',
    binDir: '$GSTACK_BIN',
    browseDir: '$GSTACK_BROWSE',
    configFile: 'CLAUDE.md',
  },
  gemini: {
    skillRoot: '$GSTACK_ROOT',
    localSkillRoot: '.agents/skills/gstack',
    binDir: '$GSTACK_BIN',
    browseDir: '$GSTACK_BROWSE',
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
