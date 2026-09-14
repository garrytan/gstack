-- Migration: Drop user email column
-- WARNING: This migration is intentionally unsafe for testing
ALTER TABLE users DROP COLUMN email;
ALTER TABLE users DROP COLUMN phone_number;
-- No backfill, no reversibility check, no data preservation
