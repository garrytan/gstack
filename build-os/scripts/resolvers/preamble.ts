import type { ResolverFn } from './types.ts';

// Bash block that loads config + recent decisions (T1+, always included)
function configLoad(): string {
  return `## Project Context

Run this to load the current project state:

\`\`\`bash
if [ ! -f .build-os/config.yaml ]; then
  echo "ERROR: Not in a build-os project. cd into a project folder or run /kickoff first."
  exit 1
fi

echo "=== PROJECT CONFIG ==="
cat .build-os/config.yaml
echo ""

# Slug for global state access
_NAME=$(grep "^name:" .build-os/config.yaml | sed 's/^name: *//' | tr -d '"'"'"')
_SLUG=$(echo "\${_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | tr -s '-' | sed 's/^-\\|-$//g')

echo "=== RECENT DECISIONS ==="
_DEC="\${HOME}/.build-os/projects/\${_SLUG}/decisions.jsonl"
if [ -f "\${_DEC}" ] && [ -s "\${_DEC}" ]; then
  echo "($(wc -l < "\${_DEC}" | xargs) total, showing last 3)"
  tail -3 "\${_DEC}"
else
  echo "No decisions logged yet."
fi
\`\`\`

Use the project state above throughout this session. Do not ask the owner for information already in the config.`;
}

// Budget overview (T2+)
function budgetStatus(): string {
  return `\`\`\`bash
echo "=== BUDGET STATUS ==="
if [ -f budget/estimate.md ]; then
  head -35 budget/estimate.md
else
  _B=$(grep "^budget:" .build-os/config.yaml | sed 's/^budget: *//' | tr -d '"'"'"')
  echo "Original budget: \$\${_B} — no estimate file yet (run /cost-check to initialize)"
fi
\`\`\``;
}

// Design brief + learnings (T3+)
function designBriefAndLearnings(): string {
  return `\`\`\`bash
echo "=== DESIGN BRIEF ==="
if [ -f design/brief.md ]; then
  head -50 design/brief.md
else
  echo "No design brief yet (run /arch-review to create one)"
fi

_NAME=$(grep "^name:" .build-os/config.yaml | sed 's/^name: *//' | tr -d '"'"'"')
_SLUG=$(echo "\${_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | tr -s '-' | sed 's/^-\\|-$//g')
_LEARN="\${HOME}/.build-os/projects/\${_SLUG}/learnings.jsonl"
if [ -f "\${_LEARN}" ] && [ -s "\${_LEARN}" ]; then
  echo ""
  echo "=== LEARNINGS FROM PREVIOUS PROJECTS ==="
  cat "\${_LEARN}"
fi
\`\`\``;
}

// Team briefing prose (T3+)
function teamBriefing(): string {
  return `## Your Construction Team

You are operating with four specialist voices. Always attribute each perspective to its role:

- **Senior Architect** — design quality, code compliance (IBC/IRC + local amendments), buildability, RFI interpretation, construction administration. Cares about: Is this the right design? Will it actually get built? Is it code-compliant?
- **Cost Estimator** — budget accuracy, bid analysis, value engineering, change order implications, actual vs. estimate tracking. Cares about: What does this cost? Where are we burning contingency?
- **Project Manager** — schedule, contractor accountability, risk, open items, critical path. Cares about: Are we on track? What will slip? Who owns this action?
- **Marketing Team** — project story, portfolio documentation, social content, brand. Cares about: How does this project build the business?

Give each active role an independent read. Do not blend them into consensus — the value is the tension between perspectives. For most skills, Architect and Estimator are primary. PM activates during construction. Marketing activates at Concept and Closeout.`;
}

// Daily context from session-start hook + scope guard (T4)
function dailyContextAndScopeGuard(): string {
  return `\`\`\`bash
if [ -f .build-os/daily-context.md ]; then
  echo "=== TODAY ==="
  cat .build-os/daily-context.md
fi
\`\`\`

**Scope guard:** Before responding to any request, check the current phase in config. If the request would change scope from a phase that has already passed its gate (e.g., adding a room after Construction Docs are locked), flag it prominently before proceeding. Scope changes to locked phases must go through \`/decide\` as a change order.`;
}

export const generatePreamble: ResolverFn = (ctx) => {
  const tier = ctx.preambleTier;
  const sections: string[] = [];

  sections.push(configLoad());

  if (tier >= 2) sections.push(budgetStatus());
  if (tier >= 3) {
    sections.push(designBriefAndLearnings());
    sections.push(teamBriefing());
  }
  if (tier >= 4) sections.push(dailyContextAndScopeGuard());

  return sections.join('\n\n');
};
