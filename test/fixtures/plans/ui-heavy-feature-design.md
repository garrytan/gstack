# User dashboard design

## Problem
After login, users reach `/workspace`, which asks them to open a project but does
not show their stored activity or notifications. The proposed dashboard brings
recent activity, notifications, and quick actions together as the landing page.

## Proposed approach
Add `/dashboard` to the existing React app, using Tailwind for a mobile-first
layout. `UserDashboard` contains `ActivityFeed`, `NotificationsPanel`, and
`QuickActions`. Each panel needs empty, loading, and error states. Interactive
elements need hover and focus-visible states; marking all notifications read
uses a confirmation modal, and actions provide toast feedback.

## Constraints
The new `GET /api/dashboard` endpoint returns activity and notifications from the
existing PostgreSQL tables and quick actions from static configuration, with no
schema changes. The existing app and sign-in remain the starting point. The
implementation plan records the proposed read, mutation, and landing contracts.
Dark mode and personalization are separate work. The implementation proposal is `.claude/plans/ui-heavy-feature.md`.
