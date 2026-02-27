-- Ghost Secure — Supabase Security Hardening
-- Run this in the Supabase SQL Editor after schema.sql
-- This script enables RLS, revokes broad permissions, and creates
-- a restricted public view for safe client-side user lookups.

-- =============================================================
-- 1. Revoke all default permissions from anon and authenticated
-- =============================================================
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- =============================================================
-- 2. Enable and force RLS on all tables
-- =============================================================
ALTER TABLE user_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_session FORCE ROW LEVEL SECURITY;

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;

ALTER TABLE conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation FORCE ROW LEVEL SECURITY;

ALTER TABLE conversation_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_member FORCE ROW LEVEL SECURITY;

ALTER TABLE message ENABLE ROW LEVEL SECURITY;
ALTER TABLE message FORCE ROW LEVEL SECURITY;

ALTER TABLE friend_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE friend_request FORCE ROW LEVEL SECURITY;

ALTER TABLE call_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_invite FORCE ROW LEVEL SECURITY;

-- Doctrine migrations table — lock down completely
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'doctrine_migration_versions') THEN
    EXECUTE 'ALTER TABLE doctrine_migration_versions ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE doctrine_migration_versions FORCE ROW LEVEL SECURITY';
  END IF;
END $$;

-- =============================================================
-- 3. Create restricted public view for user lookups
-- =============================================================
CREATE OR REPLACE VIEW app_user_public AS
SELECT id, public_key, created_at
FROM app_user;

GRANT SELECT ON app_user_public TO anon, authenticated;

-- =============================================================
-- 4. message — anon can SELECT ciphertext only (for realtime)
-- =============================================================
GRANT SELECT ON message TO anon, authenticated;

CREATE POLICY message_select_policy ON message
  FOR SELECT
  USING (true);

-- =============================================================
-- 5. friend_request — SELECT, INSERT, UPDATE (no DELETE)
-- =============================================================
GRANT SELECT, INSERT, UPDATE ON friend_request TO anon, authenticated;

CREATE POLICY friend_request_select_policy ON friend_request
  FOR SELECT
  USING (true);

CREATE POLICY friend_request_insert_policy ON friend_request
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY friend_request_update_policy ON friend_request
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- =============================================================
-- 6. call_invite — SELECT, INSERT, UPDATE (no DELETE)
-- =============================================================
GRANT SELECT, INSERT, UPDATE ON call_invite TO anon, authenticated;

CREATE POLICY call_invite_select_policy ON call_invite
  FOR SELECT
  USING (true);

CREATE POLICY call_invite_insert_policy ON call_invite
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY call_invite_update_policy ON call_invite
  FOR UPDATE
  USING (true)
  WITH CHECK (true);
