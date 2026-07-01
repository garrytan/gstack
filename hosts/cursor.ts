import type { HostConfig } from '../scripts/host-config';

const cursor: HostConfig = {
  name: 'cursor',
  displayName: 'Cursor',
  cliCommand: 'agent',
  cliAliases: ['cursor'],

  // Keep runtime assets outside Cursor's recursively scanned skills directory.
  // Generated skills live under .cursor/skills/gstack-*.
  globalRoot: '.cursor/gstack',
  localSkillRoot: '.cursor/gstack',
  hostSubdir: '.cursor',
  usesEnvVars: true,

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
    conditionalFields: [
      { if: { sensitive: true }, add: { 'disable-model-invocation': true } },
    ],
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['codex'],
    frontmatterNameMatchesDirectory: true,
    namespaceSkillInvocations: true,
  },

  pathRewrites: [
    { from: '${HOME}/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '$HOME/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '~/.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/gstack', to: '$GSTACK_ROOT' },
    { from: '.claude/skills/review', to: '$GSTACK_ROOT/review' },
    { from: '.claude/skills', to: '.cursor/skills' },
    { from: '${CLAUDE_SKILL_DIR}/../', to: '$GSTACK_ROOT/' },
    { from: 'qa/templates/', to: '$GSTACK_ROOT/qa/templates/' },
    { from: 'qa/references/', to: '$GSTACK_ROOT/qa/references/' },
    { from: '`review/TODOS-format.md`', to: '`$GSTACK_ROOT/review/TODOS-format.md`' },
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  toolRewrites: {
    'use the Bash tool': 'run this command with the shell tool',
    'use the Write tool': 'create the file with the file editing tools',
    'use the Read tool': 'read the file with the file reading tools',
    'use the Edit tool': 'update the file with the file editing tools',
    'use the Agent tool': 'delegate to a subagent',
    'use the Grep tool': 'search the workspace',
    'use the Glob tool': 'find matching files',
    'the Bash tool': 'the shell tool',
    'the Agent tool': 'a subagent',
  },

  suppressedResolvers: ['GBRAIN_CONTEXT_LOAD', 'GBRAIN_SAVE_RESULTS'],

  runtimeRoot: {
    globalSymlinks: [
      'bin', 'browse/dist', 'browse/bin', 'design/dist',
      'make-pdf/dist', 'lib/diagram-render/dist',
      'design-html/vendor', 'extension',
      'ios-qa/templates', 'ios-qa/scripts',
      'ETHOS.md', 'review/specialists', 'qa/templates', 'qa/references',
      'plan-devex-review/dx-hall-of-fame.md',
      'scripts/jargon-list.json', 'lib/redact-audit-log.ts', 'lib/redact-patterns.ts',
    ],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },

  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },

  coAuthorTrailer: 'Co-Authored-By: Cursor Agent <cursoragent@cursor.com>',
  learningsMode: 'basic',
};

export default cursor;
