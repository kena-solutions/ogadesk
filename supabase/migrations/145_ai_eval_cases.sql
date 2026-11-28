-- ============================================================
-- 145_ai_eval_cases.sql: "Checks": real questions saved with what a good result looked like, so an agent can be
-- re-checked after instructions or knowledge change.
--   expected    {handoff: bool, source_titles: [..], sample_reply: text}   what it did when the user was happy
--   last_result {status: same|changed|now_handoff|now_answers, handoff, source_titles, reply, ran_at}
-- Members read; admins write. At most 50 per agent (trigger). Idempotent.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_eval_cases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  question     text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 500),
  origin       text NOT NULL DEFAULT 'playground' CHECK (origin IN ('playground', 'feedback', 'gap')),
  expected     jsonb NOT NULL CHECK (jsonb_typeof(expected) = 'object'),
  last_result  jsonb,
  last_run_at  timestamptz,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_eval_cases_agent_idx ON public.ai_eval_cases (agent_id, created_at);

ALTER TABLE public.ai_eval_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_eval_cases_select ON public.ai_eval_cases;
CREATE POLICY ai_eval_cases_select ON public.ai_eval_cases FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS ai_eval_cases_write ON public.ai_eval_cases;
CREATE POLICY ai_eval_cases_write ON public.ai_eval_cases FOR ALL
  USING (public.is_account_member(account_id, 'admin')) WITH CHECK (public.is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_eval_cases TO authenticated, service_role;
SELECT public.enforce_workspace_scope('public.ai_eval_cases'::regclass);

CREATE OR REPLACE FUNCTION public.ai_eval_cases_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (SELECT count(*) FROM public.ai_eval_cases WHERE agent_id = NEW.agent_id) >= 50 THEN
    RAISE EXCEPTION 'An agent can have at most 50 checks' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ai_eval_cases_limit ON public.ai_eval_cases;
CREATE TRIGGER ai_eval_cases_limit BEFORE INSERT ON public.ai_eval_cases
  FOR EACH ROW EXECUTE FUNCTION public.ai_eval_cases_limit();
