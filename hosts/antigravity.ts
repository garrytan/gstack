import type { HostConfig } from '../scripts/host-config';

const antigravity: HostConfig = {
  name: 'antigravity',
  displayName: 'Antigravity',
  cliCommand: 'antigravity',
  cliAliases: [],

  globalRoot: '.gemini/antigravity/skills/gstack',
  localSkillRoot: '.gemini/antigravity/skills/gstack',
  hostSubdir: '.gemini/antigravity',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
  },

  pathRewrites: [
    { from: '~/.claude/skills/gstack', to: '~/.gemini/antigravity/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.gemini/antigravity/skills/gstack' },
    { from: '.claude/skills', to: '.gemini/antigravity/skills' },
  ],

  suppressedResolvers: ['GBRAIN_CONTEXT_LOAD', 'GBRAIN_SAVE_RESULTS'],

  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: {
      'review': ['checklist.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: Antigravity AI Agent <antigravity@gemini.google>',
  learningsMode: 'basic',
};

export default antigravity;
