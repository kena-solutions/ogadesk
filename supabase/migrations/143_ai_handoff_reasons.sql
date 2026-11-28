-- ============================================================
-- 143_ai_handoff_reasons.sql: a handoff can now also be because the reply
-- could not be verified against the knowledge ('ungrounded'). 'reply_cap'
-- (already allowed) is now actually used. Idempotent.
-- ============================================================
ALTER TABLE public.ai_reply_log DROP CONSTRAINT IF EXISTS ai_reply_log_handoff_reason_check;
ALTER TABLE public.ai_reply_log ADD CONSTRAINT ai_reply_log_handoff_reason_check
  CHECK (handoff_reason IS NULL OR handoff_reason IN ('model', 'reply_cap', 'tool_approval', 'ungrounded'));
