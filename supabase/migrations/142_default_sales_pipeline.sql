-- ============================================================
-- 142_default_sales_pipeline.sql
-- Every account always has a Sales pipeline (deals) next to the Support one (114).
-- Until now Sales was only a lazy client-side seed that ran when the pipeline
-- list was empty, and the Support pipeline made it never empty, so new
-- workspaces got Support only. Independent of the chosen use cases.
--   * public.ensure_sales_pipeline(account) : creates "Sales Pipeline" with the
--     default stages (same as DEFAULT_STAGES_BY_KIND.sales in src/lib/pipelines/kinds.ts)
--     when the account has no sales pipeline yet.
--   * Backfill for every existing account without one.
--   * AFTER INSERT trigger on accounts for new workspaces.
-- Idempotent.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ensure_sales_pipeline(p_account uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM pipelines WHERE account_id = p_account AND kind = 'sales' LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT owner_user_id INTO v_owner FROM accounts WHERE id = p_account;
  IF v_owner IS NULL THEN RETURN NULL; END IF;

  INSERT INTO pipelines (user_id, account_id, name, kind)
  VALUES (v_owner, p_account, 'Sales Pipeline', 'sales')
  RETURNING id INTO v_id;

  INSERT INTO pipeline_stages (pipeline_id, name, color, outcome, position) VALUES
    (v_id, 'New lead',    '#3b82f6', NULL,   0),
    (v_id, 'Qualified',   '#06b6d4', NULL,   1),
    (v_id, 'Proposal',    '#f59e0b', NULL,   2),
    (v_id, 'Negotiation', '#8b5cf6', NULL,   3),
    (v_id, 'Won',         '#22c55e', 'won',  4),
    (v_id, 'Lost',        '#ef4444', 'lost', 5);

  RETURN v_id;
END;
$$;
ALTER FUNCTION public.ensure_sales_pipeline(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ensure_sales_pipeline(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.accounts_create_sales_pipeline()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.ensure_sales_pipeline(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block account creation (signup) over a pipeline.
  RAISE WARNING 'sales pipeline for account % failed: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.accounts_create_sales_pipeline() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounts_create_sales_pipeline() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS accounts_sales_pipeline ON accounts;
CREATE TRIGGER accounts_sales_pipeline
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_create_sales_pipeline();

SELECT public.ensure_sales_pipeline(id) FROM accounts;
