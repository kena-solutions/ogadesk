import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from './admin-client'
import { loadAgentConfig } from './config'
import { buildSystemPrompt } from './defaults'
import { retrieveKnowledge } from './knowledge'
import { loadPlatformPrompt, personaPrompt } from './persona'
import { runGeneration } from './run'
import type { EvalObserved } from './evals'

/**
 * Ask an agent one question the way a customer would: the same path as the Playground and the live bot (retrieval,
 * the auto-reply prompt, the agent's provider), with no tools and nothing written to any conversation. Returns what
 * it did. Throws AiError when the agent can't be loaded or the provider fails, so the caller can report it.
 */
export async function runAgentOnQuestion(
  db: SupabaseClient,
  accountId: string,
  agentId: string,
  question: string,
): Promise<EvalObserved | null> {
  const config = await loadAgentConfig(db, accountId, { agentId }, { requireActive: false })
  if (!config) return null
  const knowledge = await retrieveKnowledge(db, accountId, config, question, { sourceIds: config.knowledgeSourceIds ?? null })
  const platform = personaPrompt(await loadPlatformPrompt(supabaseAdmin()), config.persona, config.agentName)
  const systemPrompt = buildSystemPrompt({ userPrompt: config.systemPrompt, mode: 'auto_reply', knowledge, platform })
  const { text, handoff } = await runGeneration(supabaseAdmin(), {
    config, systemPrompt, messages: [{ role: 'user', content: question }], accountId,
    conversationId: null, mode: 'playground', agentId, tools: null,
  })
  return {
    handoff: Boolean(handoff) || !text.trim(),
    reply: text,
    source_titles: Array.from(new Set(knowledge.map((k) => (k.title ?? '').trim()).filter(Boolean))),
  }
}
