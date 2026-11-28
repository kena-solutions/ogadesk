-- ============================================================
-- 137_ai_handoff_pool.sql: several humans can take an AI agent's handoffs.
--
--   * ai_agent_handoff_members: the teammates an agent hands chats to, in
--     order. Existing single `handoff_agent_id` values become a pool of one
--     (the column stays, kept equal to the first member, for older clients).
--   * ai_agents.handoff_cursor: position of the member who got the last
--     handoff (round-robin).
--   * next_handoff_assignee(agent): the next member after the cursor who is
--     online right now (fresh presence, role agent or above), advancing the
--     cursor; NULL when nobody is online (the app then leaves the chat in the
--     shared queue and notifies the whole pool).
--   * notifications.type += 'ai_handoff'.
-- Idempotent.
-- ============================================================

ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS handoff_cursor integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.ai_agent_handoff_members (
  agent_id   uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  position   integer NOT NULL CHECK (position >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_handoff_members_pos_idx ON public.ai_agent_handoff_members (agent_id, position);
CREATE INDEX IF NOT EXISTS ai_agent_handoff_members_account_idx ON public.ai_agent_handoff_members (account_id);

ALTER TABLE public.ai_agent_handoff_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_handoff_members_select ON public.ai_agent_handoff_members;
CREATE POLICY ai_agent_handoff_members_select ON public.ai_agent_handoff_members FOR SELECT
  USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS ai_agent_handoff_members_write ON public.ai_agent_handoff_members;
CREATE POLICY ai_agent_handoff_members_write ON public.ai_agent_handoff_members FOR ALL
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_agent_handoff_members TO authenticated, service_role;
SELECT public.enforce_workspace_scope('public.ai_agent_handoff_members'::regclass);

-- Backfill: a single configured handoff person becomes a pool of one.
INSERT INTO public.ai_agent_handoff_members (agent_id, user_id, account_id, position)
SELECT a.id, a.handoff_agent_id, a.account_id, 1
FROM public.ai_agents a
WHERE a.handoff_agent_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.next_handoff_assignee(p_agent uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_cursor  integer;
  v_pick    uuid;
  v_pos     integer;
BEGIN
  -- Lock the agent row so two simultaneous handoffs don't pick the same person.
  SELECT account_id, handoff_cursor INTO v_account, v_cursor
  FROM ai_agents WHERE id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT m.user_id, m.position INTO v_pick, v_pos
  FROM ai_agent_handoff_members m
  JOIN account_members am
    ON am.user_id = m.user_id AND am.account_id = v_account AND am.account_role IN ('owner', 'admin', 'agent')
  JOIN member_presence p
    ON p.user_id = m.user_id AND p.account_id = v_account AND p.last_seen_at > now() - interval '75 seconds'
  WHERE m.agent_id = p_agent
  -- Members after the cursor first, then wrap around.
  ORDER BY (m.position <= v_cursor), m.position
  LIMIT 1;

  IF v_pick IS NULL THEN RETURN NULL; END IF;
  UPDATE ai_agents SET handoff_cursor = v_pos WHERE id = p_agent;
  RETURN v_pick;
END;
$$;
REVOKE ALL ON FUNCTION public.next_handoff_assignee(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_handoff_assignee(uuid) TO service_role;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY['conversation_assigned'::text, 'form_submission'::text, 'trial_ending'::text, 'trial_ended'::text,
                           'plan_archived'::text, 'plan_restored'::text, 'ai_handoff'::text]));
