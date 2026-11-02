import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { EvalTestEntry } from './eval-store';
import { buildCookieWorkflowJudgeInput } from './cookie-workflow-judge-input';
import { COOKIE_MANUAL_REVIEW_FILE } from './cookie-workflow-manual-review';

// Later documentation added to the judged BROWSER.md section after the approval
// was recorded (v1.91.4.0 Windows Opera wave). Reversing it reconstructs the
// exact historical prompt bytes, including the section's line range.
const LATER_BROWSER_BLOCK = /\*\*Windows: Opera and Opera GX\.\*\*[\s\S]*?appear in CLI output\.\n\n/;
const LATER_BROWSER_EDITS: Array<[string, string]> = [
  ['The picker recognizes Chrome, Chromium, Brave, Edge, Windows-only Opera and Opera GX, and macOS-only Comet and Arc.', 'The picker recognizes Chrome, Chromium, Brave, Edge, and macOS-only Comet, Arc, and Dia.'],
  [' Opera and Opera GX are Windows-only and read from `%APPDATA%\\Opera Software\\Opera Stable` or `Opera GX Stable`, in `Default` or `Profile N` directories; legacy root-level layouts, Opera side profiles and portable or relocated installs are not detected. Opera has no native extraction, so its App-Bound cookies (if any) need manual sign-in.', ''],
];

// The judged SKILL.md excerpt follows the generated preamble, so later preamble
// edits move its line range without changing its bytes. The approved request
// named lines from 153; the parallel-waves one-line skill start (#2763) removed
// three preamble lines. A raw SKILL.md gets those lines back, and a built prompt,
// which has no preamble, gets the approved start line.
const APPROVED_ENTRYPOINT_START = 153;
const LATER_PREAMBLE_EDITS: Array<[string, string]> = [
  ['~/.claude/skills/gstack/bin/gstack-skill-start --skill "setup-browser-cookies" --model "claude"\n', '_SS="$HOME/.claude/skills/gstack/bin/gstack-skill-start"\n[ -x "$_SS" ] || _SS=".claude/skills/gstack/bin/gstack-skill-start"\n"$_SS" --skill "setup-browser-cookies" --model "claude" --parent-pid "$PPID" \\\n  || echo "SKILL_START: unavailable — stale install; run ./setup or /gstack-upgrade (preamble degraded, continue the user\'s task)"\n'],
];

// The v1.91.19.0 generated-bash lint (INV-3) gave the shared Bun-install block a
// ${TMPDIR:-/tmp} mktemp template; same line, different bytes.
// The v1.91.30.0 Bun floor (E1) pinned the install hint to the tested Bun.
const LATER_WAVE_EDITS: Array<[string, string]> = [
  ['tmpfile=$(mktemp "${TMPDIR:-/tmp}/bun-install.XXXXXX")', 'tmpfile=$(mktemp)'],
  ['BUN_VERSION="1.4.2"', 'BUN_VERSION="1.3.10"'],
  // Oct 7 wave: the artifacts-sync preamble block surfaces attention lines (one line longer).
  ["Skill-start already ran artifacts sync. GBrain hint text (if any) says\nwhen to prefer `gbrain` over Grep. `ARTIFACTS_SYNC:` reports sync health\n(`off`, `mode=... | queue=N`, `remote-mode`, or a `gstack-brain-restore`\nhint). On an `attention:` line, tell the user in one sentence what\nit says and the command it names, then continue.\n\nThe one-time privacy stop-gate arrives as a `GSTACK_INSTRUCTION` block\nfrom skill-start when consent is pending; fire it via AskUserQuestion\nexactly as instructed.",
    "The skill-start output above already ran artifacts sync. Act on its lines:\nGBrain hint text (if present) tells you when to prefer `gbrain` over Grep;\n`ARTIFACTS_SYNC:` reports sync health (`off`, `mode=... | queue=N`,\n`remote-mode`, or a restore hint naming `gstack-brain-restore`).\n\nThe one-time privacy stop-gate (artifacts-sync consent) arrives as a\n`GSTACK_INSTRUCTION` block from skill-start when consent is actually pending\n\u2014 fire it via AskUserQuestion exactly as the block instructs."],
  // Oct 8 wave: the tier-1 voice directive gained the reply-language rule (two lines longer).
  ["Reply in the language of the user's latest message unless asked otherwise. Code, commands, paths, identifiers and quoted output stay verbatim.\n\n", ''],
  // Dia removal (GSTA-143) dropped its platform sentence; same line count.
  ["\nKeychain approval is the user's choice.", "\nDia is macOS-only. Keychain approval is the user's choice."],
  // #3129 dropped the Claude body's "When to invoke" section above the preamble (seven lines shorter).
  ['<!-- Regenerate: bun run gen:skill-docs -->\n\n## Preamble (run first)\n', '<!-- Regenerate: bun run gen:skill-docs -->\n\n\n## When to invoke this skill\n\nOpens an interactive picker UI where you select which cookie domains to import.\nUse before QA testing authenticated pages. Use when asked to "import cookies",\n"login to the site", or "authenticate the browser".\n\n## Preamble (run first)\n'],
];

// The honest-install wave (lazy Chromium) made the fallback probe call
// gstack-browser-ensure, explained it in one sentence inside the entrypoint
// (two lines longer), and pinned the Bun install hint by positional argument.
const LATER_ENTRYPOINT_BLOCK = /`gstack-browser-ensure` installs Chromium on first use[^\n]*\n\n/;
const LATER_ENTRYPOINT_EDITS: Array<[string, string]> = [
  ['if [ -x "$B" ] && "${B%/browse/*}/bin/gstack-browser-ensure"; then', 'if [ -x "$B" ]; then'],
  ['bash "$tmpfile" "bun-v$BUN_VERSION"', 'BUN_VERSION="$BUN_VERSION" bash "$tmpfile"'],
];

// The GSTA-49 cookie-workflow repair rewrote the entrypoint's steps 1-5 (split
// the two probe READY outcomes, dropped the duplicate SETUP block for the browse
// fallback, moved source selection before the target, asked about verification
// before the daemon starts, added a report shape) and one BROWSER.md comment.
// Reversing it first restores the pre-repair text, which the edits below then
// take back further.
const LATER_COOKIE_ORDER_EDITS: Array<[string, string]> = [
  ["## 1. Check for Aside\n\nUse this checkout as the gstack root if it contains `BROWSER.md` and `browse/SKILL.md`; otherwise use the installed root containing `bin/gstack-skill-start`, never a generated host stub. Read that root's `browse/SKILL.md` **BROWSER SETUP** section and run its Aside probe.\n\n- **Aside probe prints `READY`:** no import is needed, because Aside already has the user's signed-in sessions. Tell the user to use Aside, or to sign in there, and end this skill.\n- **Any other result:** continue with gstack's own headless browser (`$B`).\n\n## 2. Get every decision from the user first\n\nAsk these together, before running any `$B` command. Never guess an answer or treat the default Comet browser as consent.\n\n1. **Source browser and profile.** `--profile` takes the profile's directory (`Default`, `Profile 2`), not its display name. A profile that cannot be read is unknown, not empty.\n2. **Domains to import,** and the **target**: one page on a chosen domain that the session should open, by URL.\n3. **Sign-in verification (`--verify-auth`)?** Default no. It reloads the target and reports **verified** only after a successful same-origin response with exactly one visible element, found by a CSS selector, whose whitespace-normalized text equals the expected identity. If yes, the user supplies the selector and the expected identity privately.\n4. **Clear stale storage (`--clear-storage`)?** Default no; needs explicit approval. Chromium only. It clears localStorage for the target's origin (shared by that origin's tabs) and sessionStorage for the target tab, and nothing else; other browser engines reject the reset but still import. A failed reset may already have cleared some storage and is not rolled back.\n5. **Every cookie in the profile (`--all`)?** Default no; needs explicit consent. It cannot be combined with a domain or with clearing storage.\n\nUse the picker when any of answers 1-2 is still open; it asks for them. Use direct import when the user has named the browser, the profile directory and the domains.\n\n## 3. Prepare gstack's browser\n\n1. If the user wants verification, have them set `GSTACK_COOKIE_AUTH_SELECTOR` and `GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY` privately in the shell that runs `$B`. The browser daemon reads them only when it starts, so if a gstack daemon is already running, run `$B stop` first. Never invent the values.\n2. Follow `browse/SKILL.md`'s **Browser fallback** section to find `$B`, building it if the check prints `NEEDS_SETUP`.\n3. Run `$B status`. If it reports `Mode: cdp`, `$B` is attached to the user's real browser and already has its sessions: tell the user no import is needed and end this skill.\n4. Open the target URL from answer 2 and leave that tab alone until the import finishes:\n\n```bash\n$B goto \"<url>\"\n```\n\n## 4. Import\n\nPicker (the user confirms the browser, profile and domains there, ticks verification if they asked for it, then tells you when done; the link works once, for five minutes, so rerun the command if it expires):\n\n```bash\n$B cookie-import-browser\n```\n\nDirect import: run `$B cookie-import-browser` with the chosen browser name, one `--domain` per run and `--profile` set to the profile directory (not its display name); add `--verify-auth` or `--clear-storage` only if the user said yes in step 2.\n\nIf the import rejects because verification settings are missing, nothing changed: tell the user which variable is missing and return to step 3. Read that same root's `BROWSER.md`, **Choosing a source and checking sign-in**, for other errors and receipt failure reasons; it has the error tables, examples, profile labels, supported sources and platform setup.\n\n## 5. Report honestly\n\nReport from the import receipt, not from raw `$B cookies`, as three lines:\n\n- `Imported: <count> (<imported|partial|empty|failed>, as the receipt says) from <browser> for <domains>`\n- `Storage reset: <done|failed|not requested>`\n- `Sign-in: <verified|not verified|not checked>`\n\n**Not checked** means verification was not requested; **not verified** means it ran and failed; **verified** needs the identity match. Cookie counts, zero imports and HTTP 200 never prove sign-in. Imported cookies apply to the whole browser context, not one tab.\n\nNever request or publish cookie values, passwords, identity or profile text, session details, or raw errors in public logs.\n\n## Platform boundaries", "## 1. Choose the browser\n\nUse this checkout as the gstack root if it contains `BROWSER.md` and `browse/SKILL.md`; otherwise use the installed root containing `bin/gstack-skill-start`, never a generated host stub. Read that root's `browse/SKILL.md` **BROWSER SETUP** section and run its probe first. On `READY`, stop importing: use Aside's sessions or ask the user to sign in there. Otherwise follow the probe's fallback handling, then continue below.\n\n## SETUP (run this check BEFORE any browse command)\n\n```bash\n_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)\nB=\"\"\n[ -n \"$_ROOT\" ] && [ -x \"$_ROOT/.claude/skills/gstack/browse/dist/browse\" ] && B=\"$_ROOT/.claude/skills/gstack/browse/dist/browse\"\n[ -z \"$B\" ] && B=\"$HOME/.claude/skills/gstack/browse/dist/browse\"\nif [ -x \"$B\" ] && \"${B%/browse/*}/bin/gstack-browser-ensure\"; then\n  echo \"READY: $B\"\nelse\n  echo \"NEEDS_SETUP\"\nfi\n```\n\n`gstack-browser-ensure` installs Chromium on first use when the install skipped it (lazy browser); it prints `BROWSER_OK` or `BROWSER_UNAVAILABLE <reason>` first.\n\nIf `NEEDS_SETUP`:\n1. Tell the user: \"gstack browse needs a one-time build (~10 seconds). OK to proceed?\" Then STOP and wait.\n2. Run: `cd <SKILL_DIR> && ./setup`\n3. If `bun` is not installed:\n   ```bash\n   if ! command -v bun >/dev/null 2>&1; then\n     BUN_VERSION=\"1.4.2\"\n     BUN_INSTALL_SHA=\"bab8acfb046aac8c72407bdcce903957665d655d7acaa3e11c7c4616beae68dd\"\n     tmpfile=$(mktemp \"${TMPDIR:-/tmp}/bun-install.XXXXXX\")\n     curl -fsSL \"https://bun.sh/install\" -o \"$tmpfile\"\n     # shasum is macOS/perl; coreutils-only Linux ships sha256sum instead —\n     # resolve whichever exists so the verify never fails on a missing tool.\n     if command -v sha256sum >/dev/null 2>&1; then\n       actual_sha=$(sha256sum < \"$tmpfile\" | awk '{print $(1)}')\n     else\n       actual_sha=$(shasum -a 256 < \"$tmpfile\" | awk '{print $(1)}')\n     fi\n     if [ \"$actual_sha\" != \"$BUN_INSTALL_SHA\" ]; then\n       echo \"ERROR: bun install script checksum mismatch\" >&2\n       echo \"  expected: $BUN_INSTALL_SHA\" >&2\n       echo \"  got:      $actual_sha\" >&2\n       rm \"$tmpfile\"; exit 1\n     fi\n     bash \"$tmpfile\" \"bun-v$BUN_VERSION\"\n     rm \"$tmpfile\"\n   fi\n   ```\n\n```bash\n$B status\n```\nIf status says `Mode: cdp`, stop: the real browser already has sessions.\n\n## 2. Confirm options before import\n\nOpen the known target and keep its tab unchanged. Both options default off and require explicit request:\n\n- **`--verify-auth` / picker checkbox:** reloads the target. Have the user privately configure daemon `GSTACK_COOKIE_AUTH_SELECTOR` and `GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY` **before startup**. Never invent values or assume CLI env reconfigures an existing daemon. Missing config rejects before mutation. Require a successful same-origin response and exactly one visible element whose whitespace-normalized text exactly matches the expected identity.\n- **`--clear-storage`:** for suspected stale storage, obtain explicit approval. Chromium only: clears captured-origin localStorage (shared across same-origin context tabs) and target-tab sessionStorage. Other origins, other tabs' sessionStorage, IndexedDB, and service workers stay intact. It uses an isolated world/native deadline; other engines reject reset, not imports/auth checks. Never auto-approve or claim rollback after partial failure.\n\n## 3. Select source and scope\n\n```bash\n$B cookie-import-browser\n```\n\nAsk the user to choose browser, account/profile, and domains, then say when done. Never guess accounts or treat default Comet as consent. Unreadable profiles are unknown, not empty. Rerun for an expired five-minute one-use link.\n\nDirect import: pass the chosen browser and `--domain` after navigating to a matching target. `--profile` takes a directory, not a display name; omit only for an unambiguous relevant profile, otherwise use the picker. `--all` requires consent for all non-expired profile cookies; it cannot accompany `--domain` or `--clear-storage`.\n\nRead that same root's `BROWSER.md`, **Choosing a source and checking sign-in**, for examples, profile labels, supported sources and platform setup.\n\n## 4. Report honestly\n\nReport receipt/picker counts, partial/zero/error and reset outcomes, not raw `$B cookies`. Imports affect the context, not one tab. **Not checked** means no requested check; **not verified** means it failed; **verified** requires positive target evidence. Zero imports, counts, or HTTP 200 never prove login.\n\nNever request/publish cookie values, passwords, identity/profile text, session details, or raw errors in public logs.\n\n## Platform boundaries"],
  ["# view the page; only --verify-auth proves sign-in", "# confirm the intended account"],
];

// The #3338 trust warning (GSTA-84) added one paragraph after step 3's goto
// (two lines longer). Removing it first lets the GSTA-49 reversal match.
const LATER_TRUST_PARAGRAPH = "Tell the user once, before the import: gstack's headless browser trusts the root store built into gstack's bundled Chromium, which still accepts certificates from the compromised eMudhra intermediates. Until gstack moves to a Playwright release that drops them, don't use the imported sessions on a network the user does not trust. That same root's `BROWSER.md`, **TLS trust: the bundled Chromium's root store**, has the details and the check.\n\n";

export function approvedCookieWorkflowSource(source: string): string {
  let removedLines = 0;
  let removedEntrypointLines = 0;
  let reordered = source;
  if (reordered.includes(LATER_TRUST_PARAGRAPH)) {
    removedEntrypointLines += LATER_TRUST_PARAGRAPH.split('\n').length - 1;
    reordered = reordered.replace(LATER_TRUST_PARAGRAPH, '');
  }
  for (const [later, earlier] of LATER_COOKIE_ORDER_EDITS) {
    if (!reordered.includes(later)) continue;
    removedEntrypointLines += later.split('\n').length - earlier.split('\n').length;
    reordered = reordered.replace(later, earlier);
  }
  let historical = reordered
    .replace('sha256sum < "$tmpfile" | awk \'{print $(1)}\'', 'sha256sum "$tmpfile" | awk \'{print $1}\'')
    .replace('shasum -a 256 < "$tmpfile" | awk \'{print $(1)}\'', 'shasum -a 256 "$tmpfile" | awk \'{print $1}\'')
    .replace(LATER_BROWSER_BLOCK, block => { removedLines = block.split('\n').length - 1; return ''; })
    .replace(LATER_ENTRYPOINT_BLOCK, block => { removedEntrypointLines += block.split('\n').length - 1; return ''; });
  for (const [later, earlier] of [...LATER_BROWSER_EDITS, ...LATER_PREAMBLE_EDITS, ...LATER_WAVE_EDITS, ...LATER_ENTRYPOINT_EDITS]) historical = historical.replace(later, earlier);
  return historical
    .replace(/(--- BEGIN FILE "BROWSER\.md" \(lines \d+-)(\d+)(; section\) ---)/, (_, head, end, tail) => `${head}${Number(end) - removedLines}${tail}`)
    .replace(/(--- BEGIN FILE "setup-browser-cookies\/SKILL\.md" \(lines )(\d+)-(\d+)(; entrypoint\) ---)/, (_, head, start, end, tail) => `${head}${APPROVED_ENTRYPOINT_START}-${APPROVED_ENTRYPOINT_START + Number(end) - Number(start) - removedEntrypointLines}${tail}`);
}

export function manualReviewFixture(root = resolve(import.meta.dir, '../..')): EvalTestEntry {
  const approval = JSON.parse(readFileSync(resolve(root, COOKIE_MANUAL_REVIEW_FILE), 'utf8'));
  const prompt = approvedCookieWorkflowSource(buildCookieWorkflowJudgeInput(root).prompt);
  if (createHash('sha256').update(prompt).digest('hex') !== approval.prompt_sha256
    || Buffer.byteLength(prompt) !== approval.prompt_bytes) {
    throw new Error('Historical cookie approval fixture no longer reconstructs the exact approved prompt');
  }
  return {
    name: 'setup-browser-cookies/SKILL.md workflow', suite: 'Cookie setup workflow quality', tier: 'llm-judge',
    passed: false, execution: 'executed', exit_reason: 'provider_refusal', attempt: 1, duration_ms: 1, cost_usd: 0,
    model: approval.model, prompt,
    error: 'Synthetic provider refusal fixture, not live model evidence',
    manual_review: { approval, refusal: { stop_reason: 'refusal', response_id: 'msg_synthetic_fixture',
      request_id: 'req_synthetic_fixture', model: approval.model, input_tokens: 1, output_tokens: 0, text_blocks: 0 } },
  };
}
