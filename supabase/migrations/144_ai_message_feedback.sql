-- ============================================================
-- 144_ai_message_feedback.sql: teammates rate AI replies (thumbs up / down).
--   ai_message_feedback: one rating per teammate per AI message, with a short reason for thumbs-down.
--     Agents and above rate (their own rows); admins read everyone's, others read their own.
--   ai_feedback_summary(account, days): per agent up/down counts, and the recent thumbs-down and thumbs-up with the
--     customer's question, the reply and the knowledge it used, for the Insights tab.
-- Idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_message_feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating          text NOT NULL CHECK (rating IN ('up', 'down')),
  reason          text CHECK (reason IS NULL OR reason IN ('wrong', 'out_of_date', 'tone', 'other')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS ai_message_feedback_account_idx ON public.ai_message_feedback (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_message_feedback_conversation_idx ON public.ai_message_feedback (conversation_id);

ALTER TABLE public.ai_message_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_message_feedback_select ON public.ai_message_feedback;
CREATE POLICY ai_message_feedback_select ON public.ai_message_feedback FOR SELECT
  USING (public.is_account_member(account_id, 'admin') OR user_id = auth.uid());
DROP POLICY IF EXISTS ai_message_feedback_insert ON public.ai_message_feedback;
CREATE POLICY ai_message_feedback_insert ON public.ai_message_feedback FOR INSERT
  WITH CHECK (public.is_account_member(account_id, 'agent') AND user_id = auth.uid());
DROP POLICY IF EXISTS ai_message_feedback_update ON public.ai_message_feedback;
CREATE POLICY ai_message_feedback_update ON public.ai_message_feedback FOR UPDATE
  USING (user_id = auth.uid() AND public.is_account_member(account_id, 'agent'))
  WITH CHECK (user_id = auth.uid() AND public.is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS ai_message_feedback_delete ON public.ai_message_feedback;
CREATE POLICY ai_message_feedback_delete ON public.ai_message_feedback FOR DELETE
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_message_feedback TO authenticated, service_role;
SELECT public.enforce_workspace_scope('public.ai_message_feedback'::regclass);

CREATE OR REPLACE FUNCTION public.ai_feedback_summary(p_account uuid, p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH since AS (SELECT now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 90))) AS t),
  fb AS (
    SELECT f.*
      FROM ai_message_feedback f, since
     WHERE f.account_id = p_account AND f.created_at >= since.t
  ),
  per_agent AS (
    SELECT agent_id,
           count(*) FILTER (WHERE rating = 'up')   AS up,
           count(*) FILTER (WHERE rating = 'down') AS down
      FROM fb GROUP BY agent_id
  ),
  detail AS (
    SELECT fb.id, fb.rating, fb.reason, fb.agent_id, fb.conversation_id, fb.created_at,
           left(m.content_text, 600) AS reply,
           (SELECT array_agg(DISTINCT s->>'title') FILTER (WHERE coalesce(s->>'title', '') <> '')
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.ai_sources) = 'array' THEN m.ai_sources ELSE '[]'::jsonb END) s) AS sources,
           (SELECT left(q.content_text, 300)
              FROM messages q
             WHERE q.conversation_id = m.conversation_id AND q.sender_type = 'customer' AND q.created_at <= m.created_at
             ORDER BY q.created_at DESC LIMIT 1) AS question
      FROM fb JOIN messages m ON m.id = fb.message_id
  )
  SELECT jsonb_build_object(
    'agents', coalesce((SELECT jsonb_agg(jsonb_build_object('agent_id', agent_id, 'up', up, 'down', down)) FROM per_agent), '[]'::jsonb),
    'down',   coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (SELECT * FROM detail WHERE rating = 'down' ORDER BY created_at DESC LIMIT 20) x), '[]'::jsonb),
    'up',     coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (SELECT * FROM detail WHERE rating = 'up' ORDER BY created_at DESC LIMIT 10) x), '[]'::jsonb)
  )
$$;
REVOKE ALL ON FUNCTION public.ai_feedback_summary(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_feedback_summary(uuid, integer) TO authenticated, service_role;
