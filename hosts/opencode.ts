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

  // Generated skill prose is shared with Claude, but OpenCode exposes
  // different native interaction tools. Keep the host-specific vocabulary
  // in the host config so generated docs remain correct for each runtime.
  toolRewrites: {
    AskUserQuestion: 'question',
    ExitPlanMode: 'end plan mode',
  },
});

export default opencode;
