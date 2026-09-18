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


## Planned implementation contracts

These are proposed constraints for review, not implemented behavior or approved
review findings. The existing app remains the starting point; review every phase
normally, including alternative approaches and scope proposals.

**Landing and authentication.** Add the `/dashboard` HTML route beside the
existing `/workspace` route, and make the authenticated React app select the
page by pathname. Change both the login response redirect in `src/server.ts`
and the client redirect in `src/main.tsx` to `/dashboard`; preserve `/workspace`.
A direct dashboard visit uses the existing session check and sign-in flow.

**Dashboard read.** Keep the three top-level response keys. `activity` and
`notifications` each return `{ items: [...], error: null }` on success or
`{ items: [], error: "unavailable" }` for a failed section query. Run the two
queries independently, so one failure does not discard the other's data.
Authenticate with the existing `sessionUser` helper, filter both tables by that
server-resolved user, and order recent entries by `created_at DESC, id DESC`.
An invalid session returns 401 and enters the existing sign-in flow. Network or
whole-request failure shows each panel's error/retry state; retry uses the same
GET. Do not expose database error text to the client.

**Mark all as read.** The confirmation modal's confirm button calls planned
`POST /api/notifications/read-all`; cancel makes no request. Reuse session
identity and the login endpoint's Origin check, without accepting an owner ID
from the body. The operation changes only this user's unread rows; already-read
rows retain their timestamp and another user's rows remain untouched. Return
`{ updatedCount }` from the affected rows. Repeating a successful request returns
zero when no unread rows remain. This planned statement uses the existing
schema (`$1` is the server timestamp, `$2` is the authenticated user ID):

```sql
UPDATE notifications SET read_at = $1
WHERE user_id = $2 AND read_at IS NULL
RETURNING id;
```

Disable repeated confirmation while the request is in flight. Success updates
the panel and shows a toast; a failed request retains the displayed read state,
shows an error toast and permits retry. No schema change is needed.

**Quick actions.** `quickActions` is static server configuration, not a table
query. Initially provide `Open workspace` → `/workspace` and `Review notifications`
→ `#notifications`; give `NotificationsPanel` that anchor. Both are navigational
links presented as the requested buttons, with the existing hover/focus rules.

**Planned checks.** Add tests for direct/login landing, authenticated ownership,
one failed section with the other preserved, mutation cancellation, repeat/foreign
user safety, error/retry feedback, and keyboard modal/quick-action navigation.
These tests and dashboard handlers do not exist in the baseline app.
