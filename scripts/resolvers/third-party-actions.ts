/**
 * {{THIRD_PARTY_ACTIONS}} — the third-party web actions contract.
 *
 * Governs the moment a workflow needs something done on an external website
 * the user controls: registering an API key, creating a vendor account,
 * configuring a dashboard, webhook, OAuth app, billing plan, or domain
 * verification. Instead of dumping a manual step list, the skill offers to
 * drive the browser (consent-gated, secrets never in chat) and verifies the
 * captured credential before claiming success.
 *
 * Adapted from time-attack/gstack's THIRD-PARTY-ACTIONS.md (GStack 2, MIT):
 * the fork detected the Aside AI browser; we drive our own stack — browse
 * headed mode + handoff/resume ($B), GStack Browser, and pair-agent.
 * Portions copyright (c) 2026 Sina Matian, time-attack/gstack, MIT.
 */

import type { TemplateContext } from './types';

export function generateThirdPartyActions(_ctx: TemplateContext): string {
  return `## Third-Party Web Actions

A step sometimes requires action on an external website the user controls: registering an API key, creating a vendor or developer account, configuring a dashboard, webhook, OAuth app, billing plan, or domain verification. This contract governs that moment. It grants no new browsing authority — the AskUserQuestion format and one-way-door rules remain binding, including approval before anything that spends money.

1. **Never hand the user a manual step list for a third-party site without first offering to drive it.** The driver is gstack's own browser stack: \`$B\` headed mode with handoff/resume for the human-only moments (see the /browse skill), or GStack Browser when installed. Never install new tooling to close the gap, and never treat tooling presence as consent to browse.

2. **One explicit question before any browsing.** STOP and name the exact site and the exact actions (for example "create a test-mode API token in the Duffel dashboard"), then offer: A) I drive it now in a visible browser — you take over for sign-in and approvals, B) manual instructions, C) defer. The selection is per-task consent; never persist it as standing permission and never infer it from an earlier task.

3. **When driving, touch only the named site and actions.** Password entry, new-account credential choice, payment, CAPTCHA, and identity verification are user-performed: hand off (\`$B handoff\`) and wait instead of acting. Prefer credential flows that never expose the secret to the agent, such as password-manager autofill or the dashboard's own copy button used by the human.

4. **A captured secret never appears in chat output, logs, or shell history.** Write it to a user-approved local file with owner-only permissions (0600) or the user's secret store, and keep generated destinations out of version control. Dashboard fields are often masked placeholders — verify the captured credential with ONE non-mutating API call before claiming success; a 401 here has caught a placeholder masquerading as a key.

5. **If the user declines or defers, or no browser is usable,** provide the manual steps and mark the step blocked on the user. Do not recommend or install new products to close the gap.`;
}
