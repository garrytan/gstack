import type { TemplateContext } from '../types';

export function generateVendoringDeprecation(ctx: TemplateContext): string {
  return `If \`VENDORED_GSTACK\` is \`yes\`: This project has a vendored copy of gstack at
\`.claude/skills/gstack/\`. Vendoring is deprecated. We will not keep vendored copies
up to date, so this project's gstack will fall behind.

Use AskUserQuestion (one-time per project, check for \`~/.gstack/.vendoring-warned-$SLUG\` marker):

> This project has gstack vendored in \`.claude/skills/gstack/\`. Vendoring is deprecated.
> We won't keep this copy up to date, so you'll fall behind on new features and fixes.
>
> Want to migrate to team mode? It takes about 30 seconds.

Options:
- A) Yes, migrate to team mode now
- B) No, I'll handle it myself

If A:
1. Run \`git rm -r .claude/skills/gstack/\`
2. Run \`echo '.claude/skills/gstack/' >> .gitignore\`
3. Run \`${ctx.paths.binDir}/gstack-team-init required\` (or \`optional\`)
4. Run \`git add .claude/ .gitignore CLAUDE.md && git commit -m "chore: migrate gstack from vendored to team mode"\`
5. Tell the user: "Done. Each developer now runs: \`cd ~/.claude/skills/gstack && ./setup --team\`"

If B: say "OK, you're on your own to keep the vendored copy up to date."

Always run (regardless of choice):
\`\`\`bash
eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
touch ~/.gstack/.vendoring-warned-\${SLUG:-unknown}
\`\`\`

This only happens once per project. If the marker file exists, skip entirely.`;
}

