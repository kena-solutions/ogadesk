-- ============================================================
-- 141_ai_agent_stats.sql: numbers for the Insights tab, from ai_reply_log (136) and messages.ai_sources (122).
--   ai_agent_stats(account, days) = {
--     agents:  [{agent_id, replied, handoff, skipped, error, avg_sources}],
--     gaps:    [{question, count, agent_id}]   questions the AI handed off with no matching knowledge,
--     sources: [{title, count}]                 the knowledge replies were most often grounded in
--   }
-- SECURITY INVOKER: row-level security decides who sees what (admins read the log). Idempotent.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_agent_stats(p_account uuid, p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH since AS (SELECT now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 90))) AS t),
  agents AS (
    SELECT l.agent_id,
           count(*) FILTER (WHERE l.outcome = 'replied')          AS replied,
           count(*) FILTER (WHERE l.outcome = 'handoff')          AS handoff,
           count(*) FILTER (WHERE l.outcome = 'skipped_fallback') AS skipped,
           count(*) FILTER (WHERE l.outcome = 'error')            AS error,
           round(avg(l.sources_count) FILTER (WHERE l.outcome IN ('replied', 'handoff')), 2) AS avg_sources
      FROM ai_reply_log l, since
     WHERE l.account_id = p_account AND l.created_at >= since.t
     GROUP BY l.agent_id
  ),
  gaps AS (
    SELECT lower(btrim(l.question)) AS question, count(*) AS n, (array_agg(l.agent_id ORDER BY l.created_at DESC))[1] AS agent_id
      FROM ai_reply_log l, since
     WHERE l.account_id = p_account AND l.created_at >= since.t
       AND l.outcome = 'handoff' AND l.sources_count = 0 AND coalesce(btrim(l.question), '') <> ''
     GROUP BY lower(btrim(l.question))
     ORDER BY n DESC, question
     LIMIT 20
  ),
  srcs AS (
    SELECT s->>'title' AS title, count(*) AS n
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.account_id = p_account,
           since,
           LATERAL jsonb_array_elements(m.ai_sources) s
     WHERE m.ai_generated AND m.ai_sources IS NOT NULL AND jsonb_typeof(m.ai_sources) = 'array'
       AND m.created_at >= since.t AND coalesce(s->>'title', '') <> ''
     GROUP BY s->>'title'
     ORDER BY n DESC, title
     LIMIT 10
  )
  SELECT jsonb_build_object(
    'agents',  coalesce((SELECT jsonb_agg(jsonb_build_object('agent_id', agent_id, 'replied', replied, 'handoff', handoff, 'skipped', skipped, 'error', error, 'avg_sources', avg_sources)) FROM agents), '[]'::jsonb),
    'gaps',    coalesce((SELECT jsonb_agg(jsonb_build_object('question', question, 'count', n, 'agent_id', agent_id) ORDER BY n DESC, question) FROM gaps), '[]'::jsonb),
    'sources', coalesce((SELECT jsonb_agg(jsonb_build_object('title', title, 'count', n) ORDER BY n DESC, title) FROM srcs), '[]'::jsonb)
  )
$$;
REVOKE ALL ON FUNCTION public.ai_agent_stats(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_agent_stats(uuid, integer) TO authenticated, service_role;

-- Old rows are not needed for insights past 90 days.
CREATE OR REPLACE FUNCTION public.prune_ai_reply_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM ai_reply_log WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.prune_ai_reply_log() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_ai_reply_log() TO service_role;
