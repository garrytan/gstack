/**
 * Confidence calibration resolver
 *
 * Adds confidence scoring rubric to review-producing skills.
 * Every finding includes a 1-10 score that gates display:
 *   7+: show normally
 *   5-6: show with caveat
 *   <5: suppress from main report
 */
import type { TemplateContext } from './types';

export function generateConfidenceCalibration(_ctx: TemplateContext): string {
  return `## Confidence Calibration

Every finding MUST include a confidence score (1-10):

| Score | Meaning | Display rule |
|-------|---------|-------------|
| 9-10 | Verified by reading specific code. Concrete bug or exploit demonstrated. | Show normally |
| 7-8 | High confidence pattern match. Very likely correct. | Show normally |
| 5-6 | Moderate. Could be a false positive. | Show with caveat: "Medium confidence, verify this is actually an issue" |
| 3-4 | Low confidence. Pattern is suspicious but may be fine. | Suppress from main report. Include in appendix only. |
| 1-2 | Speculation. | Only report if severity would be P0. |

**Finding format:**

\\\`[SEVERITY] (confidence: N/10) file:line — description\\\`

Example:
\\\`[P1] (confidence: 9/10) app/models/user.rb:42 — SQL injection via string interpolation in where clause\\\`
\\\`[P2] (confidence: 5/10) app/controllers/api/v1/users_controller.rb:18 — Possible N+1 query, verify with production logs\\\`

**Calibration learning:** If you report a finding with confidence < 7 and the user
confirms it IS a real issue, that is a calibration event. Your initial confidence was
too low. Log the corrected pattern as a learning so future reviews catch it with
higher confidence.`;
}
