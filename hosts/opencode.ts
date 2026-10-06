import { defineHost, preambleToolGlossary } from './define-host';

const opencode = defineHost({
  name: 'opencode',
  displayName: 'OpenCode',
  tier: 'experimental',
  capabilities: { toolExecution: true, questions: 'native', planMode: true, delegation: true, browser: true, safetyHooks: 'advisory' },

  globalRoot: '.config/opencode/skills/gstack',  // XDG config dir, not ~/.opencode

  // #2626: the shared prose names Claude's question tool.
  toolRewrites: preambleToolGlossary('**OpenCode tool names:** `AskUserQuestion` means your `question` tool; there is no `mcp__*__AskUserQuestion` variant. If a step says to call `ExitPlanMode`, tell the user the plan is ready and wait instead.'),

  // OpenCode links a wider runtime asset set than the shared default
  // (design binary, review specialists, qa templates/references, DX hall of fame).
  runtimeRoot: {
    globalSymlinks: ['bin', 'lib', 'browse/dist', 'browse/bin', 'design/dist', 'make-pdf/dist', 'freeze/bin', 'careful/bin', 'gstack-upgrade', 'ETHOS.md', 'review/specialists', 'qa/templates', 'qa/references', 'plan-devex-review/dx-hall-of-fame.md'],
    globalFiles: {
      'review': ['checklist.md', 'design-checklist.md', 'greptile-triage.md', 'TODOS-format.md'],
    },
  },
});

export default opencode;
