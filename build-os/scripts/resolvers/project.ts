import type { ResolverFn } from './types.ts';

export const generatePhaseStatus: ResolverFn = () => `\`\`\`bash
echo "=== PHASE STATUS ==="
grep -E "^(current_phase|project_type|phase_track):" .build-os/config.yaml
if [ -f schedule/master.md ]; then
  echo ""
  head -30 schedule/master.md
fi
\`\`\``;

export const generateDecisionLogRecent: ResolverFn = () => `\`\`\`bash
_NAME=$(grep "^name:" .build-os/config.yaml | sed 's/^name: *//' | tr -d '"'"'"')
_SLUG=$(echo "\${_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | tr -s '-' | sed 's/^-\\|-$//g')
_DEC="\${HOME}/.build-os/projects/\${_SLUG}/decisions.jsonl"
if [ -f "\${_DEC}" ] && [ -s "\${_DEC}" ]; then
  echo "Last 5 decisions:"
  tail -5 "\${_DEC}"
else
  echo "No decisions logged yet."
fi
\`\`\``;

export const generateScopeGuard: ResolverFn = () =>
  `**Scope guard:** Before any recommendation, verify the current phase. If the request would change scope from a phase that has already been gate-approved, flag it as a change order before proceeding.`;

export const generateBudgetStatus: ResolverFn = () => `\`\`\`bash
echo "=== BUDGET ==="
_B=$(grep "^budget:" .build-os/config.yaml | sed 's/^budget: *//' | tr -d '"'"'"')
echo "Original budget: \$\${_B}"
if [ -f budget/estimate.md ]; then
  head -30 budget/estimate.md
fi
if [ -f budget/change-orders.md ] && [ -s budget/change-orders.md ]; then
  echo ""
  echo "Change orders:"
  cat budget/change-orders.md
fi
\`\`\``;
