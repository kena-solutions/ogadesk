-- ============================================================
-- 138_ai_agent_routing.sql: rules for when an AI agent is used.
--   ai_agents.routing = { tags: uuid[], keywords: text[], hours: {enabled, days, from, to} }
-- All parts optional; empty/NULL = no rules (the agent covers its channels as before).
-- Matched in src/lib/ai/agents.ts (routeAgent). Idempotent.
-- ============================================================
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS routing jsonb;
ALTER TABLE public.ai_agents DROP CONSTRAINT IF EXISTS ai_agents_routing_check;
ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_routing_check
  CHECK (routing IS NULL OR jsonb_typeof(routing) = 'object');
