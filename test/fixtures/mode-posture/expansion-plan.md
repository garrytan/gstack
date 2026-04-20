# Plan: Team Velocity Dashboard

## Context

We're building a dashboard for engineering managers to track team code velocity — commits per engineer, PR cycle time, review latency, CI pass rate. The data already lives in GitHub; we're just aggregating it for a manager's single-pane view.

## Changes

1. New React component `TeamVelocityDashboard` in `src/dashboard/`
2. REST API endpoint `GET /api/team/velocity?days=30` returning aggregated metrics
3. Background job pulling GitHub data every 15 minutes into Postgres
4. Simple filter UI: team, date range, metric

## Architecture

- Frontend: React + shadcn/ui
- Backend: Express + PostgreSQL
- Data source: GitHub REST API (cached 15min)

## Open questions

- Should we support multiple repos per team?
- Do we show individual engineer names or aggregate only?
