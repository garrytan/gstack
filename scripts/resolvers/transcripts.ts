/**
 * Transcript resolvers for /context-restore's no-checkpoint fallback
 * (context-restore/sections/transcripts.md.tmpl).
 *
 *   {{TRANSCRIPT_SOURCES}}   → the table of transcript stores for THIS host
 *                              (its `transcripts` row from hosts/<name>.ts, or
 *                              a none row) plus the Capy row (none; the harness
 *                              keeps no transcript on the machine). Only the
 *                              rendering host's paths appear: a Codex render
 *                              never names ~/.claude/.
 *   {{TRANSCRIPT_DISCOVERY}} → the bash block that lists THIS host's transcript
 *                              files for the current workspace only, inside the
 *                              window, and prints `TRANSCRIPTS: none (...)` on
 *                              Capy, on a host with no declared store, or when
 *                              the store is missing.
 *
 * hosts/*.ts declares which hosts have a store (`transcripts.root` and
 * `layout` feed the table); the per-host discovery body lives here, keyed by
 * host name, and a host with no declaration gets the none branch. The prose
 * never hand-writes a path. test/context-restore-transcripts.test.ts checks
 * that the table and the block agree for every host and runs the block
 * against fixture transcripts.
 */
import { getHostConfig } from '../../hosts/index';
import type { TemplateContext } from './types';

export const CAPY_NO_TRANSCRIPTS = 'TRANSCRIPTS: none (Capy keeps no session transcript on this machine; use the shared record and git)';

export function generateTranscriptSources(ctx: TemplateContext): string {
  const host = getHostConfig(ctx.host);
  const row = host.transcripts
    ? `| ${host.displayName} | \`${host.transcripts.root}\` | ${host.transcripts.layout} |`
    : `| ${host.displayName} | none | this host declares no transcript store gstack may read; use the shared record and git |`;
  return [
    '| Host | Transcripts | How this workspace\'s files are told apart |',
    '|---|---|---|',
    row,
    '| Capy (any model) | none | the harness keeps no transcript on the machine; say so and use the shared record and git |',
  ].join('\n');
}

export function generateTranscriptDiscovery(ctx: TemplateContext): string {
  const host = getHostConfig(ctx.host);
  const slugBin = `${ctx.paths.binDir}/gstack-slug`;
  const head = [
    'TRANSCRIPT_DAYS="${TRANSCRIPT_DAYS:-7}"',
    `PROJECT_ROOT=$(${slugBin} --get PROJECT_ROOT 2>/dev/null) || PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)`,
    'echo "TRANSCRIPT_WINDOW: last $TRANSCRIPT_DAYS days"',
    'echo "TRANSCRIPT_PROJECT: $PROJECT_ROOT"',
    'if [ -n "${GSTACK_CAPY:-}" ]; then',
    `  echo "${CAPY_NO_TRANSCRIPTS}"`,
  ];
  let body: string[];
  if (!host.transcripts) {
    body = [
      'else',
      `  echo "TRANSCRIPTS: none (${host.displayName} declares no transcript store gstack may read; use the shared record and git)"`,
      'fi',
    ];
  } else if (ctx.host === 'claude') {
    body = [
      'else',
      '  TRANSCRIPT_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf \'%s\' "$PROJECT_ROOT" | sed \'s/[^A-Za-z0-9]/-/g\')"',
      '  if [ -d "$TRANSCRIPT_DIR" ]; then',
      '    TRANSCRIPT_COUNT=0',
      '    while IFS= read -r f; do TRANSCRIPT_COUNT=$((TRANSCRIPT_COUNT + 1)); echo "TRANSCRIPT: $f"; done < <(find "$TRANSCRIPT_DIR" -maxdepth 1 -name \'*.jsonl\' -mtime -"$TRANSCRIPT_DAYS" 2>/dev/null | sort)',
      '    echo "TRANSCRIPTS: $TRANSCRIPT_DIR ($TRANSCRIPT_COUNT files in the last $TRANSCRIPT_DAYS days)"',
      '  else',
      '    echo "TRANSCRIPTS: none ($TRANSCRIPT_DIR is missing; this workspace has no Claude Code transcripts)"',
      '  fi',
      'fi',
    ];
  } else if (ctx.host === 'codex') {
    body = [
      'else',
      '  TRANSCRIPT_DIR="${CODEX_HOME:-$HOME/.codex}/sessions"',
      '  if [ -d "$TRANSCRIPT_DIR" ]; then',
      '    TRANSCRIPT_COUNT=0',
      '    while IFS= read -r f; do',
      '      head -c 4096 "$f" 2>/dev/null | grep -qF -- "\\"cwd\\":\\"$PROJECT_ROOT\\"" || continue',
      '      TRANSCRIPT_COUNT=$((TRANSCRIPT_COUNT + 1)); echo "TRANSCRIPT: $f"',
      '    done < <(find "$TRANSCRIPT_DIR" -type f -name \'rollout-*.jsonl\' -mtime -"$TRANSCRIPT_DAYS" 2>/dev/null | sort)',
      '    echo "TRANSCRIPTS: $TRANSCRIPT_DIR ($TRANSCRIPT_COUNT files whose cwd is this workspace, in the last $TRANSCRIPT_DAYS days)"',
      '  else',
      '    echo "TRANSCRIPTS: none ($TRANSCRIPT_DIR is missing; this machine has no Codex transcripts)"',
      '  fi',
      'fi',
    ];
  } else {
    throw new Error(`hosts/${ctx.host}.ts declares a transcript store but scripts/resolvers/transcripts.ts has no discovery body for it`);
  }
  return ['```bash', ...head, ...body, '```'].join('\n');
}
