import { defineHost } from './define-host';

const opencode = defineHost({
  name: 'opencode',
  displayName: 'OpenCode',

  globalRoot: '.config/opencode/skills/gstack',  // XDG config dir, not ~/.opencode

  // OpenCode links a wider runtime asset set than the shared default
  // (design binary, review specialists, qa templates/references, DX hall of fame).
  runtimeRoot: {
    globalSymlinks: ['bin', 'browse/dist', 'browse/bin', 'design/dist', 'gstack-upgrade', 'ETHOS.md', 'review/specialists', 'qa/templates', 'qa/references', 'plan-devex-review/dx-hall-of-fame.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },
});

export default opencode;
