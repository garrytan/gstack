/**
 * Section loading needs a complete, bounded plan, not a finding-count fixture.
 * The former two-bullet plan made a successful review invent key isolation,
 * error, concurrency, observability, rollout, and test contracts in a 38 KB
 * report. Those surrounding contracts are explicit here; the read/write sketch
 * still permits an old in-flight read to refill a key after write invalidation.
 */
export const CACHE_READ_WRITE_SKETCH = `async function readProfile(key) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await repository.read(key);
  cache.set(key, value);
  return value;
}

async function writeProfile(key, update) {
  const saved = await repository.write(key, update);
  cache.delete(key);
  return saved;
}`;

export const CEO_SECTION_CACHE_PLAN = `# Plan: cache profile summaries in one process

## Measured problem and accepted scope
The existing profile-summary service has one active process. A one-week trace
shows repeated reads of about 900 hot keys: DB CPU is 70%, with read p95 120 ms.
Add a process-local LRU wrapper to the existing repository. Acceptance targets
are at least 60% cache hits, DB CPU below 50%, and read p95 below 60 ms, with the
existing error-rate and correctness SLOs unchanged. This is an internal backend
change with no UI, API, schema, pricing, or developer onboarding change.

## Existing contracts retained
- All reads and writes use this repository in the same process; there are no
  external DB writers. Multi-process operation remains unsupported and startup
  rejects that configuration while caching is enabled.
- Authentication and authorization run before repository access. Keys encode
  the authenticated tenant ID and validated profile ID without ambiguity.
  Values are immutable profile-summary DTOs; secrets and cache keys are never
  logged. Cached results cannot bypass authorization.
- The existing LRU adapter supports 1000 entries, a 16 MiB byte cap, and a
  30-second TTL. Recorded hot data fits those limits. Absent records use a
  distinct sentinel with a 10-second TTL; undefined means a cache miss.
- Cache operations are synchronous and atomic in the single JS event loop.
  On any cache failure the existing adapter bypasses the cache until an empty
  cache is reinitialized; repository errors keep the current typed API error
  mapping. The existing per-key
  single-flight wrapper coalesces simultaneous misses and releases on failure.
- A read already in progress when a write commits may return its earlier DB
  snapshot to that caller. Every read begun after that write completes must
  observe the committed version. TTL expiry is not a substitute for this rule.

## Proposed wrapper integration
Keep the current read-through repository interface and shared adapters. These
are the complete new read/write ordering rules; no additional version checks or
coordination between a cache fill and a write are proposed:

\`\`\`javascript
${CACHE_READ_WRITE_SKETCH}
\`\`\`

## Verification and rollout
Existing repository contract tests cover tenant isolation, key validation,
absence, DB failures, and authorization. New wrapper tests cover hit/miss,
eviction and byte limits, TTL, adapter-failure fallback, successful-write
invalidation, failed-write preservation, and concurrent-miss coalescing.
The rollout uses the existing runtime feature flag: enable for 10% of keys,
then 50%, then all keys after one healthy hour at each stage. Monitor hit/miss,
eviction, cache bytes, fallback errors, DB CPU, and read p95 without raw IDs.
On error-rate or latency regression, disable the flag immediately; both reads
and writes bypass the cache while disabled, and enabling creates an empty cache.
Cold starts remain within the existing DB capacity. The service owner monitors
the rollout and records the results against the acceptance targets.

## Out of scope
Distributed caching, cross-process coherence, prewarming, changing consistency
semantics, or adding new product surfaces. The repository interface preserves a
future replacement path without introducing a general cache framework now.
`;

/** A named finding may put its ordering evidence in a trace, not one paragraph. */
function hasStructuredStaleFillFinding(report: string): boolean {
  const lines = report.split('\n');
  const prose = lines.map(() => '');
  const traces: Array<{ start: number; end: number; text: string }> = [];
  let fence: { char: string; length: number; start: number; info: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      if (!fence) fence = { char: run[0]!, length: run.length, start: i, info: delimiter[2]!.trim() };
      else if (run[0] === fence.char && run.length >= fence.length && !delimiter[2]!.trim()) {
        if (!fence.info || fence.info === 'text') traces.push({ start: fence.start, end: i, text: lines.slice(fence.start + 1, i).join('\n') });
        fence = null;
      }
      continue;
    }
    // Unclosed, tilde and longer fences remain source until their own real
    // closing delimiter. They cannot supply an asserted prose violation.
    if (!fence && !/^\s*>/.test(line) && !/^(?: {4}|\t)/.test(line)) prose[i] = line;
  }
  for (let i = 0; i < lines.length; i++) {
    if (!/^\*\*CRITICAL FINDING\s*[—–:-].*\*\*\s*$/.test(prose[i]!)) continue;
    const previous = prose.slice(0, i).filter(value => value.trim()).at(-1) ?? '';
    if (/\b(?:example|template|source|quoted|format)\b[^.]*:\s*$/i.test(previous)) continue;
    let end = i + 1;
    while (end < lines.length && !/^(?:#{1,6}\s|\*\*(?:(?:CRITICAL|HIGH|MEDIUM|LOW)\s+)?(?:FINDING|GAP)\b)/i.test(prose[end]!)) end++;
    const claim = prose.slice(i + 1, end).join('\n');
    if (!/^This\s+violates\s+the\s+stated\s+(?:invariant|contract):/m.test(claim) ||
        !/Every read begun after that write\s+completes must observe the committed version/.test(claim)) continue;
    if (/\b(?:not\s+(?:a\s+)?(?:gap|bug|defect|issue)|no\s+(?:fix|change|guard)\s+(?:is\s+)?(?:needed|required))\b/i.test(claim)) continue;
    for (const trace of traces.filter(trace => trace.start > i && trace.end < end)) {
      // All four ordered events and the post-write new reader must be shown.
      // A copied wrapper has neither this execution trace nor an independent
      // asserted violation in the same finding.
      if (/await\s+repository\.read[\s\S]*repository\.write[\s\S]*cache\.delete[\s\S]*cache\.set\([^\n]*(?:old|stale)[^\n]*\)[\s\S]*readProfile\([^\n]*started after[^\n]*[\s\S]*cache\.get[^\n]*(?:old|stale)/i.test(trace.text)) return true;
    }
  }
  return false;
}

/** Require an unresolved late-fill defect, not a keyword-bearing dismissal. */
export function hasStaleFillRaceFinding(report: string): boolean {
  if (hasStructuredStaleFillFinding(report)) return true;
  // Copied source, diagrams and quoted examples cannot supply a finding.
  const prose = report.replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '');
  // Independent list items and table rows cannot borrow each other's words.
  const blocks = prose.split(/\n\s*\n|\n(?=\s*(?:\||\d+\.\s|[-*]\s))/).map(block => block.trim());
  const normalize = (text: string) => text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  return blocks.some((block, index) => {
    const text = normalize(block);
    const stale = /\b(?:stale|outdated)\b|\bold(?:er)?\s+(?:value|data|result|version|snapshot)\b/i.test(text);
    const inFlight = /\b(?:race|racing|concurrent|concurrency|in[- ]flight|pending)\b/i.test(text);
    const read = /\b(?:read|fetch)\w*\b/i.test(text);
    const fillPattern = /\b(?:fill|refill|repopulat|populat|insert|stor)\w*\b|\bcache\.set\b|\bcache(?:s|d)?\s+(?:the|an?|old|stale|same)\s+(?:\w+\s+){0,2}(?:value|data|result|snapshot)\b/i;
    const fill = fillPattern.test(text);
    const invalidation = /\b(?:invalidat|evict|write|commit|delet)\w*\b/i.test(text);
    const ordering = /\b(?:after|later|resum\w*)\b|out[- ]of[- ]order/i.test(text);
    if (!stale || !inFlight || !read || !fill || !invalidation || !ordering) return false;

    // A neighboring explanation/remedy belongs to this paragraph only until
    // another named finding/section/table row begins. In particular, a
    // following dismissal cannot turn a traced race into positive coverage.
    const next = blocks[index + 1] ?? '';
    const independent = /^(?:#{1,6}(?:\s|\d)|\d+\.\s|[-*]\s|\||(?:[*_]+)?(?:Finding\b|Section\s|P[0-3]\b))/i.test(next);
    const context = text + (independent ? '' : ' ' + normalize(next));

    const finding = /\b(?:P[0-3]|missing|gap|bug|defect|violat\w*|unsafe|incorrect)\b|\bno\s+mention\s+of\s+(?:this|the)\s+race\b/i.test(context);
    const subsequentRead = /\b(?:next|later|subsequent|new|fresh)\s+(?:read\w*|request\w*|caller\w*)\b/i.test(context);
    const remedy = context.split(/[.!?]\s+/).some(sentence =>
      (/\b(?:guard|serialize|serialise|coordinate|prevent|reject|skip)\w*\b/i.test(sentence) &&
        /\b(?:cache|fill|refill|write|mutation|invalidation)\w*\b/i.test(sentence)) ||
      /\bper[- ]key\s+(?:epoch|generation|version)\b/i.test(sentence));
    const claims = context.split(/(?:[.!?]\s+|\b(?:but|however|nevertheless|yet)\s*[:,]?\s+)/i);
    const violation = claims.some(claim => /\b(?:violat\w*|break\w*)\b[^.!?]*\b(?:contract|guarantee|consistency|rule)\b/i.test(claim)
      && !/\b(?:not|no|never)\b/i.test(claim));
    for (const [claimIndex, claim] of claims.entries()) {
      // "Not permitted" is a violation assertion, not permission. Scope a
      // permitted old result to its original caller; it cannot justify a
      // cache fill or a later reader observing that same old version.
      const allowanceText = claim.replace(/\b(?:not|never)\s+(?:an?\s+)?(?:permitted|allowed|acceptable|accepted)\b/gi, 'forbidden');
      // An imperative's purpose clause describes the proposed guard's goal,
      // not a claim that the current implementation already prevents the race.
      const proposedPrevention = /^(?:guard|serialize|serialise|coordinate|prevent|reject|skip)\b/i.test(claim.trim())
        && /\b(?:cache|fill|refill|write|mutation|invalidation)\w*\b/i.test(claim)
        && /\b(?:so(?:\s+that)?|to\s+ensure)\b/i.test(claim);
      // The model declaration must accept the stale consequence itself.
      // A normative freshness requirement called an accepted model is not a
      // dismissal. Bare "This" can refer only to the preceding stale claim.
      const modelDeclaration = /^(.+?)\s+(?:is|remains)\s+(?:(?:the|an?)\s+)?(?:accepted|expected|intentional|documented)\s+consistency\s+(?:model|contract|policy|semantics)\b/i.exec(allowanceText.trim());
      const subject = modelDeclaration?.[1] ?? '';
      const previousClaim = claims[claimIndex - 1] ?? '';
      const explicitStaleSubject = /^(?:this|the|an?)\s+(?:bounded\s+)?(?:inconsistency|staleness|stale[- ](?:read|fill)|stale\s+(?:read|fill|refill))(?:\s+(?:window|behavior|behaviour|race|consequence))?$/i.test(subject);
      const impliedStaleSubject = /^this$/i.test(subject)
        && /\b(?:stale|outdated|old(?:er)?\s+(?:value|snapshot|data))\b/i.test(previousClaim)
        && /\b(?:read|fetch|fill|refill|repopulat)\w*\b/i.test(previousClaim)
        && !/\b(?:must|shall|requires?|violat\w*|not|cannot|can't)\b/i.test(previousClaim);
      const acceptedStaleModel = Boolean(modelDeclaration) && (explicitStaleSubject || impliedStaleSubject);
      const dismissal = /\b(?:not|isn't)\s+(?:a\s+|an\s+)?(?:gap|bug|defect|issue|violation|problem)\b|\bno\s+(?:gap|bug|defect|issue|violation|race)\b/i.test(claim)
        || /\b(?:accepted|expected|intentional|documented)\s+(?:invariant|behavior|trade[- ]off|stale[- ]read\s+window)\b|\b(?:allowed|permitted|acceptable)\b/i.test(allowanceText)
        || acceptedStaleModel
        || (!proposedPrevention && /\b(?:cannot|can't|never|does not|will not)\s+(?:\w+\s+){0,3}(?:refill|repopulate|populate|insert|store|cache|set|violate)\b/i.test(claim))
        || /\bno\s+(?:fix|change|coordination|guard)\s+(?:is\s+)?(?:needed|required)\b/i.test(claim);
      if (!dismissal) continue;
      const originalCaller = /\b(?:original|already[- ]pending)\s+(?:pending\s+)?(?:caller|reader|request)\b|\bpending\s+caller\b/i.test(claim);
      const onlyEarlierReturn = originalCaller && /\b(?:return|receiv|observ)\w*\b/i.test(claim)
        && /\b(?:old|earlier|previous)\s+(?:snapshot|value|result|version)\b/i.test(claim)
        && !fillPattern.test(claim) && !/\b(?:next|later|subsequent|new|fresh)\s+(?:read\w*|request\w*|caller\w*)\b/i.test(claim);
      if (!(onlyEarlierReturn && subsequentRead && (violation || remedy))) return false;
    }
    return finding || subsequentRead || remedy;
  });
}
