import type { HostConfig } from '../scripts/host-config';

const pi: HostConfig = {
  name: 'pi',
  displayName: 'Pi Agent',
  cliCommand: 'pi',
  cliAliases: [],
  globalRoot: '.pi/agent/skills/gstack',
  localSkillRoot: '.pi/agent/skills/gstack',
  hostSubdir: '.pi',
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
    { from: '~/.claude/skills/gstack', to: '~/.pi/agent/skills/gstack' },
    { from: '.claude/skills/gstack', to: '.pi/agent/skills/gstack' },
    { from: '.claude/skills/review', to: '.pi/agent/skills/gstack/review' },
    { from: '.claude/skills', to: '.pi/agent/skills' },
  ],
  // Define runtime root and install strategy based on Pi's structure
  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'gstack-upgrade', 'ETHOS.md'],
    globalFiles: { 'review': ['checklist.md', 'TODOS-format.md'] },
  },
  install: {
    prefixable: false,
    linkingStrategy: 'symlink-generated',
  },
  learningsMode: 'basic',
};

export default pi;