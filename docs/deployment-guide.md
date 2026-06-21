# AMMOR Deployment Guide

## Deployment targets

- Railway
- Vercel
- Supabase

## Pre-deploy checks

- Confirm release checklist completed.
- Confirm deployment safety workflow is green.
- Confirm migration script review if any DB change is additive.

## Environment validation

- Required runtime variables must match documented names.
- `.env.example` is the source for local placeholders and non-secret docs.

## Deployment gate model

1. PR pass tests and security workflows.
2. Run deployment safety workflow.
3. Approve PR with compliance risk accepted.
4. Promote to production with rollback artifact available.

## Post-deploy validation

- Validate health checks and critical smoke paths.
- Verify chain-of-custody evidence hash continuity.
- Record anomaly status in release notes.
