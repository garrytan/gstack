import type { TemplateContext } from './types';

/**
 * {{MAKE_PDF_SETUP}} — emits the shell preamble that resolves $P to the
 * make-pdf binary. Mirrors generateBrowseSetup / generateDesignSetup.
 *
 * $P = make-pdf/dist/pdf.
 *
 * Resolution order (matches src/browseClient.ts::resolveBrowseBin):
 *   1. Local skill root: $_ROOT/{localSkillRoot}/make-pdf/dist/pdf
 *   2. Global: ~/{globalRoot}/make-pdf/dist/pdf
 *   3. Env override (MAKE_PDF_BIN) — for contributor dev builds
 */
export function generateMakePdfSetup(ctx: TemplateContext): string {
  return `## MAKE-PDF SETUP (run this check BEFORE any make-pdf command)

\`\`\`bash
_ROOT=\$(git rev-parse --show-toplevel 2>/dev/null)
P=""
if [ -n "\$MAKE_PDF_BIN" ] && [ -x "\$MAKE_PDF_BIN" ]; then
  P="\$MAKE_PDF_BIN"
elif [ -n "\$_ROOT" ] && [ -x "\$_ROOT/${ctx.paths.localSkillRoot}/make-pdf/dist/pdf.exe" ]; then
  P="\$_ROOT/${ctx.paths.localSkillRoot}/make-pdf/dist/pdf.exe"
elif [ -n "\$_ROOT" ] && [ -x "\$_ROOT/${ctx.paths.localSkillRoot}/make-pdf/dist/pdf" ]; then
  P="\$_ROOT/${ctx.paths.localSkillRoot}/make-pdf/dist/pdf"
elif [ -x "\$HOME${ctx.paths.makePdfDir.replace(/^~/, '')}/pdf.exe" ]; then
  P="\$HOME${ctx.paths.makePdfDir.replace(/^~/, '')}/pdf.exe"
elif [ -x "\$HOME${ctx.paths.makePdfDir.replace(/^~/, '')}/pdf" ]; then
  P="\$HOME${ctx.paths.makePdfDir.replace(/^~/, '')}/pdf"
fi
P_OK=0
if [ -n "\$P" ] && [ -x "\$P" ]; then
  if "\$P" --help >/dev/null 2>&1; then
    P_OK=1
  else
    if command -v bun >/dev/null 2>&1 && [ -f "\$_ROOT/${ctx.paths.localSkillRoot}/make-pdf/src/cli.ts" ]; then
      P="bun run \$_ROOT/${ctx.paths.localSkillRoot}/make-pdf/src/cli.ts"
      P_OK=1
    elif command -v bun >/dev/null 2>&1 && [ -f "\$HOME${ctx.paths.makePdfDir.replace(/^~/, '').replace(/\/dist$/, '/src')}/cli.ts" ]; then
      P="bun run \$HOME${ctx.paths.makePdfDir.replace(/^~/, '').replace(/\/dist$/, '/src')}/cli.ts"
      P_OK=1
    fi
  fi
fi
if [ "\$P_OK" -eq 1 ]; then
  echo "MAKE_PDF_READY: \$P"
  alias _p_="\$P"   # shellcheck alias helper (not exported)
  export P   # available as $P in subsequent blocks within the same skill invocation
else
  echo "MAKE_PDF_NOT_AVAILABLE (run './setup' in the gstack repo to build it)"
fi
\`\`\`

If \`MAKE_PDF_NOT_AVAILABLE\` is printed: tell the user the binary is not
built. Have them run \`./setup\` from the gstack repo, then retry.

If \`MAKE_PDF_READY\` is printed: \`$P\` is the binary path for the rest of
the skill. Use \`$P\` (not an explicit path) so the skill body stays portable.

Core commands:
- \`$P generate <input.md> [output.pdf]\` — render markdown to PDF (80% use case)
- \`$P generate --cover --toc essay.md out.pdf\` — full publication layout
- \`$P generate --watermark DRAFT memo.md draft.pdf\` — diagonal DRAFT watermark
- \`$P preview <input.md>\` — render HTML and open in browser (fast iteration)
- \`$P setup\` — verify browse + Chromium + pdftotext and run a smoke test
- \`$P --help\` — full flag reference

Output contract:
- \`stdout\`: ONLY the output path on success. One line.
- \`stderr\`: progress (\`Rendering HTML... Generating PDF...\`) unless \`--quiet\`.
- Exit 0 success / 1 bad args / 2 render error / 3 Paged.js timeout / 4 browse unavailable.`;
}
