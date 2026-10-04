/**
 * Learnings resolver — cross-skill institutional memory
 *
 * Learnings are stored per-project at ~/.gstack/projects/{slug}/learnings.jsonl.
 * Each entry is a JSONL line with: ts, skill, type, key, insight, confidence,
 * source, branch, commit, files[].
 *
 * Storage is append-only. Duplicates (same key+type) are resolved at read time
 * by gstack-learnings-search ("latest winner" per key+type).
 *
 * Cross-project discovery is opt-in. The resolver asks the user once via
 * AskUserQuestion and persists the preference via gstack-config.
 */
import type { TemplateContext } from './types';
import { getHostConfig } from '../../hosts/index';

// Whitelist for query= macro values. Allows alphanumeric, space, hyphen, underscore.
// Anything else (e.g. $, backticks, quotes, ;) is a shell-injection vector when the
// emitted bash interpolates the value into `--query "${queryArg}"`. Static template
// queries hand-written in gstack are safe, but the resolver API must defend against
// future contributors writing dangerous values.
const QUERY_SAFE_RE = /^[A-Za-z0-9 _-]+$/;

/**
 * B5 (#2790): run a learnings search with its stdout intact and its stderr and
 * exit status kept, so a missing bun or a failed script prints why instead of
 * reading as "nothing recorded". Two lines: the capture, then the verdict.
 */
export const learningsCapture = (command: string) => `{ _LE=$(${command} 2>&1 >&3 3>&-); _LR=$?; } 3>&1`;
export const LEARNINGS_VERDICT = `[ "$_LR" = 0 ] || { _LE=\${_LE%%$'\\n'*}; echo "LEARNINGS: unavailable (\${_LE:-exit $_LR})"; }`;

export function generateLearningsSearch(ctx: TemplateContext, args?: string[]): string {
  // Parse query= arg. Empty value falls through to no-query (principle of least surprise:
  // a stray {{LEARNINGS_SEARCH:query=}} placeholder gets today's behavior, not a build error).
  const queryArg = (args || [])
    .filter(a => a.startsWith('query='))
    .map(a => a.slice(6))
    .filter(Boolean)[0];
  if (queryArg && !QUERY_SAFE_RE.test(queryArg)) {
    throw new Error(
      `{{LEARNINGS_SEARCH:query=...}} value must match ${QUERY_SAFE_RE} (alphanumeric, space, hyphen, underscore). Got: ${JSON.stringify(queryArg)}`
    );
  }
  const queryFlag = queryArg ? ` --query "${queryArg}"` : '';
  const findingKind = ctx.skillName === 'qa' || ctx.skillName === 'qa-only' ? 'QA' : 'review';

  if (ctx.skillName === 'qa-only') {
    return `## Prior Learnings

Read this project's existing learnings.jsonl only if its directory is already known
and the caller permits that Read. Otherwise skip this optional lookup.
${queryArg ? `Look for notes matching "${queryArg}".\n` : ''}Do not run gstack-learnings-search here: its slug helper can update a cache.
Do not change configuration, enable cross-project search or create a learning store.

Treat old notes as leads, not proof. When a QA finding matches a past learning,
cite it as "Prior learning applied: [key] (confidence N/10, from [date])" and verify
the current behavior. Reading old notes never requires writing new ones.`;
  }

  if (getHostConfig(ctx.host).learningsMode === 'basic') {
    // Basic learnings mode (host config learningsMode: 'basic' — every host
    // except claude and factory): simpler version, no cross-project prompt,
    // uses $GSTACK_BIN (all basic hosts are env-var hosts)
    return `## Prior Learnings

Search for relevant learnings from previous sessions on this project:

\`\`\`bash
${learningsCapture(`$GSTACK_BIN/gstack-learnings-search --limit 10${queryFlag}`)}
${LEARNINGS_VERDICT}
\`\`\`

If learnings are found, incorporate them into your analysis. When a ${findingKind} finding
matches a past learning, note it: "Prior learning applied: [key] (confidence N, from [date])"`;
  }

  return `## Prior Learnings

Search for relevant learnings from previous sessions:

\`\`\`bash
_CROSS_PROJ=$(${ctx.paths.binDir}/gstack-config get cross_project_learnings 2>/dev/null || echo "unset")
echo "CROSS_PROJECT: $_CROSS_PROJ"
if [ "$_CROSS_PROJ" = "true" ]; then
  ${learningsCapture(`${ctx.paths.binDir}/gstack-learnings-search --limit 10${queryFlag} --cross-project`)}
else
  ${learningsCapture(`${ctx.paths.binDir}/gstack-learnings-search --limit 10${queryFlag}`)}
fi
${LEARNINGS_VERDICT}
\`\`\`

If \`CROSS_PROJECT\` is \`unset\` (first time): ${ctx.skillName === 'plan-eng-review' ? 'Build a full decision brief from these facts and options using the preamble format, then ask and wait:' : 'Use AskUserQuestion:'}

> gstack can search learnings from your other projects on this machine to find
> patterns that might apply here. This stays local (no data leaves your machine).
> Recommended for solo developers. Skip if you work on multiple client codebases
> where cross-contamination would be a concern.

Options:
- A) Enable cross-project learnings (recommended)
- B) Keep learnings project-scoped only

If A: run \`${ctx.paths.binDir}/gstack-config set cross_project_learnings true\`
If B: run \`${ctx.paths.binDir}/gstack-config set cross_project_learnings false\`

Then re-run the search with the appropriate flag.

If learnings are found, incorporate them into your analysis. When a ${findingKind} finding
matches a past learning, display:

**"Prior learning applied: [key] (confidence N/10, from [date])"**

This makes the compounding visible. The user should see that gstack is getting
smarter on their codebase over time.`;
}

export function generateLearningsLog(ctx: TemplateContext): string {
  const binDir = ctx.paths.binDir; // env-var hosts already resolve to $GSTACK_BIN via types.ts

  return `## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

\`\`\`bash
${binDir}/gstack-learnings-log '{"skill":"${ctx.skillName}","type":"TYPE","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"SOURCE","files":["path/to/relevant/file"]}'
\`\`\`

**Types:** \`pattern\` (reusable approach), \`pitfall\` (what NOT to do), \`preference\`
(user stated), \`architecture\` (structural decision), \`tool\` (library/framework insight),
\`operational\` (project environment/CLI/workflow knowledge).

**Sources:** \`observed\` (you found this in the code), \`user-stated\` (user told you),
\`inferred\` (AI deduction), \`cross-model\` (both Claude and Codex agree).

**Confidence:** 1-10. Be honest. An observed pattern you verified in the code is 8-9.
An inference you're not sure about is 4-5. A user preference they explicitly stated is 10.

**files:** Include the specific file paths this learning references. This enables
staleness detection: if those files are later deleted, the learning can be flagged.

**Only log genuine discoveries.** Don't log obvious things. Don't log things the user
already knows. A good test: would this insight save time in a future session? If yes, log it.`;
}
