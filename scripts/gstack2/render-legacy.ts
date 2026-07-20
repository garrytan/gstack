import * as fs from 'fs';
import * as path from 'path';
import { getHostConfig } from '../../hosts/index';
import { extractHookSafetyProse, extractNameAndDescription } from '../resolvers/codex-helpers';
import { RESOLVERS } from '../resolvers/index';
import { HOST_PATHS, unwrapResolver, type TemplateContext } from '../resolvers/types';
import { SOURCE_ASSIGNMENTS } from './assignments';
import { GSTACK2_BASE_SHA } from './types';

export const ROOT = path.resolve(import.meta.dir, '..', '..');

/** Convert a filesystem-relative path into Git's repository path format. */
export function normalizeRepositoryPath(relativePath: string): string {
  return relativePath.replaceAll(path.win32.sep, path.posix.sep);
}

export function repositoryRelativePath(absolutePath: string): string {
  return normalizeRepositoryPath(path.relative(ROOT, absolutePath));
}

export function pinnedRevisionPath(relativePath: string): string {
  return `${GSTACK2_BASE_SHA}:${normalizeRepositoryPath(relativePath)}`;
}

export function legacyTemplatePath(source: string): string {
  return source === 'gstack'
    ? path.join(ROOT, 'SKILL.md.tmpl')
    : path.join(ROOT, source, 'SKILL.md.tmpl');
}

export function legacyRelativePath(source: string): string {
  return repositoryRelativePath(legacyTemplatePath(source));
}

function pinnedText(relativePath: string): string {
  const result = Bun.spawnSync({
    cmd: ['git', 'show', pinnedRevisionPath(relativePath)],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(`Unable to read ${relativePath} at ${GSTACK2_BASE_SHA}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content.trim();
  const end = content.indexOf('\n---', 4);
  if (end === -1) throw new Error('Unclosed template frontmatter');
  return content.slice(end + 4).trim();
}

function buildContext(tmplContent: string, tmplPath: string): TemplateContext {
  const { name } = extractNameAndDescription(tmplContent);
  const benefitsMatch = tmplContent.match(/^benefits-from:\s*\[([^\]]*)\]/m);
  const benefitsFrom = benefitsMatch
    ? benefitsMatch[1].split(',').map((value) => value.trim()).filter(Boolean)
    : undefined;
  const tierMatch = tmplContent.match(/^preamble-tier:\s*(\d+)$/m);
  const interactiveMatch = tmplContent.match(/^interactive:\s*(true|false)\s*$/m);
  return {
    skillName: name || path.basename(path.dirname(tmplPath)),
    tmplPath,
    benefitsFrom,
    host: 'codex',
    paths: HOST_PATHS.codex,
    preambleTier: tierMatch ? Number.parseInt(tierMatch[1], 10) : undefined,
    model: 'claude',
    interactive: interactiveMatch ? interactiveMatch[1] === 'true' : undefined,
    explainLevel: 'default',
  };
}

type ResolverOverrides = Readonly<Record<string, string>>;

function resolvePlaceholders(
  template: string,
  context: TemplateContext,
  relativePath: string,
  overrides: ResolverOverrides = {},
): string {
  const config = getHostConfig('codex');
  const suppressed = new Set(config.suppressedResolvers ?? []);
  const onePass = (input: string): string => input.replace(
    /\{\{(\w+(?::[^}]+)?)\}\}/g,
    (_match, fullKey: string) => {
      const [resolverName, ...args] = fullKey.split(':');
      if (Object.hasOwn(overrides, resolverName)) return overrides[resolverName];
      if (suppressed.has(resolverName)) return '';
      const entry = RESOLVERS[resolverName];
      if (!entry) throw new Error(`Unknown placeholder {{${resolverName}}} in ${relativePath}`);
      const { resolve, appliesTo } = unwrapResolver(entry);
      if (appliesTo && !appliesTo(context)) return '';
      return args.length ? resolve(context, args) : resolve(context);
    },
  );

  let content = template;
  for (let pass = 0; pass < 6; pass += 1) {
    const next = onePass(content);
    if (next === content) break;
    content = next;
  }
  const remaining = content.match(/\{\{(\w+(?::[^}]+)?)\}\}/g);
  if (remaining) throw new Error(`Unresolved placeholders in ${relativePath}: ${remaining.join(', ')}`);
  return content;
}

/**
 * The 1.x PREAMBLE resolver is host installation and engagement machinery, not
 * specialist judgment. It performs first-run writes, telemetry/proactive
 * prompts, update checks, model overlays, checkpoint promotion, artifact-sync
 * enrollment, and CLAUDE.md mutation. GStack 2 keeps that immutable expansion
 * as the parity oracle while deliberately excluding it from normal canonical
 * execution. Runtime and authority are owned once by package-local contracts.
 */
export const CANONICAL_EXCLUDED_RESOLVERS = ['PREAMBLE'] as const;

const RETIRED_ASSIGNMENTS = [...SOURCE_ASSIGNMENTS]
  .filter((entry) => !['plan', 'design', 'qa', 'debug', 'review', 'ship'].includes(entry.source))
  .sort((a, b) => b.source.length - a.source.length);

export function retiredInvocationPattern(): RegExp {
  const sources = RETIRED_ASSIGNMENTS
    .map((entry) => entry.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`(?<![A-Za-z0-9_.-])/(?:${sources})(?=$|[\\s\\x60'\"),.;:*_|\\]}>])`);
}

export function replaceRetiredInvocations(value: string): string {
  let rewritten = value;
  for (const assignment of RETIRED_ASSIGNMENTS) {
    // A preceding word/path character means this slash is part of a file path
    // or URL, not an invocation. The trailing set includes Markdown emphasis,
    // table, and link punctuation in addition to prose punctuation.
    rewritten = rewritten.replace(
      new RegExp(`(?<![A-Za-z0-9_.-])/${assignment.source}(?=$|[\\s\\x60'\"),.;:*_|\\]}>])`, 'g'),
      assignment.replacement,
    );
  }
  return rewritten;
}

function renderCanonicalSpecialistBody(source: string): string {
  const templatePath = legacyTemplatePath(source);
  const relativePath = repositoryRelativePath(templatePath);
  const template = pinnedText(relativePath);
  const context = buildContext(template, templatePath);
  const overrides = Object.fromEntries(CANONICAL_EXCLUDED_RESOLVERS.map((name) => [name, '']));
  // Hook advisories are part of the host-specific 1.x wrapper. Canonical
  // authority/safety policy is generated once beside every public dispatcher.
  const body = stripFrontmatter(resolvePlaceholders(template, context, relativePath, overrides));
  return `${applyCodexRewrites(body).trim()}\n`;
}

function applyCodexRewrites(content: string): string {
  const config = getHostConfig('codex');
  let rewritten = content;
  for (const entry of config.pathRewrites) rewritten = rewritten.replaceAll(entry.from, entry.to);
  for (const [from, to] of Object.entries(config.toolRewrites ?? {})) rewritten = rewritten.replaceAll(from, to);
  return rewritten;
}

/**
 * Render a legacy template exactly as the canonical Codex host would render
 * its body: resolver expansion, non-Claude section inlining, safety prose, and
 * host rewrites. The legacy frontmatter and generated header are intentionally
 * excluded because GStack 2 owns the six public skill manifests.
 */
export function renderLegacyBody(source: string): string {
  const templatePath = legacyTemplatePath(source);
  const relativePath = repositoryRelativePath(templatePath);
  const template = pinnedText(relativePath);
  const context = buildContext(template, templatePath);
  let body = stripFrontmatter(resolvePlaceholders(template, context, relativePath));
  const safety = extractHookSafetyProse(template);
  // The pinned external-host generator inserts one newline after the advisory
  // in addition to the body's existing two-newline separation. Preserve that
  // exact byte shape so hook-bearing templates share the same immutable oracle.
  if (safety) body = `${safety}\n\n\n${body}`;
  return `${applyCodexRewrites(body).trim()}\n`;
}

/**
 * Apply only GStack 2 packaging/runtime mechanics to the immutable 1.x Codex
 * render. `renderLegacyBody()` remains the raw parity oracle; this function is
 * the installable port and every rewrite is separately asserted in parity.
 */
function portLegacyText(value: string, source: string): string {
  if (source === 'gstack-upgrade') {
    return `# Legacy upgrade compatibility\n\nThe 1.x host-directory detector, vendored-copy synchronizer, and destructive Git replacement blocks were duplicated installation infrastructure. GStack 2 delegates skill placement and updates to the standard Agent Skills installer and manages the optional shared runtime atomically.\n\n- Update selected skills with \`npx skills add time-attack/gstack/skills\` using the user's existing project/global choice. Never infer or enroll a host.\n- Upgrade a complete local runtime package with \`gstack upgrade --source <complete-gstack-package> --version <version>\`.\n- Roll back the runtime with \`gstack upgrade --rollback\`.\n- Run \`gstack doctor\` after either operation.\n- Do not reset, delete, move, or rewrite a host skill directory. Do not infer Context.dev choice or consent.\n\nThis compatibility module contains no specialist judgment; release readiness and rollback judgment remain in the preserved ship modules.\n`;
  }
  let body = value;

  // Retired names remain valid only as opt-in compatibility aliases. Normal
  // canonical execution must recommend one of the six public routes, with the
  // exact internal refinement retained for deterministic dispatch.
  body = replaceRetiredInvocations(body);
  // Every state read/write follows the canonical override. Quote the root so
  // custom homes containing spaces remain valid. Compatibility pointer files
  // such as ~/.gstack-artifacts-remote.txt are outside this state root and are
  // intentionally not matched by the slash/exact-path boundaries.
  body = body
    .replace(/"\$\{HOME\}\/\.gstack(?=\/|")/g, '"${GSTACK_HOME:-$HOME/.gstack}')
    .replace(/"\$HOME\/\.gstack(?=\/|")/g, '"${GSTACK_HOME:-$HOME/.gstack}')
    .replace(/\$\{HOME\}\/\.gstack(?=\/|[\s`'"),.;:\]}])/g, '"${GSTACK_HOME:-$HOME/.gstack}"')
    .replace(/(?<![-"{])\$HOME\/\.gstack(?=\/|[\s`'"),.;:\]}])/g, '"${GSTACK_HOME:-$HOME/.gstack}"')
    .replace(/~\/\.gstack(?=\/|[\s`'"),.;:\]}])/g, '"${GSTACK_HOME:-$HOME/.gstack}"');

  // SLUG remains a human-facing/repository namespace for remote GBrain data,
  // but it is not a safe local state key: linked worktrees share the same
  // remote slug. Mechanically port only paths rooted in the canonical local
  // state directory to the worktree-safe PROJECT_ID emitted by gstack-slug.
  body = body.replace(
    /((?:"\$\{GSTACK_HOME:-\$HOME\/\.gstack\}"|\$\{GSTACK_HOME:-\$HOME\/\.gstack\}|\$GSTACK_STATE_ROOT|\$\{GSTACK_STATE_ROOT\}|\$GSTACK_HOME)\/projects\/)(\$\{SLUG:-unknown\}|\$SLUG\b|\$_PLAN_SLUG\b|<slug>|\{slug\})/g,
    (_match, prefix: string, key: string) => `${prefix}${key === '<slug>' || key === '{slug}' ? '<stable-project-id>' : '${PROJECT_ID:-unknown}'}`,
  );
  for (const section of legacySections().filter((entry) => entry.source === source)) {
    const filename = path.basename(section.relativePath).replace(/\.tmpl$/, '');
    const localSection = `references/sections/${source}/${filename}`;
    const marker = `__GSTACK2_SECTION_${source}_${filename}__`;
    body = body
      .replaceAll(`~/.claude/skills/gstack/${source}/sections/${filename}`, marker)
      .replaceAll(`$GSTACK_ROOT/${source}/sections/${filename}`, marker)
      .replaceAll(`\${CLAUDE_SKILL_DIR}/sections/${filename}`, marker)
      .replaceAll(`sections/${filename}`, marker)
      .replaceAll(marker, localSection);
  }

  // Skill-to-skill reads must resolve inside a selected canonical package,
  // never through a retired host-specific installation root.
  body = body
    .replace(/~\/\.claude\/skills\/gstack\/([a-z0-9-]+)\/SKILL\.md/g, 'references/legacy/$1.md')
    .replace(/\$GSTACK_ROOT\/([a-z0-9-]+)\/SKILL\.md/g, 'references/legacy/$1.md')
    .replace(/\$\{CLAUDE_SKILL_DIR\}\/\.\.\/([a-z0-9-]+)\/SKILL\.md/g, 'references/legacy/$1.md')
    .replace(/\$CLAUDE_SKILL_DIR\/\.\.\/([a-z0-9-]+)\/SKILL\.md/g, 'references/legacy/$1.md');

  // Small read-on-demand policy artifacts are part of every selected skill.
  // Keeping them package-local prevents a standards-native install from
  // reaching back into a source checkout or another host's skill directory.
  body = body
    .replaceAll('$GSTACK_ROOT/ETHOS.md', 'references/support/ETHOS.md')
    .replaceAll('docs/askuserquestion-split.md', 'references/support/docs/askuserquestion-split.md')
    .replaceAll('docs/askuserquestion-cjk.md', 'references/support/docs/askuserquestion-cjk.md')
    .replaceAll('$GSTACK_ROOT/scripts/jargon-list.json', '__GSTACK2_JARGON_LIST__')
    .replaceAll('scripts/jargon-list.json', '__GSTACK2_JARGON_LIST__')
    .replaceAll('__GSTACK2_JARGON_LIST__', 'references/support/scripts/jargon-list.json');
  body = body
    .replaceAll('scripts/question-registry.ts', 'references/support/scripts/question-registry.ts')
    .replaceAll('lib/redact-patterns.ts', 'references/support/lib/redact-patterns.ts');

  // Specialist-linked assets keep their pinned bytes but move under the
  // selected package. Executable runtime helpers remain under GSTACK_HOME.
  body = body
    .replaceAll('$GSTACK_ROOT/plan-devex-review/dx-hall-of-fame.md', 'references/artifacts/plan-devex-review/dx-hall-of-fame.md')
    .replaceAll('$GSTACK_ROOT/design-html/vendor/pretext.js', 'assets/design-html/vendor/pretext.js')
    .replaceAll('$GSTACK_ROOT/review/checklist.md', 'references/artifacts/review/checklist.md')
    .replaceAll('$GSTACK_ROOT/ios-qa/templates/', 'references/artifacts/ios-qa/templates/')
    .replaceAll('ios-qa/docs/tailscale-acl-example.md', 'references/artifacts/ios-qa/docs/tailscale-acl-example.md');

  // The optional runtime is installed once per user and is independent from
  // standards-native skill placement. Preserve helper behavior while removing
  // every Claude/Codex/project-specific runtime-root assumption.
  body = body
    .replaceAll('$GSTACK_ROOT/bin/', '$GSTACK_BIN/')
    .replaceAll(
      'GSTACK_ROOT="$HOME/.codex/skills/gstack"',
      'GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"\nGSTACK_ROOT="$GSTACK_HOME"',
    )
    .replaceAll(
      '[ -n "$_ROOT" ] && [ -d "$_ROOT/.agents/skills/gstack" ] && GSTACK_ROOT="$_ROOT/.agents/skills/gstack"',
      ': "GStack 2 runtime is user-scoped; Agent Skills placement is installer-owned"',
    )
    .replaceAll('.agents/skills/gstack/bin/gstack-update-check', '$GSTACK_BIN/gstack-update-check')
    .replaceAll('$GSTACK_ROOT/browse/bin/remote-slug', '$GSTACK_BIN/remote-slug')
    .replaceAll('$GSTACK_ROOT/browse/dist/browse', '$GSTACK_BIN/browse')
    .replaceAll('$GSTACK_ROOT/browse/dist', '$GSTACK_BIN')
    .replaceAll('$GSTACK_ROOT/design/dist/design', '$GSTACK_BIN/gstack-design')
    .replaceAll('$GSTACK_ROOT/design/dist', '$GSTACK_BIN')
    .replaceAll('$GSTACK_ROOT/lib/redact-audit-log.ts', '$GSTACK_BIN/gstack-redact-audit-log')
    .replaceAll('bun $GSTACK_BIN/gstack-redact-audit-log', '$GSTACK_BIN/gstack-redact-audit-log')
    .replaceAll('Disk paths stay `$GSTACK_ROOT/[skill-name]/SKILL.md`.', 'Resolve retired names through `references/COMPATIBILITY.md`; skill placement is installer-owned.')
    .replaceAll('Tell the user: "Done. Each developer now runs: `cd $GSTACK_ROOT && ./setup --team`"', 'Tell the user: "Done. Each developer installs the selected canonical skills with `npx skills add time-attack/gstack/skills`; the optional runtime remains user-scoped."');

  body = body
    .replace(/_VENDORED="no"\nif \[ -d "\.agents\/skills\/gstack" \][\s\S]*?echo "VENDORED_GSTACK: \$_VENDORED"/g, '_VENDORED="managed-by-standard-installer"\necho "VENDORED_GSTACK: $_VENDORED"')
    .replace(/If `VENDORED_GSTACK` is `yes`, warn once[\s\S]*?If marker exists, skip\./g, 'GStack 2 delegates skill placement, updates, and removal to the standard Agent Skills installer. Never inspect, delete, commit, or migrate a host-specific skill directory from a judgment workflow.')
    .replaceAll('"$_ROOT/.agents/skills/gstack/browse/dist/browse"', '"$GSTACK_BIN/browse"')
    .replaceAll('"$HOME/.agents/skills/gstack/browse/dist/browse"', '"$GSTACK_BIN/browse"')
    .replaceAll('"$_ROOT/.agents/skills/gstack/design/dist/design"', '"$GSTACK_BIN/gstack-design"')
    .replaceAll('"$HOME/.agents/skills/gstack/design/dist/design"', '"$GSTACK_BIN/gstack-design"')
    .replaceAll('[ -z "$P" ] && [ -n "$_ROOT" ] && [ -x "$_ROOT/.agents/skills/gstack/make-pdf/dist/pdf" ] && P="$_ROOT/.agents/skills/gstack/make-pdf/dist/pdf"', '[ -z "$P" ] && P="$GSTACK_BIN/make-pdf"')
    .replaceAll('`$_ROOT/.agents/skills/gstack/browse/dist/browse` or `$GSTACK_BIN/browse`', '`$GSTACK_BIN/browse`')
    .replaceAll('BIN="$HOME/.agents/skills/gstack/bin/gstack-model-benchmark"', 'BIN="$GSTACK_BIN/gstack-model-benchmark"')
    .replaceAll('[ -x "$BIN" ] || BIN=".agents/skills/gstack/bin/gstack-model-benchmark"', ': "model benchmark helper resolves from the managed runtime"')
    .replaceAll('ERROR: gstack-model-benchmark not found. Run ./setup in the gstack install dir.', 'ERROR: gstack-model-benchmark not found. Install the optional runtime, then run gstack doctor.')
    .replaceAll('[ -z "$DISCOVER_BIN" ] && [ -x .agents/skills/gstack/bin/gstack-global-discover ] && DISCOVER_BIN=.agents/skills/gstack/bin/gstack-global-discover', '[ -z "$DISCOVER_BIN" ] && [ -x "$GSTACK_BIN/gstack-global-discover" ] && DISCOVER_BIN="$GSTACK_BIN/gstack-global-discover"')
    .replaceAll('~/.codex/skills/gstack/browse-remote.json', '${GSTACK_HOME:-$HOME/.gstack}/browse-remote.json')
    .replaceAll('${HOME}/.agents/skills/gstack/document-release/SKILL.md', 'references/legacy/document-release.md');

  // The managed runtime owns a pinned Bun executable. Remove the old
  // per-skill curl installer and route GStack-owned helpers through their
  // stable launchers. Project-owned commands such as a repository's `bun
  // test` are intentionally untouched.
  body = body
    .replace(
      /3\. If `bun` is not installed:\n\s+```bash\n[\s\S]*?\n\s+```/g,
      '3. The approved managed runtime includes its own pinned Bun at `$GSTACK_BIN/bun`; never download or install another Bun from a skill workflow.',
    )
    .replaceAll('bun run $GSTACK_BIN/gstack-gbrain-sync.ts', '$GSTACK_BIN/gstack-gbrain-sync')
    .replaceAll('bun run $GSTACK_BIN/gstack-next-version', '$GSTACK_BIN/gstack-next-version')
    .replaceAll('bun run $GSTACK_BIN/gstack-version-bump', '$GSTACK_BIN/gstack-version-bump')
    .replaceAll('DISCOVER_BIN="bun run $GSTACK_BIN/gstack-global-discover"', 'DISCOVER_BIN="$GSTACK_BIN/gstack-global-discover"')
    .replaceAll('Tell the user: "gstack browse needs a one-time build (~10 seconds). OK to proceed?" Then STOP and wait.', 'Tell the user: "The optional managed headless browser capability is missing. Do you want to preview its exact dependency-closed component plan and compressed bytes now?" Then STOP and wait.')
    .replace(/^command -v bun >\/dev\/null 2>&1 \|\| echo "redaction scan skipped — bun not on PATH"\n/gm, '');

  body = body
    .replaceAll(
      'Run: `cd <SKILL_DIR> && ./setup`',
      'Read `references/RUNTIME.md` and follow its explicit capability bootstrap. Never assume a standard-installed skill directory contains `./setup`.',
    )
    .replaceAll(
      'run `cd <SKILL_DIR> && ./setup`',
      'read `references/RUNTIME.md` and follow its explicit capability bootstrap; never assume a standard-installed skill directory contains `./setup`',
    )
    .replaceAll(
      'Run `cd <SKILL_DIR> && ./setup`',
      'Read `references/RUNTIME.md` and follow its explicit capability bootstrap. Never assume a standard-installed skill directory contains `./setup`.',
    );

  for (const helper of [
    'gstack-codex-probe',
    'gstack-global-discover.ts',
    'gstack-next-version',
    'gstack-paths',
    'gstack-pr-title-rewrite.sh',
    'gstack-question-log',
    'gstack-question-preference',
  ]) {
    const stableName = helper === 'gstack-global-discover.ts' ? 'gstack-global-discover' : helper;
    body = body.replaceAll(`bin/${helper}`, `$GSTACK_BIN/${stableName}`);
  }
  body = body
    .replaceAll('bun run $GSTACK_BIN/gstack-gbrain-sync.ts', '$GSTACK_BIN/gstack-gbrain-sync')
    .replaceAll('bun run $GSTACK_BIN/gstack-gbrain-sync', '$GSTACK_BIN/gstack-gbrain-sync')
    .replaceAll('bun run $GSTACK_BIN/gstack-next-version', '$GSTACK_BIN/gstack-next-version')
    .replaceAll('bun run $GSTACK_BIN/gstack-version-bump', '$GSTACK_BIN/gstack-version-bump')
    .replaceAll('DISCOVER_BIN="bun run $GSTACK_BIN/gstack-global-discover"', 'DISCOVER_BIN="$GSTACK_BIN/gstack-global-discover"');

  body = body.replace(
    /BUNDLE=""\nfor c in "\$HOME\/\.agents\/skills\/gstack\/lib\/diagram-render\/dist\/diagram-render\.html" \\\n\s+"\$\(git rev-parse --show-toplevel 2>\/dev\/null\)\/lib\/diagram-render\/dist\/diagram-render\.html"; do\n\s+\[ -f "\$c" \] && BUNDLE="\$c" && break\ndone/,
    'BUNDLE=$($GSTACK_BIN/gstack runtime path lib/diagram-render/dist/diagram-render.html 2>/dev/null || true)',
  );
  body = body.replace(
    /_EXT_PATH=""\n_ROOT=\$\(git rev-parse --show-toplevel 2>\/dev\/null\)\n\[ -n "\$_ROOT" \][\s\S]*?echo "EXTENSION_PATH: \$\{_EXT_PATH:-NOT FOUND\}"/,
    '_EXT_PATH=$($GSTACK_BIN/gstack runtime path extension 2>/dev/null || true)\necho "EXTENSION_PATH: ${_EXT_PATH:-NOT FOUND}"',
  );
  body = body.replaceAll('[ -n "$_ROOT" ] && [ -f "$_ROOT/.agents/skills/gstack/design-html/vendor/pretext.js" ] && _PRETEXT_VENDOR="$_ROOT/.agents/skills/gstack/design-html/vendor/pretext.js"', ': "Pretext is packaged with the selected design skill"');
  body = body
    .replaceAll('--package-path "$GSTACK_HOME/ios-qa/scripts/gen-accessors-tool"', '--package-path "$($GSTACK_BIN/gstack runtime path ios-qa/scripts/gen-accessors-tool)"')
    .replaceAll('--package-path $GSTACK_HOME/ios-qa/scripts/gen-accessors-tool', '--package-path "$($GSTACK_BIN/gstack runtime path ios-qa/scripts/gen-accessors-tool)"')
    .replaceAll('`$GSTACK_HOME/ios-qa/.gstack-version` (or the\n   value baked into the installed gstack binary)', 'the version reported by `$GSTACK_BIN/gstack --version`')
    .replaceAll('`$GSTACK_HOME/ios-qa/templates/<Name>.swift.template`', '`references/artifacts/ios-qa/templates/<Name>.swift.template`')
    .replaceAll('Use the helper at `browse/src/browser-skill-write.ts`.', 'Resolve the managed helper first with `GSTACK_BROWSER_SKILL_WRITE=$($GSTACK_BIN/gstack runtime path browse/src/browser-skill-write.ts)` and use that exact path.')
    .replaceAll('<gstack-install>/browse/src/browser-skill-write', '<resolved GSTACK_BROWSER_SKILL_WRITE path>');

  for (const filename of ['TODOS-format.md', 'checklist.md', 'design-checklist.md', 'greptile-triage.md']) {
    const marker = `__GSTACK2_REVIEW_ASSET_${filename}__`;
    body = body
      .replaceAll(`.agents/skills/gstack/review/${filename}`, marker)
      .replace(new RegExp(`(?<!references/artifacts/)review/${filename.replace('.', '\\.')}`, 'g'), marker)
      .replaceAll(marker, `references/artifacts/review/${filename}`);
  }

  // The managed runtime installs stable launchers in one canonical user bin.
  body = body
    .replaceAll('$HOME$GSTACK_BROWSE/browse', '${GSTACK_HOME:-$HOME/.gstack}/bin/browse')
    .replaceAll('$HOME$GSTACK_DESIGN/design', '${GSTACK_HOME:-$HOME/.gstack}/bin/gstack-design')
    .replaceAll('$HOME$GSTACK_MAKE_PDF/pdf', '${GSTACK_HOME:-$HOME/.gstack}/bin/make-pdf');

  if (source === 'careful') {
    body = body.replace(
      'Every Bash command is automatically checked against destructive patterns. When a dangerous command is detected, you MUST use AskUserQuestion to warn the user and get confirmation before proceeding.',
      'Treat destructive-command checking as inline advisory policy unless the active host explicitly confirms that the GStack hook is installed. You MUST use AskUserQuestion to warn the user and get confirmation before proceeding, and never claim that every Bash command was intercepted when no hook is active.',
    );
  }

  // Canonical skills do not run engagement instrumentation. Remove the few
  // source-local remnants that are outside {{PREAMBLE}} while leaving actual
  // specialist reports, requested context saves, and explicit setup modules
  // intact.
  body = body.replace(/```bash\n([\s\S]*?)```/g, (block, commands: string) => {
    const writesAnalytics = /(?:mkdir\s+-p|>>)[^\n]*\/(?:analytics|skill-usage\.jsonl)/.test(commands);
    return writesAnalytics
      ? 'Canonical execution does not write engagement analytics or telemetry.'
      : block;
  });
  body = body
    .replace(/^.*gstack-telemetry-log.*\n?/gm, '')
    .replace(/^\s*_gstack_codex_log_event\s+.*\n?/gm, '')
    .replace(/^_TEL=\$\([^\n]*\)$/gm, '_TEL=off # Canonical execution does not emit GStack telemetry.')
    .replace(/Best-effort, record which way you routed[\s\S]*?directly, no skill matched\):\nCanonical execution does not write engagement analytics or telemetry\.\n*/g, '')
    .replace(/If `PROACTIVE` is `false`:[\s\S]*?Use the Skill tool to invoke it\. The skill has specialized workflows, checklists, and\nquality gates that produce better results than answering inline\.\n\n/g, '')
    .replace(/\nIf the user opts out of suggestions,[\s\S]*?gstack-config set proactive true`\.\n?/g, '\n')
    .replace(/#### TTHW telemetry \(DX11\/F7\)[\s\S]*?\n---\n/g, '---\n')
    .replace(/\n3\. Append metrics:\nCanonical execution does not write engagement analytics or telemetry\.\nReplace ITERATIONS,[\s\S]*?actual values from the review\.\n/g, '\n3. Report the iteration counts and quality score in the user-facing result; do not persist engagement analytics.\n');

  return `${body.trim()}\n`;
}

export function renderPortedLegacyBody(source: string): string {
  let body = portLegacyText(renderCanonicalSpecialistBody(source), source);
  if (source === 'make-pdf') {
    body = [
      '## Optional runtime binding',
      '',
      'This workflow requires the `pdf` capability. Read `references/RUNTIME.md` before attempting installation. Pure planning or document review can continue without it.',
      'If unavailable, follow the consent-first `pdf` capability handoff in `references/RUNTIME.md`. It expands to `pdf`, `diagram`, and `browser`; do not guess a checkout-relative setup command.',
      '',
      body,
    ].join('\n');
  }
  body = body.replace(
    '`./setup` auto-installs `fonts-noto-color-emoji` on Linux',
    'the explicitly approved `pdf` runtime capability attempts to install `fonts-noto-color-emoji` on Linux',
  );
  if (['open-gstack-browser', 'pair-agent', 'setup-browser-cookies'].includes(source)) {
    body = [
      '## Visible-browser point-of-use gate',
      '',
      'This workflow may require internal `browser-visible` because it reaches a headed browser, extension, interactive cookie picker, or browser handoff. Do not offer visible Chromium during ordinary headless QA.',
      '',
      'At the first actual visible-browser step, ask whether the user wants to check official setup options and exact sizes. Disclose that an uncached preview makes one public GitHub signed-manifest request and sends no repository/private data, then STOP. Only after that approval run `node references/support/runtime-bootstrap.mjs preview --capability browser-visible`. It expands to `core + browser-code + browser-visible` for a first install, but an existing verified headless runtime downloads only missing `browser-visible`; it never requires `browser-headless`. Show the exact missing components and summed incremental compressed bytes, then STOP again for separate install approval. Only after install approval run `node references/support/runtime-bootstrap.mjs install --capability browser-visible --yes`, recheck readiness, and resume the interrupted step.',
      '',
      body,
    ].join('\n');
  }
  if (/\$(?:GSTACK_BIN|GSTACK_ROOT|GSTACK_STATE_ROOT)\b|\$(?:B|D|P)\b/.test(body)) {
    const bindings = [
      '## Host-neutral runtime bindings',
      '',
      'These assignments select stable paths only; they do not install anything or grant consent:',
      '',
      '```bash',
      'GSTACK_HOME="${GSTACK_HOME:-$HOME/.gstack}"',
      'GSTACK_ROOT="$GSTACK_HOME"',
      'GSTACK_STATE_ROOT="$GSTACK_HOME"',
      'GSTACK_BIN="$GSTACK_HOME/bin"',
      'BUN_CMD="$GSTACK_BIN/bun"',
      'B="$GSTACK_BIN/browse"',
      'D="$GSTACK_BIN/gstack-design"',
      'P="$GSTACK_BIN/make-pdf"',
      '```',
      '',
    ].join('\n');
    body = `${bindings}${body}`;
  }
  // Large specialist phases remain byte-derived from the pinned source, but
  // are packaged as lazy references instead of duplicated inline. The active
  // workflow loads one only when it reaches that phase.
  for (const section of legacySections().filter((entry) => entry.source === source)) {
    const ported = portLegacyText(section.rendered, section.source).trim();
    const filename = path.basename(section.relativePath).replace(/\.tmpl$/, '');
    const reference = `references/sections/${source}/${filename}`;
    const directive = [
      `## Lazy specialist phase: ${filename.replace(/\.md$/, '')}`,
      '',
      `When the workflow reaches this phase, read \`${reference}\` completely and execute it before continuing. Do not summarize or skip its questions, pressure, gates, evidence, artifacts, mutation boundary, or exit behavior.`,
    ].join('\n');
    if (!body.includes(ported)) throw new Error(`Unable to carve canonical section ${section.relativePath} from ${source}`);
    body = body.replace(ported, directive);
  }
  return `${body.trim()}\n`;
}

export function renderPortedLegacySection(section: LegacySection): string {
  return portLegacyText(section.rendered, section.source);
}

/** Apply host-neutral runtime-path mechanics to linked text assets. */
export function renderPortedAssetBytes(relativePath: string, input: Uint8Array): Uint8Array {
  if (!relativePath.endsWith('.md')) return input;
  const ported = replaceRetiredInvocations(Buffer.from(input).toString('utf8')
    .replaceAll(
      '~/.claude/skills/gstack/bin/gstack-diff-scope',
      '${GSTACK_HOME:-$HOME/.gstack}/bin/gstack-diff-scope',
    )
    .replaceAll(
      'browse/bin/remote-slug 2>/dev/null || ~/.claude/skills/gstack/browse/bin/remote-slug',
      '${GSTACK_HOME:-$HOME/.gstack}/bin/remote-slug',
    ));
  return Buffer.from(ported, 'utf8');
}

export interface LegacySection {
  source: string;
  absolutePath: string;
  relativePath: string;
  rendered: string;
}

let cachedLegacySections: LegacySection[] | undefined;

export function legacySections(): LegacySection[] {
  if (cachedLegacySections) return cachedLegacySections;
  const sections: LegacySection[] = [];
  for (const sourceDir of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!sourceDir.isDirectory()) continue;
    const sectionDir = path.join(ROOT, sourceDir.name, 'sections');
    if (!fs.existsSync(sectionDir)) continue;
    const parentPath = legacyTemplatePath(sourceDir.name);
    if (!fs.existsSync(parentPath)) continue;
    const parent = pinnedText(repositoryRelativePath(parentPath));
    const context = buildContext(parent, parentPath);
    for (const file of fs.readdirSync(sectionDir).filter((name) => name.endsWith('.md.tmpl')).sort()) {
      const absolutePath = path.join(sectionDir, file);
      const relativePath = repositoryRelativePath(absolutePath);
      const template = pinnedText(relativePath);
      const rendered = `${applyCodexRewrites(resolvePlaceholders(template, context, relativePath)).trim()}\n`;
      sections.push({ source: sourceDir.name, absolutePath, relativePath, rendered });
    }
  }
  cachedLegacySections = sections.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return cachedLegacySections;
}

export function sourceBlobSha(source: string): string {
  return blobShaForPath(legacyRelativePath(source));
}

export function blobShaForPath(relativePath: string): string {
  const result = Bun.spawnSync({
    cmd: ['git', 'rev-parse', pinnedRevisionPath(relativePath)],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to resolve ${relativePath} at ${GSTACK2_BASE_SHA}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}
