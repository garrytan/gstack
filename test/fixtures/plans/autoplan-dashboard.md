# Plan: User Dashboard Page

## Context
We're shipping a new user dashboard at `/dashboard` showing recent activity,
notifications panel, and quick-action buttons. Users land here after login.

## UI Scope
- New React page component `UserDashboard.tsx` at `src/pages/`
- Three new sub-components: `ActivityFeed`, `NotificationsPanel`, `QuickActions`
- Tailwind CSS for layout, mobile-first responsive (breakpoints: sm/md/lg)
- Empty state, loading skeleton, error state for each panel
- Hover states + focus-visible outlines on every interactive element
- Modal dialog for "Mark all as read" on notifications panel
- Toast notification system for action feedback

## Backend
- New REST endpoint `GET /api/dashboard` returns `{ activity, notifications, quickActions }`
- Backed by existing PostgreSQL tables; no schema changes

## Out of scope
- Dark mode (separate plan)
- Personalization / customization (separate plan)

## Existing product and application contracts

This is the existing single-role member workspace, not a new product or a new
onboarding flow. Members currently visit three separate pages after login to
resume work, check alerts, and inspect recent changes. In the team's last task
walkthrough, finding the next item took a median 75 seconds. The dashboard's
success measure is login-to-first-completed-task time, targeting 45 seconds,
with completed-task rate and permission-error rate as guardrails. Existing
analytics records login, action start, action completion, and permission errors;
the new page still needs its own exposure and interaction instrumentation.

Activity is the immutable audit history of workspace changes. Notifications are
member-specific alerts with persistent read state; acknowledging an alert does
not alter audit history. The existing action registry supplies three actions
(create an item, resume assigned work, invite a member), with stable IDs, labels,
route targets, and server-side eligibility predicates. These are links into
existing workflows; action ranking and a new configuration service do not exist.

The application already uses cookie sessions and workspace membership middleware.
Its request context supplies the authenticated member and workspace IDs. Existing
repository methods apply both IDs where appropriate; callers do not accept a
workspace ID from query parameters. Mutations already require CSRF tokens. The
new dashboard endpoint must compose these methods and follow the same boundaries;
its handler, authorization integration, and failure paths have not been written.

Existing list methods return the latest 20 records plus a cursor and have indexed
workspace/member and created-at access paths. The existing full activity and
notification pages own older-page navigation. The member-scoped bulk-read API is
idempotent and marks only notifications at or before the supplied snapshot time,
so later arrivals remain unread. Existing HTTP clients expose typed unauthenticated,
forbidden, validation, retryable-service, and network errors. Each dashboard panel
still needs to map these results to its loading, empty, error, retry, and success
states; the aggregate endpoint's response composition and partial-failure behavior
remain new implementation work. No schema migration or new mutation API is needed.

The app already has Tailwind spacing/color/type tokens, a responsive page shell,
buttons, links, and a dialog primitive with focus trapping, Escape dismissal, and
focus return. These primitives do not implement any dashboard panel, confirmation
flow, or toast system. The new modal and toast feedback must also work with keyboard
and screen readers; existing accessibility policy requires named controls, a live
region for nonblocking feedback, sufficient contrast, and reduced-motion support.
The dashboard still needs its own layout, content hierarchy, mobile behavior, and
state-specific copy at sm/md/lg breakpoints.

Vitest, React Testing Library, and Playwright already run in CI. Existing fixtures
cover authenticated members, another workspace, empty lists, and service failures;
there are no dashboard-specific tests yet. Existing staging feature flags and
request/error metrics support a member-cohort rollout and rollback to the current
landing page. The dashboard's rollout criteria, endpoint performance checks,
interaction tests, and accessibility verification must be specified and added.

All dashboard screen, panel, aggregate-endpoint, modal, and toast work listed above
is new. The existing contracts describe dependencies to reuse, not completed work
or prior approval of an implementation approach.
