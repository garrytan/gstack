import { type TemplateContext } from './types';
import { binaryAssignment } from './runtime-root';

/**
 * {{MAKE_PDF_SETUP}} — emits the readiness check that resolves $P to the
 * make-pdf binary (make-pdf/dist/pdf). Mirrors generateDesignSetup: the
 * assignment comes from binaryAssignment(ctx, 'make-pdf'), the same resolver
 * the runtime prelude puts into every later block that uses $P on env-var
 * hosts, so readiness and use always name the same binary.
 *
 * Resolution order: MAKE_PDF_BIN (contributor dev builds), then the
 * repo-local install, then the global install (env-var hosts: $GSTACK_ROOT,
 * which the prelude resolves repo-local first).
 */
export function generateMakePdfSetup(ctx: TemplateContext): string {
  return `## MAKE-PDF SETUP (run this check BEFORE any make-pdf command)

\`\`\`bash
${binaryAssignment(ctx, 'make-pdf')}
if [ -x "$P" ]; then
  echo "MAKE_PDF_READY: $P"
  alias _p_="$P"   # shellcheck alias helper (not exported)
  export P   # env-var hosts re-derive $P in every later block (runtime prelude)
else
  echo "MAKE_PDF_NOT_AVAILABLE (run './setup' in the gstack repo to build it)"
fi
\`\`\`

If \`MAKE_PDF_NOT_AVAILABLE\` is printed: tell the user the binary is not
built. Have them run \`./setup\` from the gstack repo, then retry.

If \`MAKE_PDF_READY\` is printed: \`$P\` is the binary path for the rest of
the skill. Use \`$P\` (not an explicit path) so the skill body stays portable.

Core commands:
- \`"$P" generate <input.md> [output.pdf]\` — render markdown to PDF (80% use case)
- \`"$P" generate --cover --toc essay.md out.pdf\` — full publication layout
- \`"$P" generate --watermark DRAFT memo.md draft.pdf\` — diagonal DRAFT watermark
- \`"$P" preview <input.md>\` — render HTML and open in browser (fast iteration)
- \`"$P" setup\` — verify the browser (Aside, or gstack's own headless fallback) + pdftotext and run a smoke test
- \`"$P" --help\` — full flag reference

Output contract:
- \`stdout\`: ONLY the output path on success. One line.
- \`stderr\`: progress (\`Rendering HTML... Generating PDF...\`) unless \`--quiet\`.
- Exit 0 success / 1 bad args / 2 render error / 3 TOC page numbers failed / 4 no browser available (open the Aside app, or run \`./setup\` to build gstack's own browser).

PDFs print through Aside when it is running and through gstack's own headless browser otherwise; the stderr progress line says which (\`Rendering PDF through Aside\` / \`through gstack's browser\`).`;
}
