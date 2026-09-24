import { sliceBetween } from './skill-fixture';

/** Keep the bounded Code Quality fixture on the real engineering decision path. */
export function sharedLibsPlanExcerpt(entrypoint: string, review: string): string {
  return [
    sliceBetween(entrypoint, '## AskUserQuestion Format', '## Artifacts Sync'),
    sliceBetween(entrypoint, '## My engineering preferences', '## Cognitive Patterns'),
    sliceBetween(review, '## Review record and write policy', '## Prior Learnings'),
    sliceBetween(review, '**Plan-review evidence:**', '## Decision procedure'),
    sliceBetween(review, '## Decision procedure', '## Scope Challenge'),
    sliceBetween(review, '### 2. Code quality review', '### 3. Test review'),
    sliceBetween(entrypoint, '**Blocked outcome:**', '## EXIT PLAN MODE GATE'),
  ].join('\n\n');
}
