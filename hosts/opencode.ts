import { defineHost, preambleToolGlossary, sharedRuntimeRoot } from './define-host';

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
  runtimeRoot: sharedRuntimeRoot(['qa/templates', 'qa/references']),
});

export default opencode;
