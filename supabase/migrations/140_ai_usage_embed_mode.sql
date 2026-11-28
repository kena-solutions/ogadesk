-- ============================================================
-- 140_ai_usage_embed_mode.sql: platform embeddings are logged (and counted against plan AI credits) as mode 'embed'.
-- ai_credit_status already sums every platform row, whatever its mode. Idempotent.
-- ============================================================
ALTER TABLE public.ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE public.ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'playground', 'embed'));
