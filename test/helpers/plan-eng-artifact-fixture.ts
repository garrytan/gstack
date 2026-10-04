/** The dashboard plan and sources that /plan-eng-review's QA test-plan cases review. */

/** Working-plan path in the prompt; rewritten per run to a private temporary path. */
export const FIXTURE_PLAN_PATH = '/tmp/gstack-test-plan-eng-artifact.md';

export const DASHBOARD_PLAN = [
  'Proceed directly to the requested engineering review; skip the optional /office-hours prerequisite.',
  `Please review this plan thoroughly. As you go, write your plan-mode plan to ${FIXTURE_PLAN_PATH} (use Edit/Write to that exact path).`,
  '',
  '# Plan: Add Dashboard',
  '',
  '## Changes',
  '1. New `dashboard.ts` with Dashboard component and fetchStats API call',
  '2. Updated `app.ts` to import and use Dashboard',
  '',
  '## Architecture',
  '- Dashboard fetches from `/api/stats` endpoint',
  '- Returns user count and revenue metrics',
].join('\n');

export const SOURCES = {
  'app.ts': 'import { Dashboard } from "./dashboard";\nexport function greet() { return "hello"; }\nexport function main() { return Dashboard(); }\n',
  'dashboard.ts': `export function Dashboard() {
  const data = fetchStats();
  return { users: data.users, revenue: data.revenue };
}
function fetchStats() {
  return fetch('/api/stats').then(r => r.json());
}
`,
};
