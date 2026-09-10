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

/** All six events must form one ordered, same-key, post-write reader trace. */
function hasNumberedStaleFillTrace(text: string): boolean {
  const events = text.split('\n').map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (events.length !== 6) return false;
  const arrow = String.raw`\s*(?:→|->)\s*`;
  const backArrow = String.raw`\s*(?:←|<-)\s*`;
  const identifier = String.raw`([A-Za-z_$][\w$]*)`;
  const read = String.raw`readProfile\(\s*${identifier}\s*\)`;
  const write = String.raw`writeProfile\(\s*${identifier}\s*\)`;
  const first = new RegExp(String.raw`^t1:\s*${read}${arrow}cache miss${arrow}(?:single-flight${arrow})?await DB read(?: \(suspends\))?$`, 'i').exec(events[0]!);
  if (!first) return false;
  // Prose keywords are case-insensitive; identifiers remain case-sensitive.
  const sameKey = (event: string, pattern: string) => new RegExp(pattern, 'i').exec(event)?.[1] === first[1];
  return sameKey(events[1]!, String.raw`^t2:\s*${write}${arrow}await DB write(?: \(suspends\))?$`)
    && sameKey(events[2]!, String.raw`^t3:\s*DB write completes${arrow}cache\.delete\(\s*${identifier}\s*\)${arrow}writeProfile returns$`)
    && new RegExp(String.raw`^t4:\s*DB read \(from t1\) completes${arrow}returns (?:old|stale) (?:snapshot|value)$`, 'i').test(events[3]!)
    && sameKey(events[4]!, String.raw`^t5:\s*cache\.set\(\s*${identifier}\s*,\s*(?:(?:OLD|STALE)_VALUE|(?:old|stale) (?:snapshot|value))\s*\)${backArrow}(?:old|stale) (?:value|snapshot) (?:re-inserted|refilled) after invalidation!?$`)
    && sameKey(events[5]!, String.raw`^t6:\s*(?:next|new|subsequent) ${read}${arrow}cache HIT${arrow}returns (?:old|stale) (?:value|snapshot)${backArrow}(?:INVARIANT|CONTRACT) (?:VIOLATED|VIOLATION)!?$`);
}

/** Bind each column of an explicit execution to its reader, writer, key and version. */
function columnarStaleFillTrace(text: string): { tail: string; reader: string; old: string } | undefined {
  const lines = text.split('\n').map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const cells = (line: string) => line.replace(/^\|\s*|\s*\|$/g, '').split('|').map(cell => cell.trim());
  const header = cells(lines[0] ?? '');
  if (header.length !== 6 || header[0]!.toLowerCase() !== 't') return;
  const reader = /^(R[1-9]\d*) read \(begins before (W[1-9]\d*|W)\)$/i.exec(header[1]!);
  const later = /^(R[1-9]\d*) read \(begins after (W[1-9]\d*|W)\)$/i.exec(header[3]!);
  const cache = /^cache\[([A-Za-z_$][\w$]*)\]$/.exec(header[4]!);
  const db = /^DB\[([A-Za-z_$][\w$]*)\]$/.exec(header[5]!);
  if (!reader || !later || !cache || !db || reader[1] === later[1] ||
      reader[2] !== later[2] || header[2] !== `${reader[2]} write` || cache[1] !== db[1]) return;
  const events = lines.slice(1, 8).map(cells);
  if (events.length !== 7 || events.some((row, i) => row.length !== 6 || row[0] !== String(i + 1))) return;
  const old = events[0]![5]!, fresh = events[2]![5]!;
  if (!/^[A-Za-z][\w.-]*$/.test(old) || !/^[A-Za-z][\w.-]*$/.test(fresh) || old === fresh) return;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const key = escape(cache[1]!), before = escape(old), after = escape(fresh);
  const arrow = String.raw`\s*(?:->|→)\s*`;
  const matches = (value: string, pattern: string) => new RegExp(`^(?:${pattern})$`).test(value);
  const empty = (value: string) => value === '-' || value === 'empty';
  if (!matches(events[0]![1]!, String.raw`get\(${key}\)${arrow}undefined`) ||
      !matches(events[1]![1]!, String.raw`await repository\.read(?:\(${key}\))?${arrow}${before}`) ||
      !matches(events[2]![2]!, String.raw`await write commits ${after}`) ||
      !matches(events[3]![2]!, String.raw`delete\(${key}\) \(no entry\)`) || events[4]![2] !== 'returns' ||
      !matches(events[5]![1]!, String.raw`resume: set\(${key},\s*${before}\); return ${before}`) ||
      !matches(events[6]![3]!, String.raw`get\(${key}\)${arrow}${before}; return ${before}`)) return;
  for (let i = 0; i < 7; i++) {
    const row = events[i]!;
    if (row[5] !== (i < 2 ? old : fresh) ||
        (i < 5 ? !empty(row[4]!) : row[4] !== (i === 5 ? `${old} STALE` : old)) ||
        (i < 6 && row[3] !== '') ||
        ([0, 1, 5, 6].includes(i) && row[2] !== '') ||
        ([2, 3, 4].includes(i) && row[1] !== 'paused') || (i === 6 && row[1] !== '')) return;
  }
  const violation = String.raw`VIOLATION t7: ${escape(later[1]!)} began after ${escape(reader[2]!)} completed \(t5\), observes ${before}(?: for up to [1-9]\d* (?:s|seconds))?\.`;
  if (!matches(lines[8] ?? '', violation)) return;
  const tail = lines.slice(8).join(' ');
  if (/\b(?:(?:this|that|the)\s+(?:trace|scenario|execution|sequence)|this|that|it)\s+(?:is|was|remains)\s+impossible\b/i.test(tail)) return;
  return { tail, reader: reader[1]!, old };
}

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
  for (const trace of traces) {
    let heading = trace.start - 1;
    while (heading >= 0 && !prose[heading]!.trim()) heading--;
    const identity = /^(S[1-9]\d*) Async ordering schedule \((F[1-9]\d*) evidence\):$/.exec(prose[heading] ?? '');
    if (!identity) continue;
    const previous = prose.slice(0, heading).filter(line => line.trim()).at(-1) ?? '';
    if (/^(?!\||#{1,6}\s).*:\s*$/.test(previous)) continue;
    const finding = prose.slice(0, heading).map((line, index) => ({ index, cells: line.split('|').map(cell => cell.trim()) }))
      .filter(({ cells }) => cells[0] === '' && cells[1] === identity[2] && cells[2] === 'CRITICAL GAP');
    if (finding.length !== 1 || !finding[0]!.cells[4]?.includes(`Schedule ${identity[1]} below`)) continue;
    const findingPrefix = prose.slice(0, finding[0]!.index).filter(line => line.trim()).at(-1) ?? '';
    if (/^(?!\||#{1,6}\s).*:\s*$/.test(findingPrefix)) continue;
    const ordered = columnarStaleFillTrace(trace.text);
    if (!ordered) continue;
    // The verified columns establish this claim. Keep the real finding and
    // trace assessment in the existing dismissal checks; an allowance for
    // R1's own pre-write return cannot authorize a stale cache or later reader.
    const allowance = `Allowed by contract: ${ordered.reader} itself returns ${ordered.old} (read in progress when write committed).`;
    const tail = ordered.tail.replace(allowance, 'Allowed by contract: the original reader returns its earlier value.');
    const assessment: string[] = [];
    for (let i = trace.end + 1; i < prose.length; i++) {
      if (/^(?:#{1,6}\s|[DSF][1-9]\d*\b|\|)/.test(prose[i]!)) break;
      assessment.push(prose[i]!);
    }
    // A scored, unselected alternative in an accepted decision is not the
    // verdict. Other quotes remain in the assessment, including a directly
    // quoted rejection of the finding itself.
    const registry = finding[0]!.cells.map(cell => /^Accepted\b/.test(cell)
      ? cell.replace(/\bvs\s+\d+(?:\.\d+)?\/10\s+for\s+(?:"(?:[^"\\]|\\.)*"|“[^”]*”)/g, 'unselected alternative')
      : cell).join(' | ');
    const claim = `Concurrent cache read fills an old value after the write committed and invalidated the same key. A new reader receives that stale value, which violates the read-after-write contract. ${registry} ${tail} ${assessment.join(' ')}`;
    if (hasProseStaleFillFinding(claim)) return true;
  }
  for (let i = 0; i < lines.length; i++) {
    const legacy = /^\*\*CRITICAL FINDING\s*[—–:-].*\*\*\s*$/.test(prose[i]!);
    let previousIndex = i - 1;
    while (previousIndex >= 0 && !prose[previousIndex]!.trim()) previousIndex--;
    const numbered = /^\*\*CRITICAL GAP\*\*\s*[—–:-]/.test(prose[i]!)
      && /^#{1,6}\s+Critical Finding:\s+\S.*$/i.test(prose[previousIndex] ?? '');
    if (!legacy && !numbered) continue;
    const previous = prose.slice(0, numbered ? previousIndex : i).filter(value => value.trim()).at(-1) ?? '';
    if (/\b(?:example|template|source|quoted|format)\b[^.]*:\s*$/i.test(previous)) continue;
    let end = i + 1;
    while (end < lines.length && !/^(?:#{1,6}\s|\*\*(?:(?:CRITICAL|HIGH|MEDIUM|LOW)\s+)?(?:FINDING|GAP)\b)/i.test(prose[end]!)) end++;
    const claim = prose.slice(numbered ? i : i + 1, end).join('\n');
    if (numbered) {
      // A quoted requirement alone is insufficient: the same finding must
      // independently assert that the current wrapper violates it.
      if (!/^\*\*CRITICAL GAP\*\*\s*[—–:-]\s*The plan states: "Every read begun after that write completes must observe the committed version\.(?: TTL expiry is not a substitute for this rule\.)?" The proposed wrapper violates this invariant\.\s*$/m.test(claim)) continue;
      for (const trace of traces.filter(trace => trace.start > i && trace.end < end)) {
        if (!hasNumberedStaleFillTrace(trace.text)) continue;
        // Only this validated same-finding trace becomes prose evidence.
        // Reuse all existing dismissal/accepted-staleness checks unchanged;
        // this recognizes a finding, not the correctness of its proposed fix.
        if (hasProseStaleFillFinding((claim + '\n' + trace.text).replace(/\s+/g, ' '))) return true;
      }
      continue;
    }
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
  return hasStructuredStaleFillFinding(report) || hasProseStaleFillFinding(report);
}

/** An ordered execution can establish overlap without naming it "in-flight". */
function hasOrderedStaleFillOperations(text: string): boolean {
  const separator = String.raw`\s*[,;.]\s*(?:then\s+)?`;
  const subject = String.raw`(?:(?:a|the)\s+)?`;
  const sameObject = String.raw`(?:\s+(?:(?:the\s+)?same\s+)?(?:cache\s+)?(?:key|entry))?`;
  const read = String.raw`${subject}read\s+(?:misses|gets\s+a\s+cache\s+miss)`;
  const write = String.raw`${subject}write\s+commits\s+(?:and|then)\s+(?:deletes|invalidates|evicts)${sameObject}(?:\s*\(no-op\))?`;
  const fill = String.raw`${subject}(?:(?:original|same)\s+)?reader\s+(?:(?:then|later)\s+)?(?:fills|refills|repopulates)\s+(?:the\s+)?(?:old|stale|pre[- ](?:write|commit))\s+(?:snapshot|value|data)`;
  const later = String.raw`(?:(?:every|all|the)\s+)?(?:later|next|new|subsequent)\s+readers?\s+(?:sees?|gets?|observes?|receives?)\s+(?:the\s+)?(?:stale|old|outdated)\s+(?:data|value|snapshot)`;
  const findingPrefix = String.raw`(?:(?:F[1-9]\d*|(?:Finding|Issue)\s+[1-9]\d*)\s*[—–:-]\s*)?(?:P[0-3]\s*[—–:-]\s*)?`;
  const sequence = new RegExp(String.raw`^${findingPrefix}${read}${separator}${write}${separator}${fill}${separator}${later}(?=[\s.!?;]|$)`, 'i');
  // Table cells cannot lend operation order to each other. Bare "reader"
  // refers back to the missed read; explicit foreign cache/key references,
  // quoted examples and conditional/negated executions cannot establish it.
  return text.split(/\s*\|\s*/).some(cell =>
    !/["“”?]|\b(?:if|unless|whether|might|may|could|not|never|no\s+longer|example|template|quoted)\b/i.test(cell)
    && !/\b(?:another|different|separate|unrelated|other)\s+(?:cache|key|entry|reader|read|request)\b/i.test(cell)
    && !/\b(?:(?:this|that|the)\s+(?:trace|scenario|execution|sequence)|this|that|it)\s+(?:is|was|remains)\s+impossible\b/i.test(cell)
    && sequence.test(cell));
}

function hasProseStaleFillFinding(report: string): boolean {
  // Copied source, diagrams and quoted examples cannot supply a finding.
  let fence: { char: string; length: number } | null = null;
  const prose = report.split('\n').map(line => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      if (!fence) fence = { char: run[0]!, length: run.length };
      else if (run[0] === fence.char && run.length >= fence.length && !delimiter[2]!.trim()) fence = null;
      return '';
    }
    return fence || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line) ? '' : line;
  }).join('\n');
  // Independent list items and table rows cannot borrow each other's words.
  const blocks = prose.split(/\n\s*\n|\n(?=\s*(?:#{1,6}\s|\||\d+\.\s|[-*]\s))/).map(block => block.trim());
  const normalize = (text: string) => text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  return blocks.some((block, index) => {
    const text = normalize(block);
    const stale = /\b(?:stale|outdated)\b|\b(?:old(?:er)?|pre[- ]write)\s+(?:value|data|result|version|snapshot)\b/i.test(text);
    const inFlight = /\b(?:race|racing|concurrent|concurrency|in[- ]flight|pending)\b/i.test(text)
      || hasOrderedStaleFillOperations(text);
    const read = /\b(?:read|fetch)\w*\b/i.test(text);
    const fillPattern = /\b(?:fill|refill|repopulat|populat|insert|stor|restor)\w*\b|\bcache\.set\b|\bcache(?:s|d)?\s+(?:the|an?|old|stale|same)\s+(?:\w+\s+){0,2}(?:value|data|result|snapshot)\b/i;
    const fill = fillPattern.test(text);
    const invalidation = /\b(?:invalidat|evict|write|commit|delet)\w*\b/i.test(text);
    const ordering = /\b(?:after|later|resum\w*)\b|out[- ]of[- ]order/i.test(text);
    // A review may identify the ordering defect directly as missing coordination
    // between cache fills and writes that violates read-after-write freshness.
    // That is independent evidence even when the old-value trace is a diagram.
    const premise = /(?:^|[.;]\s+)(?:\[Amended:[^\]]{1,80}\]\s*)?(?:the\s+)?(?:original|current|proposed)\s+(?:sketch|wrapper|implementation)\s+(?:had|has)\s+no\s+coordination\s+between\s+(?:an?\s+)?cache\s+fill\s+and\s+(?:an?\s+)?write\b/i.exec(text);
    const conclusion = /(?:^|[.;]\s+)(?:finding\s+[\w.-]+\s+(?:showed|shows)\s+)?(?:this|that|it)\s+(?:violates|breaks)\s+the\s+read[- ]after[- ]write\s+(?:rule|contract|guarantee|invariant)(?:[.!](?=\s|$)|$)/i.exec(text);
    const coordinationGap = premise !== null && conclusion !== null && premise.index < conclusion.index
      && !/["“”]|\b(?:if|example|template|quoted)\b/i.test(text)
      && !/\b(?:example|template|source|quoted|format)\b[^.]*:\s*$/i.test(blocks[index - 1] ?? '');
    if ((!stale || !inFlight || !read || !fill || !invalidation || !ordering) && !coordinationGap) return false;

    // A neighboring explanation/remedy belongs to this paragraph only until
    // another named finding/section/table row begins. In particular, a
    // following dismissal cannot turn a traced race into positive coverage.
    const next = blocks[index + 1] ?? '';
    const independent = /^(?:#{1,6}(?:\s|\d)|\d+\.\s|[-*]\s|\||(?:[*_]+)?(?:Finding\b|Section\s|P[0-3]\b))/i.test(next);
    const context = text + (independent ? '' : ' ' + normalize(next));

    const finding = /\b(?:P[0-3]|missing|gap|bug|defect|violat\w*|unsafe|incorrect)\b|\bno\s+mention\s+of\s+(?:this|the)\s+race\b/i.test(context);
    const subsequentRead = /\b(?:next|later|subsequent|new|fresh|future)\s+(?:read\w*|request\w*|caller\w*)\b/i.test(context);
    const remedy = context.split(/[.!?]\s+/).some(sentence =>
      (/\b(?:guard|serialize|serialise|coordinate|prevent|reject|skip)\w*\b/i.test(sentence) &&
        /\b(?:cache|fill|refill|write|mutation|invalidation)\w*\b/i.test(sentence)) ||
      /\bper[- ]key\s+(?:epoch|generation|version)\b/i.test(sentence));
    // Table cells and semicolon-separated statements have separate owners;
    // retain an explicit "that return" continuation with the return it names.
    const claims = context.split(/(?:[.!?]\s+|;\s+(?!that\s+return\b)|\s+\|\s+|\b(?:but|however|nevertheless|yet)\s*[:,]?\s+)/i);
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
      const modelDeclaration = /^(.+?)\s+(?:is|remains)\s+(?:(?:the|an?)\s+)?(?:accepted|expected|intentional|documented)\s+consistency\s+(?:model|contract|policy|semantics)\b/i.exec(allowanceText.trim())
        ?? /^(.+?)\s+(?:is|remains)\s+(?:accepted|expected|intentional|documented)[.!?]?$/i.exec(allowanceText.trim());
      const subject = modelDeclaration?.[1] ?? '';
      const previousClaim = claims[claimIndex - 1] ?? '';
      const explicitStaleSubject = /^(?:this|the|an?)\s+(?:bounded\s+)?(?:inconsistency|staleness|stale[- ](?:read|fill)|stale\s+(?:read|fill|refill))(?:\s+(?:window|behavior|behaviour|race|consequence))?$/i.test(subject);
      const impliedStaleSubject = /^this$/i.test(subject)
        && /\b(?:stale|outdated|old(?:er)?\s+(?:value|snapshot|data)|pre[- ]write\s+(?:value|data|result|version|snapshot))\b/i.test(previousClaim)
        && /\b(?:read|fetch|fill|refill|repopulat)\w*\b/i.test(previousClaim)
        && !/\b(?:must|shall|requires?|violat\w*|not|cannot|can't)\b/i.test(previousClaim);
      const acceptedStaleModel = Boolean(modelDeclaration) && (explicitStaleSubject || impliedStaleSubject);
      const dismissal = /\b(?:not|isn't)\s+(?:a\s+|an\s+)?(?:(?:stale|late)[- ]fill\s+)?(?:gap|bug|defect|issue|violation|problem|race)\b|\bno\s+(?:(?:stale|late)[- ]fill\s+)?(?:gap|bug|defect|issue|violation|race)\b/i.test(claim)
        || /\b(?:accepted|expected|intentional|documented)\s+(?:invariant|behavior|trade[- ]off|stale[- ]read\s+window)\b|\b(?:allowed|permitted|acceptable)\b/i.test(allowanceText)
        || acceptedStaleModel
        || (!proposedPrevention && /\b(?:cannot|can't|never|does not|will not)\s+(?:\w+\s+){0,3}(?:refill|repopulate|populate|insert|store|cache|set|violate)\b/i.test(claim))
        || (!proposedPrevention && /\b(?:cannot|can't|never|does not|doesn't|will not|won't|did not|didn't|is not|isn't|was not|wasn't|has not|hasn't|had not|hadn't)\s+(?:\w+\s+){0,3}restor\w*\b/i.test(claim))
        || /\bno\s+(?:fix|change|coordination|guard)\s+(?:is\s+)?(?:needed|required)\b/i.test(claim);
      if (!dismissal) continue;
      const originalCaller = /\b(?:original|already[- ]pending)\s+(?:pending\s+)?(?:caller|reader|request)\b|\bpending\s+caller\b/i.test(claim);
      // A finding can name versions instead of calling them "old". Explicit
      // start-before-commit and return-to-own-caller evidence scopes this
      // allowance to that already-started call, never to cache/later readers.
      const explicitlyEarlierCall = originalCaller && /\bto\s+its\s+own\s+caller\b/i.test(claim)
        && !/\b(?:if|unless|whether|might|may|could)\b/i.test(claim)
        && /\b(?:it|(?:the\s+)?(?:original\s+)?(?:read|request|call))\s+(?:began|started)\s+before\s+(?:(?:the|that)\s+)?(?:write\s+)?commit\b/i.test(claim);
      const onlyEarlierReturn = originalCaller && /\b(?:return|receiv|observ)\w*\b/i.test(claim)
        && (/\b(?:old|earlier|previous|pre[- ]write)\s+(?:snapshot|value|result|version)\b/i.test(claim) || explicitlyEarlierCall)
        && !fillPattern.test(claim) && !/\b(?:next|later|subsequent|new|fresh|future)\s+(?:read\w*|request\w*|caller\w*)\b/i.test(claim);
      if (!(onlyEarlierReturn && subsequentRead && (violation || remedy || explicitlyEarlierCall))) return false;
    }
    return finding || subsequentRead || remedy;
  });
}
