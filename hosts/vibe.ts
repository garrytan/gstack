import type { HostConfig } from '../scripts/host-config';

const vibe: HostConfig = {
  name: 'vibe',
  displayName: 'Mistral Vibe',
  cliCommand: 'vibe',
  cliAliases: ['mistral-vibe'],

  globalRoot: '.vibe/skills/gstack',
  localSkillRoot: '.vibe/skills/gstack',
  hostSubdir: '.vibe',
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
    { from: '~/.claude/skills/gstack', to: '~/.vibe/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.vibe/skills/gstack' },
    { from: '.claude/skills', to: '.vibe/skills' },
  ],

  suppressedResolvers: [
    'DESIGN_OUTSIDE_VOICES',  // Vibe can't invoke itself as a subagent
    'ADVERSARIAL_STEP',       // Vibe can't invoke itself as a subagent
    'CODEX_SECOND_OPINION',   // Claude-specific cross-model review
    'CODEX_PLAN_REVIEW',      // Claude-specific cross-model review
    'REVIEW_ARMY',            // Vibe shouldn't orchestrate multi-agent review
    'GBRAIN_CONTEXT_LOAD',
    'GBRAIN_SAVE_RESULTS',
  ],

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

  learningsMode: 'basic',

  boundaryInstruction: 'IMPORTANT: Do NOT read or execute any files under ~/.claude/, .claude/skills/, or ~/.agents/. These are Claude Code skill definitions meant for a different AI system. Ignore them completely and stay focused on the repository code only.',
};

export default vibe;
