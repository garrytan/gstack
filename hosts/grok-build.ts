import type { HostConfig } from '../scripts/host-config';

const grokBuild: HostConfig = {
  name: 'grok-build',
  displayName: 'Grok Build',
  cliCommand: 'grok',
  cliAliases: ['grok-build'],

  globalRoot: '.grok/skills/gstack',
  localSkillRoot: '.grok/skills/gstack',
  hostSubdir: '.grok',

  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description', 'triggers'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.grok/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.grok/skills/gstack' },
    { from: '.claude/skills', to: '.grok/skills' },
    { from: '~/.claude/skills', to: '~/.grok/skills' },
  ],

  toolRewrites: [
    { from: 'browser tool', to: 'subagent browser tool' },
    { from: 'Playwright', to: 'Grok subagent browser' },
  ],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'gstack-upgrade'],
    globalFiles: {},
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  learningsMode: 'basic',
};

export default grokBuild;