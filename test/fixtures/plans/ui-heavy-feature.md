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
