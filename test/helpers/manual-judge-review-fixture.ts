import type { EvalTestEntry } from './eval-store';
import entry from '../fixtures/manual-judge-review-entry.json';

export function manualReviewFixture(): EvalTestEntry {
  return structuredClone(entry) as EvalTestEntry;
}
