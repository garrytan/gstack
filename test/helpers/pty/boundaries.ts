/**
 * Per-skill Step-0 / review boundary predicates. Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import type { NativePlanQuestionCall } from '../plan-count-transcript';
import { engCacheWriterDecision } from '../eng-cache-writer-decision';
import { nativePlanCallFingerprint, planCountPrerequisitePick } from './auq';
import type { AskUserQuestionFingerprint, Step0BoundaryPredicate } from './auq';
import { MODE_RE } from './classify';

/**
 * Per-skill Step-0 boundary predicates. Each fires `true` when the answered
 * AUQ's fingerprint matches the LAST question of that skill's Step 0 phase.
 *
 * - `ceoStep0Boundary`: matches the mode-pick AUQ (options match `MODE_RE`).
 * - `engStep0Boundary`: matches the cross-project-learnings or scope-reduction
 *   AUQ that closes plan-eng-review's preamble.
 * - `designStep0Boundary`: matches plan-design-review's first dimension /
 *   posture AUQ.
 * - `devexStep0Boundary`: matches plan-devex-review's persona-selection AUQ.
 *
 * Predicates live alongside the helper so the unit suite can exercise each
 * against synthetic fingerprints (positive AND negative cases). Skill test
 * files import them directly.
 */
export const ceoStep0Boundary: Step0BoundaryPredicate = (fp) =>
  // Mode-pick path (Step 0F): one of HOLD SCOPE / SCOPE EXPANSION / etc.
  fp.options.some((o) => MODE_RE.test(o.label)) ||
  // Skip-interview path: scope-selection AUQ has "Skip interview and plan
  // immediately" — picking it bypasses the rest of Step 0 and routes
  // directly to review-phase. Boundary fires on the scope AUQ itself.
  fp.options.some((o) => /skip\s+interview|plan\s+immediately/i.test(o.label));

/** A closed whole-plan complexity choice sets review scope, not an issue remedy. */
function engWholePlanSetupAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (call?.answered !== true || call.failed !== false || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^Scope$/i.test(q.header.trim()) || q.options.length !== 2 ||
      new Set(q.options.map(o => o.label)).size !== 2 ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1 ||
      fp.options.length !== 2 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      ids[0]![1] !== 'plan-eng-review-scope-challenge') return false;
  const body = q.question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, '').trim().replace(/\s+/g, ' ');
  const counts = /^D\s*\d+\s*[—–:-]\s*This plan introduces ([1-9]\d*) new classes across ([1-9]\d*) files\. Recommend scope reduction before reviewing, or accept the complexity and review as-is\?$/i.exec(body);
  if (!counts || !counts.slice(1).every(n => Number.isFinite(Number(n)))) return false;
  const label = (s: string) => s.trim().replace(/\s*\(recommended\)$/i, '');
  const accept = q.options.find(o => /^Accept complexity\s*[—–-]\s*review as-is$/i.test(label(o.label)));
  const reduce = q.options.find(o => /^Recommend scope reduction first$/i.test(label(o.label)));
  if (!accept || !reduce) return false;
  const description = (s: string) => s.trim().replace(/\s+/g, ' ');
  const accepted = /^Proceed with the full review of all ([1-9]\d*) classes across ([1-9]\d*) files\. Flag any specific overengineering during the Architecture section, but don't block on scope reduction now\. Recommended: the scope smell is already called out in the plan and the review will surface whether it's justified\.$/i.exec(description(accept.description ?? ''));
  return Boolean(accepted && accepted[1] === counts[1] && accepted[2] === counts[2] &&
    /^Propose a minimal version(?: \([^()\n]*\))? and ask the user to confirm before reviewing the full plan\. This risks re-scoping before we understand the full design rationale\.$/i.test(description(reduce.description ?? '')));
}

/** Native setup needs an answered scope decision, not a particular model-chosen qid. */
export const engSetupAUQ: Step0BoundaryPredicate = (fp) => {
  if (engWholePlanSetupAUQ(fp)) return true;
  const call = fp.nativeCall;
  if (!call?.answered || call.failed) return false;
  const answered = call.questions.filter(q => Boolean(call.answers?.[q.question]));
  // A mixed packet containing an answered finding is not wholly setup.
  return answered.length > 0 && answered.every(q => {
    if (!q.options.some(option => option.label === call.answers?.[q.question])) return false;
    const actions = q.options.map(option => option.label.trim().replace(/^[A-Z][.)]\s+/i, ''));
    const id = /<gstack-qid:\s*([a-z0-9-]+)(?:;signal=[a-z0-9-]+)?\s*>/i.exec(q.question)?.[1]?.toLowerCase();
    const body = q.question.replace(/<gstack-qid:[^>]*>/gi, '').trim()
      .replace(/^D\s*\d+\s*[—–:-]\s*/i, '');
    // A finding about one component or a TODO remains substantive even if
    // it cites the plan's size or offers to reduce that individual issue.
    if (/\b(?:issue|finding|gap|TODO)\b/i.test(q.header) ||
        /^(?:(?:architecture|code quality|test|performance|security)\s+)?(?:issue|finding|gap|TODO)\b/i.test(body)) return false;
    const learningPremise = /\bcross[- ]project\s+(?:learnings|lessons)\b|\b(?:learnings|lessons)\b[^.!?]{0,100}\b(?:other|all)\s+(?:projects|repositories)\b/i.test(body);
    const crossProject = id === 'cross-project-learnings' || id === 'preamble-cross-project-learnings' ||
      (!id && /^cross[- ]project$/i.test(q.header.trim())) || learningPremise;
    if (crossProject) {
      return actions.some((enabled, i) =>
        (/^enable\s+cross[- ]project\b/i.test(enabled) ||
          (learningPremise && /^enable(?:\s*\(recommended\))?$/i.test(enabled))) &&
        actions.some((scoped, j) => j !== i && /\bproject[- ]scoped\b/i.test(scoped)));
    }
    // The skill's complexity gate concerns the whole plan and a concrete
    // file/class/service count. Its qid and header can vary across native runs.
    const scopeHeading = /^scope(?:\s+(?:challenge|reduction|complexity))?\s*:/i.test(body);
    const wholePlanStatement = /(?:^|\n)(?:ELI10:\s*)?(?:this|the|whole|entire)\s+plan\s+(?:touches|spans|covers|changes|introduces|involves)\b/i.test(body);
    const wholePlanScope = (/^(?:(?:scope(?:\s+(?:challenge|reduction|complexity))?|complexity\s+check)\s*:\s*)?(?:this|the|whole|entire)\s+plan\s+(?:touches|spans|covers|changes|introduces|involves)\b/i.test(body) ||
        (scopeHeading && wholePlanStatement)) && /\b\d+\s+(?:new\s+)?(?:files|classes|services)\b/i.test(body);
    // The native complexity gate may give the plan's file/class counts
    // directly, without spelling out "this plan touches". Keep that shape
    // tied to a Scope header and the explicit whole-scope opposed action.
    const countedComplexityGate = /^scope$/i.test(q.header.trim()) &&
      (/^complexity\s+check(?:\s+triggered)?\s*:\s*\d+\s+files\b/i.test(body) ||
        /^(?:the\s+)?plan['’]s\s+scope\b[^.!?]{0,180}\bcomplexity(?:\s+smell)?\s+check\b/i.test(body)) &&
      /\b\d+\s+files\b/i.test(body) &&
      /\b\d+\+?\s+(?:new\s+)?(?:classes|services)\b/i.test(body) &&
      actions.some(action => /^reduce\s+scope\b/i.test(action));
    // An explicit Step 0 gate may put the whole-plan size in the native
    // full-scope option instead of repeating it in the question. Keep the
    // step, whole-plan premise and both numeric dimensions bound together.
    const explicitStep0Gate = /^step\s*0\s+scope$/i.test(q.header.trim()) &&
      /^step\s*0\s+scope\s+challenge:\s*(?:this|the)\s+plan\s+triggers\s+(?:the\s+)?complexity\s+gate\b/i.test(body) &&
      q.options.some((option, i) => /^proceed\s+at\s+full\s+scope\b/i.test(actions[i] ?? '') &&
        /\b(?:review|implement)\b[^.!?]{0,60}\bas\s+written\b/i.test(option.description ?? '') &&
        /\b\d+\s+files\b/i.test(option.description ?? '') &&
        /\b\d+\+?\s+(?:new\s+)?(?:classes|services)\b/i.test(option.description ?? ''));
    const scopeComplexity = id === 'plan-eng-scope-complexity' || id === 'plan-eng-review-scope-reduce' || wholePlanScope || countedComplexityGate || explicitStep0Gate;
    return scopeComplexity &&
      actions.some((proceed, i) =>
        (/^proceed\s+(?:as[- ]is|at\s+full\s+scope)\b/i.test(proceed) || /^accept\b.*\bdesign\b.*\bfocus\b.*\bquality\b/i.test(proceed)) &&
        actions.some((reduce, j) => j !== i && /^(?:reduce\b|flag\s+scope\s+reduction\b)/i.test(reduce)));
  });
};

/** A native architecture repair may state the defect without an "issue" label. */
function engExplicitRepairAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length || fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^Architecture$/i.test(q.header.trim()) || q.options.length < 2 ||
      new Set(q.options.map(o => o.label)).size !== q.options.length ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      !/^plan-eng-(?:review-)?arch(?:itecture)?-[a-z0-9-]+$/i.test(ids[0]![1]!) ||
      /(?:^|-)(?:scope|focus|mode|setup|routing|learnings|prerequisite|onboarding|next-steps?)(?:-|$)/i.test(ids[0]![1]!)) return false;
  const body = q.question.replace(/<gstack-qid:[^>]+>/i, '').trim().replace(/\s+/g, ' ');
  const issue = /^D\s*\d+\s*[—–:-]\s*Architecture:\s+((?:shared|a|an|the)\s+[^.!?]+)\s+is a race condition\.\s+How should (?:it be fixed|we fix it)\?$/i.exec(body);
  return Boolean(issue && !/\b(?:false|not|never|no longer|denies?|claim|assertion|example)\b/i.test(issue[1]!));
}

/** A component choice can name its existing defect in an offered remedy. */
function engArchitectureChoiceAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (call?.answered !== true || call.failed !== false || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^(?:Retry arch|Architecture)$/i.test(q.header.trim()) || q.options.length !== 3 ||
      new Set(q.options.map(o => o.label)).size !== 3 ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      !/^plan-eng-(?:review-)?arch(?:itecture)?-retry-scheduler$/i.test(ids[0]![1]!)) return false;
  const body = q.question.replace(/<gstack-qid:[^>]+>/i, '').trim().replace(/\s+/g, ' ');
  if (!/^D\s*\d+\s*[—–:-]\s*Architecture:\s*Custom retry scheduler vs\.? the library['’]s built-in retry hooks\?$/i.test(body)) return false;
  const label = (s: string) => s.trim().replace(/\s*\(recommended\)$/i, '');
  if (!q.options.some(o => /^Use library built-in with curve config$/i.test(label(o.label))) ||
      !q.options.some(o => /^Custom scheduler, shared module$/i.test(label(o.label)))) return false;
  const unchanged = q.options.find(o => /^Proceed as planned\s*[—–-]\s*custom, inline per worker$/i.test(label(o.label)));
  return Boolean(unchanged && /^Each worker gets its own copy of the retry logic\.\s+Completeness:\s*\d+\/10\.\s+Creates \d+ divergence points; acknowledged DRY violation from the start\.$/i.test(unchanged.description ?? ''));
}

/** A closed dependency choice can expose the current plan's coupling in its options. */
function engDependencyBindingAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (call?.answered !== true || call.failed !== false || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^Cache binding$/i.test(q.header.trim()) || q.options.length !== 2 ||
      new Set(q.options.map(o => o.label)).size !== 2 ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1 ||
      fp.options.length !== 2 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      ids[0]![1] !== 'plan-eng-cache-binding') return false;
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ');
  const body = normalize(q.question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, ''));
  const choice = /^D\s*\d+\s*[—–:-]\s*Architecture: How should ([A-Za-z_$][\w$]*) access the cache adapter after scope reduction\?$/i.exec(body);
  if (!choice) return false;
  const label = (s: string) => s.trim().replace(/\s*\(recommended\)$/i, '');
  const injected = q.options.find(o => /^Constructor injection$/i.test(label(o.label)));
  const imported = q.options.find(o => /^Module-level import$/i.test(label(o.label)));
  if (!injected || !imported) return false;
  // Consume both descriptions: the current-plan coupling and the offered
  // alternative must be affirmative, not quoted, conditional, or mixed with new work.
  const core = (s: string) => normalize(s).replace(/ Completeness: (?:10|[0-9])\/10\. \(human: (?:no change|~?\d+(?:\.\d+)?(?:min|h| days?)) \/ CC: (?:no change|~?\d+(?:\.\d+)?(?:min|h))\)$/, '');
  return core(injected.description ?? '') === `${choice[1]} receives the cache adapter as a constructor argument (or factory function parameter). Tests pass a stub; production passes the real adapter. Eliminates module-level mutable state entirely. Requires wiring at the call site.` &&
    core(imported.description ?? '') === `${choice[1]} imports the adapter directly at module scope, same pattern as the current plan. Works fine in production; makes tests require module-level mocking (jest.mock, proxyquire). Matches the existing codebase pattern if that's what's already used.`;
}

/** A direct shared-state risk is a finding even when its qid omits the section name. */
function engSharedMutableCacheAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (call?.answered !== true || call.failed !== false || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^Shared cache$/i.test(q.header.trim()) || q.options.length !== 3 ||
      new Set(q.options.map(o => o.label)).size !== 3 ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1 ||
      fp.options.length !== 3 || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label)) return false;
  const ids = [...q.question.matchAll(/<gstack-qid:([^>]+)>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      ids[0]![1] !== 'plan-eng-shared-mutable-cache') return false;
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ');
  const body = normalize(q.question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, ''));
  const risk = /^D\s*\d+\s*[—–:-]\s*Architecture: Two services share a global mutable ([A-Za-z_$][\w$]*) via module-level export\. This is the #[1-9]\d* reliability risk in multi-tenant auth [—–-] concurrent mutations can corrupt tenant isolation\. How should the plan address this\?$/i.exec(body);
  if (!risk) return false;
  const label = (s: string) => s.trim().replace(/\s*\(recommended\)$/i, '');
  const injected = q.options.find(o => /^Dependency injection$/i.test(label(o.label)));
  const guarded = q.options.find(o => /^Mutation guards on the global$/i.test(label(o.label)));
  const accepted = q.options.find(o => /^Accept as-is, flag as known risk$/i.test(label(o.label)));
  if (!injected || !guarded || !accepted) return false;
  const core = (s: string) => normalize(s).replace(/ Completeness: (?:10|[0-9])\/10\.$/, '');
  const remedy = /^The plan is updated to pass ([A-Za-z_$][\w$]*) as a constructor argument to both ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*)\. No module-level mutable export\. Tests can inject a mock\/stub\. Single shared instance still possible at the app root\.$/.exec(core(injected.description ?? ''));
  return Boolean(remedy && remedy[1] === risk[1] && remedy[2] !== remedy[3] &&
    core(guarded.description ?? '') === 'Keep the global export but wrap every mutation site in explicit locking or compare-and-swap. Safer than bare shared state but still couples both services to the global. Adds concurrency primitives that need their own tests.' &&
    core(accepted.description ?? '') === 'Note the shared-global pattern in the review report as a known risk. Leave the plan unchanged. Suitable only if the runtime is single-threaded and concurrent mutation is architecturally impossible.');
}

/** A completed explicit issue retains its identity when question tuning omits qids. */
function engNumberedFindingAUQ(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      Object.keys(call.answers ?? {}).length !== 1 ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0) ||
      !Number.isFinite(Date.parse(call.answeredAt ?? ''))) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
      new Set(q.options.map(o => o.label)).size !== q.options.length ||
      q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1 ||
      fp.options.length !== q.options.length || !fp.options.every((o, i) => o.index === i + 1 && o.label === q.options[i]!.label) ||
      /<gstack-qid/i.test(q.question)) return false;
  const title = q.question.split('\n')[0]!.replace(/^D[1-9]\d*\s*[—–:-]\s*/i, '');
  // A declarative severity-labelled issue can own the same cache repair as
  // an interrogative title. Require its native decision, current assessment,
  // and opposed implementation options; metadata alone never opens review.
  const declaredCache = /^(?:Issue|Finding) ([1-9]\d*) \[(?:P[0-3]|CRITICAL|INFORMATIONAL)\] \(confidence (?:10|[1-9])\/10\) [A-Za-z][\w./-]*:[1-9]\d*(?:-[1-9]\d*)?: ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) share a global mutable ([A-Za-z_$][\w$]*) via module-level export, and both mutate it\.$/.exec(title);
  if (declaredCache) return engDeclaredCacheFinding(q, declaredCache);
  if (engCacheWriterDecision(q)) return true;
  const libraryHooks = engLibraryHooksFinding(q, title);
  if (libraryHooks !== undefined) return libraryHooks;
  // A cache-ownership brief can name its actors in the current assessment
  // instead of the headline. Bind those actors to the offered single writer.
  const cacheOwner = /^(?:Issue|Finding) ([1-9]\d*): two services mutate (?:one|the same) shared cache with no (?:serialized writes|serialization)\. How should cache ownership work\?$/i.exec(title);
  if (cacheOwner) return engCacheOwnerFinding(q, cacheOwner);
  // A descriptive native header can carry the decision ordinal while the
  // current brief owns the architecture finding and its cache remedy.
  const injected = /^Module-level ([A-Za-z_$][\w$]*) singleton (?:→|->) constructor injection with a single writer\?$/i.exec(title);
  if (injected) return engInjectedSingletonFinding(q, injected);
  // The category can live in the title while the header carries the issue
  // number. Require the direct shared-state defect and technical choices;
  // an Issue heading on setup or report navigation is insufficient.
  const sharedWriters = /^(Issue|Finding)\s+([1-9]\d*(?:\.[1-9]\d*)*)\s+\(Architecture\)\s*[—–:-]\s*([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) both mutate (?:one|the same) shared cache with no owner and no serialization\. How should shared[- ]state access be structured\?$/i.exec(title);
  if (sharedWriters) return engSharedWritersFinding(q, sharedWriters);
  const issue = /^(?:Issue|Finding)\s+([1-9]\d*(?:\.[1-9]\d*)*)(?:\s*\(D[1-9]\d*\))?\s*[—–:-]\s*([^\n?]+\?)$/i.exec(title);
  const header = /^(?:Arch(?:itecture)?|Code\s+Q(?:uality)?|Tests?|Perf(?:ormance)?)\s+([1-9]\d*(?:\.[1-9]\d*)*)$/i.exec(q.header.trim());
  if (!issue || !header || issue[1] !== header[1]) return false;
  // A title number or verb can also label report administration. Keep the
  // concrete defect, implementation query and offered technical alternatives
  // together. Unknown issue families remain on the existing qid paths.
  const label = (s: string) => s.trim().replace(/^[1-9]\d*[A-Z]\)\s*/i, '').replace(/\s*\(recommended\)$/i, '');
  const alternatives = (a: RegExp, b: RegExp) => [a, b].every(pattern =>
    q.options.some(option => pattern.test(label(option.label)) && Boolean(option.description?.trim())));
  const body = issue[2]!;
  // An imperative can ask for the same owned cache amendment that the older
  // numbered form states as a defect. Bind the current actors and both offered
  // outcomes; an Issue label or the word "inject" cannot open review alone.
  const injectedExport = /^Replace the module-level mutable ([A-Za-z_$][\w$]*) export with injected ownership\?$/i.exec(body);
  if (injectedExport) return engInjectedExportFinding(q, issue, injectedExport);
  return (
    /^[A-Za-z_$][\w$]* is a (?:global|shared) mutable module-level export that (?:two|multiple|\d+) services mutate\. Inject it(?: instead)?\?$/i.test(body) &&
      alternatives(/^Constructor[- ]inject$/i, /^Getter \+ reset hook$/i)
  ) || (
    /^Two writers, no serialization: an? [A-Za-z_$][\w$]* write can land after an? [A-Za-z_$][\w$]* invalidation and resurrect a revoked token\. (?:Guard it|Serialize the writes)\?$/i.test(body) &&
      alternatives(/^Invalidation epoch in [A-Za-z_$][\w$]*$/i, /^Re-check before write$/i)
  ) || (
    /^[A-Za-z_$][\w$]*\(\) is \d+ lines with (?:two|three|multiple|\d+) nested try\/catch blocks that each swallow a different error class\. Restructure it\?$/i.test(body) &&
      alternatives(/^Split \+ typed Result$/i, /^Flatten \+ log$/i)
  ) || (
    /^Planned coverage is unit \+ integration on the new components only\. Add an? end-to-end [\w -]+ test across (?:two|multiple|\d+) tenants\?$/i.test(body) &&
      alternatives(/^Add E2E journey test$/i, /^Facade isolation test only$/i)
  ) || (
    /^Token validation makes \d+ sequential [A-Za-z_$][\w$]* calls that are independent\. Parallelize, and with what failure semantics\?$/i.test(body) &&
      alternatives(/^Promise\.all \+ timeouts \+ typed errors$/i, /^Bare Promise\.all$/i)
  );
}

/** Declarative severity-labelled shared-cache issue (see engNumberedFindingAUQ). */
function engDeclaredCacheFinding(q: NativePlanQuestionCall['questions'][number], declaredCache: RegExpExecArray): boolean {
  if (!/^Shared cache$/i.test(q.header.trim()) || declaredCache[2] === declaredCache[3]) return false;
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedCache = escaped(declaredCache[4]!);
  const decision = /^D([1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1];
  const owner = `(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|risk)|(?:Issue|Finding) ${declaredCache[1]}${decision ? `|D${decision}` : ''})`;
  const boundary = '(?:^|[.!?;]\\s+|\\n|[✅❌]\\s*)(?:Correction:\\s*)?';
  const scalarOwner = new RegExp(`${boundary}${owner} (?:is|was|has been) (?:(?:now|already) )?$`, 'i');
  const current = (value: string) => value
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(/"[^"\n]*"|“[^”\n]*”|(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’|`(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current|no longer current)`/gi,
      (quoted: string, index: number, source: string) =>
        /^(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current|no longer current)$/i.test(quoted.slice(1, -1)) &&
        scalarOwner.test(source.slice(0, index)) ? quoted.slice(1, -1) : '')
    .replace(/`([^`\n]*)`/g, (_, code: string) => /^[A-Za-z_$][\w$]*$/.test(code) ? code : '')
    .replace(/\*\*/g, '');
  const framed = /\b(?:source|quoted|historical|hypothetical|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|material|text)\b|(?:^|[.!?;:]\s+|\n|[✅❌]\s*)(?:if|when|unless|provided|assuming|suppose|imagine|source|example)\b/i;
  const closed = new RegExp(`${boundary}${owner} (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b|${boundary}no current (?:gap|risk|finding) (?:remains|exists)\\b`, 'i');
  const removed = new RegExp(`${boundary}(?:(?:${escapedCache}|(?:the|this|that) (?:cache|export|global|writers?|writes?|services?)) (?:is|are|has been|have been) (?:no longer (?:global|mutable|shared|unordered)|(?:now |already )?(?:ordered|serialized|removed))|(?:${escaped(declaredCache[2]!)}|${escaped(declaredCache[3]!)}|(?:the|this|both) services?) no longer (?:share|mutate|write)[a-z]*)\\b`, 'i');
  const cancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:inject|receive|remove|delete|serialize|order|keep|proceed|accept)\b/i;
  const inactive = (value: string) => framed.test(value) || closed.test(value) || cancelled.test(value);
  const text = current(q.question), assessment = [...text.matchAll(/^ELI10: (.+)$/gm)];
  const preface = text.slice(text.indexOf('\n') + 1, assessment[0]?.index ?? 0).trim().split('\n').filter(Boolean);
  if (assessment.length !== 1 || preface.length !== 1 ||
      !/^Project\/branch\/task: \S[^\n]*\bSection [1-9]\d* Architecture\b/.test(preface[0]!) ||
      !/^Two services write to the same cache through a global variable\./.test(assessment[0]![1]!) ||
      !/\b(?:writes can interleave|no ordering|unordered writes)\b/.test(assessment[0]![1]!) || inactive(text) ||
      removed.test(text)) return false;
  const optionIds = q.options.map(o => /^([1-9]\d*)([A-D])[:.)]\s+(\S[\s\S]*)$/.exec(o.label));
  if (optionIds.some(id => id?.[1] !== declaredCache[1]) || new Set(optionIds.map(id => id![2])).size !== q.options.length) return false;
  const actions = optionIds.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
  return q.options.some((remedy, index) => {
    if (!new RegExp(`^Inject ${escapedCache};`).test(actions[index]!)) return false;
    const body = current(remedy.description ?? '').trim();
    if (inactive(body) ||
        !new RegExp(`^✅\\s*Both services receive the one ${escapedCache} instance via constructor; the module export goes away\\b`).test(body) ||
        !new RegExp(`✅\\s*${escapedCache} exposes only [^✅❌.!?]{1,180} and serializes writes per key\\b`).test(body) ||
        /\b(?:module export (?:stays|remains|is retained)|writes (?:remain|stay) unordered|(?:do not|never) serialize)\b/i.test(body)) return false;
    return q.options.some((opposed, other) => other !== index && /^Proceed as written$/i.test(actions[other]!) &&
      !inactive(current(opposed.description ?? '')) && !removed.test(current(opposed.description ?? '')) &&
      new RegExp(`❌\\s*Ships an? (?:auth cache|${escapedCache}) with two unordered writers and shared test state\\b`).test(current(opposed.description ?? '')) &&
      !/\b(?:risk|race) (?:is |has been )?(?:resolved|closed|fixed)|\bno (?:race|risk) remains\b/i.test(current(opposed.description ?? '')));
  });
}

/** Custom scheduler vs library retry hooks; undefined when the title is another family. */
function engLibraryHooksFinding(q: NativePlanQuestionCall['questions'][number], title: string): boolean | undefined {
// The category may precede the issue number. Bind this library choice to
// the current scheduling defect and both concrete outcomes, not its label.
const declaredLibraryHooks = /^Issue ([1-9]\d*): Custom inline scheduler vs\. the job library's built-in retry hooks \([A-Za-z][\w./-]*:[1-9]\d*(?:-[1-9]\d*)?\)$/i.exec(title);
const implicitLibraryHooks = /^D([1-9]\d*)\s*[—–:-]\s*Custom inline backoff scheduler vs the job library's built-in retry hooks$/i.exec(q.question.split('\n')[0]!);
const scopedLibraryHooks = /^Issue ([1-9]\d*): custom inline scheduler per worker, or the job library's retry hook with a custom curve\?$/i.exec(title) ?? implicitLibraryHooks;
const libraryHooks = /^Architecture issue ([1-9]\d*): custom inline scheduler vs the job library's built-in retry hooks\?$/i.exec(title) ?? declaredLibraryHooks ?? scopedLibraryHooks;
if (!libraryHooks) return undefined;
  if (!(implicitLibraryHooks ? /^Architecture$/i : new RegExp(`^${declaredLibraryHooks ? 'Issue' : 'Arch(?:itecture)?'} ${libraryHooks[1]}$`, 'i')).test(q.header.trim())) return false;
  const ordinal = (declaredLibraryHooks || scopedLibraryHooks) && /^D([1-9]\d*)\s*[—–:-]/.exec(q.question)?.[1];
  const declaredOwner = `(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|deferral|(?:unchanged )?risk)|Issue ${libraryHooks[1]}${ordinal ? `|D${ordinal}` : ''})`;
  const declaredBoundary = '(?:^|[.!?;]\\s+|\\n|[✅❌]\\s*)(?:Correction:\\s*)?';
  const scalarOwner = new RegExp(`${declaredBoundary}${declaredOwner} (?:is|was|has been) (?:(?:now|already) )?$`, 'i');
  const current = (text: string) => {
    const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/^(?:\s*>| {4}|\t).*$/gm, '');
    if (declaredLibraryHooks || scopedLibraryHooks) return prose.replace(/\*\*/g, '')
      .replace(/"[^"\n]*"|“[^”\n]*”|(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|‘[^’\n]*’|`[^`\n]*`/g,
        (quoted: string, at: number, source: string) => {
          const status = /^["“'‘`](withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)["”'’`]$/i.exec(quoted);
          return status && scalarOwner.test(source.slice(0, at)) ? status[1]! : '';
        }).replace(/\*\*/g, '');
    return prose
      .replace(/["“](withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current|no longer current)["”]/gi, '$1')
      .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, '')
      .replace(/\*\*/g, '');
  };
  const framed = /\b(?:source|quoted|historical|hypothetical|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|material|text)\b|(?:^|[.!?;:]\s+|\n|[✅❌]\s*)(?:if|when|unless|provided|assuming|suppose|imagine|source|example)\b/i;
  const closed = new RegExp(`\\b(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|deferral|(?:unchanged )?risk)|Issue ${libraryHooks[1]}) (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b|\\bno current (?:gap|risk|finding) (?:remains|exists)\\b`, 'i');
  const text = current(q.question), lines = text.split('\n');
  const contexts = lines.filter(line => /^Project\/branch\/task: \S/.test(line));
  const assessments = [...text.matchAll(/^ELI10: (.+)$/gm)];
  const preface = text.slice(0, assessments[0]?.index ?? 0).split('\n').filter(line => line.trim()).slice(1);
  // A crash consequence explains the current defect; approval conditions
  // still suspend the owned decision and are checked below.
  const framingText = scopedLibraryHooks ? text.replace(/(?:^|[.!?]\s+)If (?:that|the|this) (?:worker )?process (?:dies|restarts|crashes)\b[^.!?\n]*[.!?]?/gi, '') : text;
  if (contexts.length !== 1 || assessments.length !== 1 || preface.length !== 1 || preface[0] !== contexts[0] ||
      framed.test(framingText) || closed.test(text) || /\b(?:the|this) plan no longer rebuilds retry scheduling\b|\bretry scheduling no longer runs inside each worker\b/i.test(text)) return false;
  const assessment = assessments[0]![1]!;
  // A declarative issue with a source location can own the same concrete
  // scheduling decision. Bind the assessment and each offered outcome;
  // the issue number and source location alone do not begin review.
  if (declaredLibraryHooks || scopedLibraryHooks) {
    const ownClosed = new RegExp(`${declaredBoundary}${declaredOwner} (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b`, 'i');
    // Read approval clauses in the original text, including an owned
    // condition after a crash premise or after an option's tradeoffs.
    const approvalBoundary = scopedLibraryHooks ? `(?:${declaredBoundary}|,\\s+)` : declaredBoundary;
    const approvalPremise = scopedLibraryHooks ? '(?:(?:if|when|once) (?:approved|accepted)|(?:assuming|provided) (?:approval|acceptance))' : '(?:if|when|once) (?:approved|accepted)';
    const conditional = new RegExp(`${approvalBoundary}(?:${declaredOwner} (?:(?:applies|holds) (?:only )?(?:if|when|once|unless) (?:approved|accepted)|is (?:conditional|contingent|dependent) on (?:approval|acceptance)|requires (?:approval|acceptance))|${approvalPremise},? (?:use|adopt|accept|keep|proceed|choose|preserve)\\b)`, 'i');
    if (ownClosed.test(text) || conditional.test(text)) return false;
    if (scopedLibraryHooks) {
      const workers = /(?:^|[.!?]\s+)The plan writes its own\s+loop inside each of the ([1-9]\d*) workers\./i.exec(assessment)?.[1] ??
        /(?:^|[.!?]\s+)The plan says \([A-Za-z][\w./-]*:[1-9]\d*(?:-[1-9]\d*)?\) to ignore it and hand-roll a scheduler inside each of the ([1-9]\d*) workers\b/i.exec(assessment)?.[1];
      if (!workers || Number(workers) < 2) return false;
      const ids = q.options.map(o => /^([1-9]\d*)([A-D])[).:]\s+(\S[\s\S]*)$/.exec(o.label));
      if (ids.some(id => id?.[1] !== libraryHooks[1]) || new Set(ids.map(id => id![2])).size !== q.options.length) return false;
      const actions = ids.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
      const repair = actions.findIndex(action => /^Library hooks? \+ (?:custom curve|shared backoff fn)$/i.test(action));
      const keep = actions.findIndex(action => /^Custom inline scheduler as planned$/i.test(action) ||
        new RegExp(`^Proceed as planned \\(inline in ${workers} workers\\)$`, 'i').test(action));
      if (repair < 0 || keep < 0 || repair === keep) return false;
      const remedy = current(q.options[repair]!.description ?? '').trim(), unchanged = current(q.options[keep]!.description ?? '').trim();
      const cancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:use|accept|keep|proceed|adopt|choose|preserve|register)\b/i;
      if ([remedy, unchanged].some(value => framed.test(value.split('❌')[0]!) || closed.test(value) || ownClosed.test(value) || conditional.test(value) || cancelled.test(value)) ||
          /\bthe library will not own (?:persistence|attempt counting|crash safety)\b/i.test(remedy) ||
          /\b(?:the|this) (?:unchanged |per-worker )?scheduler is (?:now |already )?crash-safe\b|\bretry state no longer lives in-process\b/i.test(unchanged)) return false;
      const persisted = /^(?:✅\s*)?Retry state persisted by the library: [^.!?✅❌]*\bsurvives\b[^.!?✅❌]*\b(?:crash|restart|deploy)\b[^.!?✅❌]*/i.exec(remedy);
      const registered = /^Register the library's retry hook in each worker, pass one shared pure [A-Za-z_$][\w$]*\(attempt\) for the curve\./i.test(remedy);
      const lost = /(?:^|❌\s*)Retry state lives in process memory: [^.!?✅❌]*\b(?:crash|restart)\b[^.!?✅❌]*\b(?:drops|loses)\b[^.!?✅❌]*\b(?:job|retry|retries)\b/i.exec(unchanged);
      const drift = /^Keep the plan as written\.[\s\S]*?\bRetries die with the process; ([a-z]+|[1-9]\d*) copies drift\./i.exec(unchanged);
      const count = drift && (/^[1-9]\d*$/.test(drift[1]!) ? Number(drift[1]) :
        ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(drift[1]!.toLowerCase()));
      return Boolean((registered || (persisted && !/\b(?:not|never|no longer)\b/i.test(persisted[0]))) &&
        ((lost && !/\b(?:not|never|no longer)\b/i.test(lost[0])) || (drift && count === Number(workers))));
    }
    if (!/^The job library already knows how to retry a failed job later; you just tell it how long to wait\. The plan instead rebuilds that waiting-and-rescheduling machinery by hand inside each worker\./.test(assessment) ||
        !/\bjobs get lost \(worker dies mid-sleep\)/.test(assessment) ||
        !/\bno attempt cap or dead-letter path\b/.test(assessment)) return false;
    const ids = q.options.map(o => /^([1-9]\d*)([A-D])[).:]\s+(\S[\s\S]*)$/.exec(o.label));
    if (ids.some(id => id?.[1] !== libraryHooks[1]) || new Set(ids.map(id => id![2])).size !== q.options.length) return false;
    const actions = ids.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
    const remedyIndex = actions.indexOf('Use library retry hook + custom curve fn');
    const unchangedIndex = actions.indexOf('Custom scheduler inline per worker, as planned');
    if (remedyIndex < 0 || unchangedIndex < 0 || remedyIndex === unchangedIndex) return false;
    const remedy = current(q.options[remedyIndex]!.description ?? '').trim();
    const unchanged = current(q.options[unchangedIndex]!.description ?? '').trim();
    const cancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:use|accept|keep|proceed|adopt|choose|preserve)\b/i;
    if ([remedy, unchanged].some(value => framed.test(value.split("❌")[0]!) || closed.test(value) || ownClosed.test(value) || conditional.test(value) || cancelled.test(value)) ||
        /\bthe library will not own (?:persistence|attempt counting|crash safety)\b/i.test(remedy) ||
        /\b(?:the|this) (?:unchanged |per-worker )?scheduler is (?:now |already )?crash-safe\b|\bretry state no longer lives in-process\b/i.test(unchanged)) return false;
    return /^✅\s*Persistence, attempt counting, max-attempts, and dead-letter come from the library; you own only delay\(attempt\) with full jitter\b/.test(remedy) &&
      /✅\s*Curve is still 100% yours: a pure function, trivially unit-tested\./.test(remedy) &&
      /❌\s*Retry state lives in-process, so a crash or deploy mid-backoff drops the retry; (?:[a-z]+|[1-9]\d*) copies of scheduler logic drift\b/.test(unchanged);
  }
  const workers = /^The plan rebuilds retry scheduling by hand inside each of ([1-9]\d*) workers\b/.exec(assessment)?.[1];
  if (!workers || Number(workers) < 2 ||
      !/\bpersisting attempt counts across process restarts, not double-scheduling when a worker crashes mid-dispatch\b/.test(assessment) ||
      !/\bthe plan does not mention any of it\./.test(assessment)) return false;
  const optionIds = q.options.map(o => /^([1-9]\d*)([A-D])[:.)]\s+(\S[\s\S]*)$/.exec(o.label));
  if (optionIds.some(id => id?.[1] !== libraryHooks[1]) || new Set(optionIds.map(id => id![2])).size !== q.options.length) return false;
  const actions = optionIds.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
  const remedyIndex = actions.indexOf('Library hooks + custom backoff fn');
  const unchangedIndex = actions.indexOf('Proceed as written (inline in each worker)');
  if (remedyIndex < 0 || unchangedIndex < 0 || remedyIndex === unchangedIndex) return false;
  const remedy = current(q.options[remedyIndex]!.description ?? '').trim();
  const unchanged = current(q.options[unchangedIndex]!.description ?? '').trim();
  const cancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:use|accept|keep|proceed|adopt|choose)\b/i;
  if (framed.test(remedy) || framed.test(unchanged) || closed.test(remedy) || closed.test(unchanged) ||
      cancelled.test(remedy) || cancelled.test(unchanged) ||
      /\bthe library will not own (?:attempt counting|crash safety)\b|\b(?:do not|don't|never|cancel|withdraw) preserve the exported backoff function\b/i.test(remedy) ||
      /\bthe unchanged per-worker scheduler is (?:now )?crash-safe\b/i.test(unchanged)) return false;
  const risk = /❌\s*([A-Za-z]+|[1-9]\d*) copies of crash-unsafe scheduling logic, each drifting independently; every bug gets fixed ([A-Za-z]+|[1-9]\d*) times\./.exec(unchanged);
  const number = (value: string) => /^[1-9]\d*$/.test(value) ? Number(value) :
    ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(value.toLowerCase());
  return Boolean(risk && number(risk[1]!) === Number(workers) && number(risk[2]!) === Number(workers) &&
    /✅\s*Attempt counting, crash safety, and dashboard visibility come from the library for free\./.test(remedy) &&
    /✅\s*The backoff curve lives in one exported function, so\s+is preserved and testable in isolation\./.test(remedy));
}

/** Cache-ownership brief whose actors live in the current assessment. */
function engCacheOwnerFinding(q: NativePlanQuestionCall['questions'][number], cacheOwner: RegExpExecArray): boolean {
  if (!/^(?:Cache owner(?:ship)?|Shared cache)$/i.test(q.header.trim()) &&
      !new RegExp(`^(?:Issue|Finding|Architecture) ${cacheOwner[1]}$`, 'i').test(q.header.trim())) return false;
  const current = (text: string) => text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(/["“](withdrawn|rejected|cancelled|canceled|resolved|closed|not current)["”]/gi, '$1')
    .replace(/"[^"\n]*"|“[^”\n]*”|`[^`]*`/g, '');
  const framing = /\b(?:source|quoted|historical|hypothetical|proposed|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|text)\b|(?:^|\n|:\s*)(?:if|unless|suppose|imagine)\b/i;
  const withdrawn = new RegExp(`\\b(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|race|single-writer requirement)|Issue ${cacheOwner[1]}) (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b|\\bno current (?:gap|defect|finding) (?:remains|exists)\\b`, 'i');
  const text = current(q.question), assessments = [...text.matchAll(/^ELI10: (.+)$/gm)];
  const prefix = text.slice(text.indexOf('\n') + 1, assessments[0]?.index ?? 0).trim().split('\n').filter(Boolean);
  const actors = assessments.length === 1 && /^([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) both (?:write into|mutate) the same (?:tenant-keyed )?cache, and the plan says nothing orders those writes\./.exec(assessments[0]![1]!);
  if (!actors || actors[1] === actors[2] || !prefix.length ||
      !prefix.every(line => /^Project\/branch\/task:/.test(line)) || framing.test(text) || withdrawn.test(text)) return false;
  const ids = q.options.map(option => /^([A-D])\)\s+/.exec(option.label)?.[1]);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) return false;
  const active = (description: string) => !framing.test(description) && !withdrawn.test(description) &&
    !/(?:^|[.!?]\s+)(?:Correction:\s*)?(?:do not|don't|never|cancel|withdraw) (?:inject|use|keep|apply)\b/i.test(description);
  return q.options.some(remedy => {
    const body = current(remedy.description ?? '').trim();
    const owner = /^Constructor-inject the existing adapter into both services\. Only ([A-Za-z_$][\w$]*) writes; ([A-Za-z_$][\w$]*) returns minted material to the broker, which stores it\./.exec(body);
    if (!owner || owner[1] === owner[2] || ![actors[1], actors[2]].includes(owner[1]) ||
        ![actors[1], actors[2]].includes(owner[2]) || !active(body)) return false;
    const otherWriter = new RegExp(`(?:^|[.!?]\\s+)(?:Correction:\\s*)?${owner[2]} (?:will |can |may |still )?(?:also )?write(?:s)? (?:directly )?(?:to|into) (?:the )?cache\\b`, 'i');
    if (otherWriter.test(body)) return false;
    return q.options.some(opposed => opposed !== remedy &&
      /^(?:[A-D]\) )?Keep (?:the )?module-level global as planned(?: \(recommended\))?$/i.test(opposed.label) &&
      /^Do nothing here; both services import and mutate the singleton\./.test(current(opposed.description ?? '').trim()) &&
      /❌\s*Race stays open and tests share mutable state across the whole suite\./.test(current(opposed.description ?? '')) &&
      active(current(opposed.description ?? '')));
  });
}

/** Module-level singleton to constructor injection with a single writer. */
function engInjectedSingletonFinding(q: NativePlanQuestionCall['questions'][number], injected: RegExpExecArray): boolean {
  const ordinal = /^D([1-9]\d*)\s*[—–:-]/i.exec(q.question);
  if (!ordinal || !new RegExp(`^D${ordinal[1]} DI$`, 'i').test(q.header.trim())) return false;
  const current = (text: string) => text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(/["“](withdrawn|rejected|cancelled|canceled|resolved|closed|not current)["”]/gi, '$1')
    .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|`[^`]*`/g, '');
  const text = current(q.question), assessment = [...text.matchAll(/^ELI10: (.+)$/gm)];
  const preface = text.slice(text.indexOf('\n') + 1, assessment[0]?.index ?? 0).trim().split('\n').filter(Boolean);
  const framing = /\b(?:source|quoted|historical|hypothetical|proposed|unrelated|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|text)\b|(?:^|\n)\s*(?:if|unless|suppose|imagine)\b/i;
  const finding = /\bArchitecture finding (A[1-9]\d*)\b/.exec(preface.join(' '));
  const closed = /\b(?:this|the|that) (?:finding|issue|gap|remedy|amendment|explanation|assessment) (?:is|was|has been) (?:withdrawn|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\b|\bno current (?:gap|defect|finding) (?:remains|exists)\b|\bno longer (?:share|write|mutate)\b/i;
  if (assessment.length !== 1 || !finding || !preface.length ||
      !preface.every(line => /^Project\/branch\/task:/.test(line)) || framing.test(preface.join(' ')) ||
      /\b(?:if|unless|when|suppose|imagine)\b/i.test(preface.join(' ').slice(0, finding.index)) ||
      !q.question.split('\n').some(line => /^Project\/branch\/task:/.test(line) && new RegExp(`\\b${injected[1]}\\b`).test(line)) ||
      !/^(?:Right now|Today) both services (?:grab|import) the same global cache (?:object|instance) from a module import and both (?:write to|mutate) it\./i.test(assessment[0]![1]!) ||
      framing.test(assessment[0]![1]!) || closed.test(text)) return false;
  const letters = q.options.map(o => /^([A-D])\)\s+/.exec(o.label)?.[1]);
  const recommendation = /^Recommendation: ([A-D]) because\b/m.exec(text)?.[1];
  if (letters.some(letter => !letter) || new Set(letters).size !== letters.length ||
      !recommendation || !letters.includes(recommendation) ||
      q.options.filter(o => /\(recommended\)/i.test(o.label)).length !== 1 ||
      !q.options[letters.indexOf(recommendation)]!.label.toLowerCase().includes('(recommended)')) return false;
  const affirmative = (option: typeof q.options[number]) => {
    const body = current(option.description ?? '').trim();
    if (!/^✅/.test(body) || framing.test(body) || closed.test(body)) return [];
    return [...body.matchAll(/✅\s*([^✅❌]+)/g)].map(m => m[1]!.trim()).filter(pro =>
      !/^(?:if|unless|when|source|historical|hypothetical|example|previously)\b/i.test(pro));
  };
  const remedy = q.options.find(o => /^[A-D]\) Composition-root injection, single writer(?: \(recommended\))?$/i.test(o.label));
  const unchanged = q.options.find(o => /^[A-D]\) Do nothing(?: \(recommended\))?$/i.test(o.label));
  const owner = remedy && affirmative(remedy).map(pro => /^([A-Za-z_$][\w$]*) is the only session writer and ([A-Za-z_$][\w$]*) gets a read-only port, enforced by types not convention\./.exec(pro)).find(Boolean);
  const remaining = unchanged && current(unchanged.description ?? '').trim();
  return Boolean(owner && owner[1] !== owner[2] && remaining && /^✅/.test(remaining) &&
    !framing.test(remaining) && !closed.test(remaining) &&
    new RegExp(`❌\\s*Both ${finding[1]} failure scenarios stay live and the plan's own test coverage cannot isolate state\\.$`).test(remaining));
}

/** Category in the title, issue number in the header: two writers on one shared cache. */
function engSharedWritersFinding(q: NativePlanQuestionCall['questions'][number], sharedWriters: RegExpExecArray): boolean {
  const header = /^(Issue|Finding)\s+([1-9]\d*(?:\.[1-9]\d*)*)$/i.exec(q.header.trim());
  if (!header || header[1]!.toLowerCase() !== sharedWriters[1]!.toLowerCase() ||
      header[2] !== sharedWriters[2] || sharedWriters[3] === sharedWriters[4] || q.options.length !== 3 ||
      q.options.some(option => !option.description?.trim())) return false;
  const labels = q.options.map(option => option.label.trim()
    .replace(/^[1-9]\d*[A-Z]\)\s*/i, '').replace(/\s*\(recommended\)$/i, ''));
  return [
    /^Constructor[- ]inject the adapter; single[- ]writer ownership per operation; per[- ]key serialization on the [A-Za-z][\w-]* path; race test$/i,
    /^Constructor[- ]inject the adapter only; both services keep writing freely$/i,
    /^Keep the module[- ]level shared export as planned$/i,
  ].every(pattern => labels.filter(label => pattern.test(label)).length === 1);
}

/** Imperative form of the injected-ownership cache amendment. */
function engInjectedExportFinding(q: NativePlanQuestionCall['questions'][number], issue: RegExpExecArray, injectedExport: RegExpExecArray): boolean {
  if (!/^[1-9]\d*$/.test(issue[1]!) || !/^Arch(?:itecture)? [1-9]\d*$/i.test(q.header.trim())) return false;
  const current = (text: string) => text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^(?:\s*>| {4}|\t).*$/gm, '')
    .replace(/["“](withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|not current|no longer current)["”]/gi, '$1')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, '')
    .replace(/`([^`\n]*)`/g, (_, code: string) => /^[A-Za-z_$][\w$]*$/.test(code) ? code : '')
    .replace(/\*\*/g, '');
  const framed = /\b(?:source|quoted|historical|hypothetical|earlier|previous)\s+(?:review\s+)?(?:example|excerpt|assessment|finding|material|text)\b|(?:^|[.!?;:]\s+|\n|[✅❌]\s*)(?:if|when|unless|provided|assuming|suppose|imagine|source|example)\b/i;
  const closed = new RegExp(`\\b(?:(?:this|the|that) (?:finding|issue|gap|remedy|amendment|assessment|option|deferral|(?:unchanged )?risk)|Issue ${issue[1]}) (?:is|was|has been) (?:(?:now|already) )?(?:withdrawn|superseded|rejected|cancelled|canceled|resolved|closed|hypothetical|not current|no longer current)\\b|\\bno current (?:gap|risk|finding) (?:remains|exists)\\b`, 'i');
  const removedGlobal = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:this|the|that) cache no longer has a module-level mutable export\b/i;
  const text = current(q.question), lines = text.split('\n');
  const contexts = lines.filter(line => /^Project\/branch\/task: \S/.test(line));
  const assessments = [...text.matchAll(/^ELI10: (.+)$/gm)];
  const preface = text.slice(0, assessments[0]?.index ?? 0).split('\n').filter(line => line.trim()).slice(1);
  if (contexts.length !== 1 || assessments.length !== 1 || preface.length !== 1 || preface[0] !== contexts[0] ||
      framed.test(text) || closed.test(text) || removedGlobal.test(text)) return false;
  const assessment = assessments[0]![1]!;
  if (!/^(?:Right now|Today) the cache is a global variable that two different services reach into and change\./i.test(assessment)) return false;
  const actors = /\ba bug in ([A-Za-z_$][\w$]*) can silently corrupt what ([A-Za-z_$][\w$]*) reads\./.exec(assessment);
  if (!actors || actors[1] === actors[2]) return false;
  const optionIds = q.options.map(o => /^([1-9]\d*)([A-D])[:.)]\s+(\S[\s\S]*)$/.exec(o.label));
  if (optionIds.some(id => id?.[1] !== issue[1]) || new Set(optionIds.map(id => id![2])).size !== q.options.length) return false;
  const actions = optionIds.map(id => id![3]!.replace(/\s*\(recommended\)$/i, ''));
  const remedyIndex = actions.indexOf(`Inject ${injectedExport[1]}`), unchangedIndex = actions.indexOf('Do nothing');
  if (remedyIndex < 0 || unchangedIndex < 0 || remedyIndex === unchangedIndex) return false;
  const remedy = current(q.options[remedyIndex]!.description ?? '').trim();
  const unchanged = current(q.options[unchangedIndex]!.description ?? '').trim();
  const removalCancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) (?:delete|remove) the module-level export\b/i;
  const acceptanceCancelled = /(?:^|[.!?;]\s+|\n|\bCorrection:\s*)(?:do not|don't|never|skip|cancel|withdraw) accept the shared global as-is\b/i;
  if (framed.test(remedy) || framed.test(unchanged) || closed.test(remedy) || closed.test(unchanged) ||
      removalCancelled.test(remedy) || acceptanceCancelled.test(unchanged)) return false;
  const injection = /^Construct one ([A-Za-z_$][\w$]*) at the composition root, pass it into ([A-Za-z_$][\w$]*) and ([A-Za-z_$][\w$]*) constructors, (?:delete|remove) the module-level export, add a test that two service instances with separate caches never observe each other\./.exec(remedy);
  return Boolean(injection && injection[1] === injectedExport[1] && injection[2] !== injection[3] &&
    [injection[2], injection[3]].every(actor => actor === actors[1] || actor === actors[2]) &&
    /^Accept the shared global as-is\./.test(unchanged) &&
    /❌\s*Documented [A-Za-z][\w-]* footgun for testability and request isolation; tenant leakage risk (?:stays|remains)\b/.test(unchanged));
}


/** An answered substantive finding can start review even in a mixed setup packet. */
export const engFirstReviewAUQ: Step0BoundaryPredicate = (fp) => {
  if (engNumberedFindingAUQ(fp) || engExplicitRepairAUQ(fp) || engArchitectureChoiceAUQ(fp) || engDependencyBindingAUQ(fp) || engSharedMutableCacheAUQ(fp)) return true;
  const call = fp.nativeCall;
  if (!call?.answered || call.failed) return false;
  return call.questions.some(q => {
    if (!call.answers?.[q.question]) return false;
    // These are review section identities, including the registry's
    // arch-finding/test-gap IDs. Scope and onboarding IDs cannot qualify.
    const id = /<gstack-qid:\s*([a-z0-9-]+)(?:;signal=[a-z0-9-]+)?\s*>/i.exec(q.question)?.[1] ?? '';
    if (/^plan-eng-(?:review-)?(?:arch(?:itecture)?|quality|test|perf(?:ormance)?)-(?:focus|mode|setup|routing|learnings|prerequisite|onboarding|next-steps?)(?:-|$)/i.test(id)) return false;
    const title = `${q.header} ${q.question.split('\n')[0]}`.replace(/<gstack-qid:[^>]*>/gi, '');
    return /^plan-eng-(?:review-)?(?:arch(?:itecture)?|quality|test|perf(?:ormance)?)-/i.test(id) &&
      /\b(?:issue|finding|gap)\b/i.test(title);
  });
};

/** A skipped optional prerequisite can share one completed native setup call. */
function engSetupPacketBoundary(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false || call.questions.length !== 2 ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` ||
      !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length ||
      Object.keys(call.answers ?? {}).length !== 2 || !Number.isFinite(Date.parse(call.answeredAt ?? '')) ||
      JSON.stringify(fp.options) !== JSON.stringify(nativePlanCallFingerprint(call, 0, true).options)) return false;
  const projected = call.questions.map(q => {
    if (q.multiSelect || q.options.length < 2 || q.options.length > 4 ||
        new Set(q.options.map(o => o.label)).size !== q.options.length ||
        q.options.filter(o => o.label === call.answers?.[q.question]).length !== 1) return null;
    return nativePlanCallFingerprint({ ...call, questions: [q],
      answers: { [q.question]: call.answers![q.question]! } }, fp.observedAtMs, true);
  });
  return projected.some((prerequisite, i) => {
    if (!prerequisite || !projected[1 - i]) return false;
    const skip = planCountPrerequisitePick(prerequisite);
    return skip !== null && prerequisite.options.find(o => o.index === skip)?.label ===
      call.answers?.[call.questions[i]!.question] && engSetupAUQ(projected[1 - i]!);
  });
}

export const engStep0Boundary: Step0BoundaryPredicate = (fp) =>
  engSetupPacketBoundary(fp) ||
  engSetupAUQ(fp) ||
  /scope\s*reduction\s*recommendation|cross[\s-]*project\s*learnings/i.test(
    fp.promptSnippet,
  ) ||
  // plan-eng-review's Step 0 may legitimately end with NO scope-reduction /
  // learnings AUQ. When it does, the first answered review-phase question —
  // tagged <gstack-qid:plan-eng-review-...> ({skill}-{slug} convention) —
  // must fire the boundary, or every per-finding AUQ stays classified
  // preReview and the multi-finding batching counter reads 0. Anchor allows
  // the skill-name prefix; live qids observed: plan-eng-review-jitter,
  // plan-eng-review-idempotency, plan-eng-review-todos-e2e-concurrent.
  /gstack-qid:\s*(?:plan-)?eng-review-/i.test(fp.promptSnippet);
