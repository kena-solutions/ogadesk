-- ============================================================
-- 136_ai_fallback_reply_log.sql: the AI as a polite fallback.
--
--   * ai_agents.reply_mode: 'fallback' (default) = answer only when no flow
--     or automation already replied to the customer's message; 'always' =
--     answer regardless (the old behaviour when no automation existed).
--   * ai_reply_log: one row per AI reply attempt (replied, handed off,
--     skipped because something else already replied, or errored). It backs
--     the Insights tab (answered vs handed off, knowledge gaps).
--     Written by the server only; admins read.
-- Idempotent.
-- ============================================================

ALTER TABLE public.ai_agents
  ADD COLUMN IF NOT EXISTS reply_mode text NOT NULL DEFAULT 'fallback';
ALTER TABLE public.ai_agents DROP CONSTRAINT IF EXISTS ai_agents_reply_mode_check;
ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_reply_mode_check
  CHECK (reply_mode IN ('fallback', 'always'));

CREATE TABLE IF NOT EXISTS public.ai_reply_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  outcome         text NOT NULL CHECK (outcome IN ('replied', 'handoff', 'skipped_fallback', 'error')),
  -- Why it handed off: the model's call, or the reply cap.
  handoff_reason  text CHECK (handoff_reason IS NULL OR handoff_reason IN ('model', 'reply_cap', 'tool_approval')),
  assigned_to     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sources_count   integer NOT NULL DEFAULT 0,
  top_score       real,
  -- The customer's message the AI was answering (trimmed), for knowledge gaps.
  question        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_reply_log_account_idx ON public.ai_reply_log (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_reply_log_agent_idx ON public.ai_reply_log (agent_id, created_at DESC);

ALTER TABLE public.ai_reply_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_reply_log_select ON public.ai_reply_log;
CREATE POLICY ai_reply_log_select ON public.ai_reply_log FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));

GRANT SELECT ON public.ai_reply_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_reply_log TO service_role;

-- Scope to the active workspace like every other account table (125).
SELECT public.enforce_workspace_scope('public.ai_reply_log'::regclass);
