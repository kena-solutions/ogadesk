import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig } from './types'
import { AGENT_COLUMNS, hasRouting, pickAgent, type AgentTarget, type AiAgentRow } from './agents'
import { checkAiAdminGate } from './admin-gate'

interface AiConfigRow {
  provider: 'openai' | 'anthropic' | 'openai_compatible'
  model: string
  base_url: string | null
  /** NULL = powered by the platform's provider chain (no key of the business's own). */
  api_key: string | null
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
}

const CONFIG_COLUMNS =
  'provider, model, base_url, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key'

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off, or an admin has paused AI for the platform or this
 * business - all mean "AI is not available", which callers treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  // The platform admin can pause AI platform-wide or per business. That applies to every use of the
  // model (drafts, auto-replies and the playground), whatever `requireActive` says.
  if (!(await checkAiAdminGate(db, accountId)).allowed) return null
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // A NULL key means the business uses the platform's AI (admin-configured providers, plan credits). An EMPTY
  // string is a damaged row (partial write / manual edit): "not configured", never silently platform spend.
  if (row.api_key === null) {
    return {
      provider: 'openai', model: '', baseUrl: null, apiKey: '', source: 'platform',
      systemPrompt: row.system_prompt, isActive: row.is_active, autoReplyEnabled: row.auto_reply_enabled,
      autoReplyMaxPerConversation: row.auto_reply_max_per_conversation, handoffAgentId: row.handoff_agent_id, embeddingsApiKey: null,
    }
  }
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key -
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent - a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted, check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    apiKey: decrypt(row.api_key),
    source: 'own',
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
  }
}

/**
 * Load the workspace config (provider, keys, master switch) and layer the
 * resolved agent's settings on top: model override, prompt, auto-reply,
 * handoff and the library sources it may search. Same null semantics as
 * `loadAiConfig`, plus null when no agent qualifies for the target.
 *
 * Falls back to the legacy single-config values when the account has no
 * agents yet (e.g. the migration that creates them is not applied).
 */
export async function loadAgentConfig(
  db: SupabaseClient,
  accountId: string,
  target: AgentTarget = {},
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const workspace = await loadAiConfig(db, accountId, opts)
  if (!workspace) return null

  const { data: rows, error } = await db
    .from('ai_agents')
    .select(AGENT_COLUMNS)
    .eq('account_id', accountId)
  if (error || !rows || rows.length === 0) {
    if (error) console.error('[ai config] agents lookup failed, using the workspace config:', error)
    return { ...workspace, agentId: null, agentName: null, knowledgeSourceIds: null }
  }

  const agentRows = rows as AiAgentRow[]
  let routed = target
  if (!target.context && target.contextLoader && agentRows.some((a) => a.is_active && hasRouting(a.routing))) {
    try {
      routed = { ...target, context: await target.contextLoader() }
    } catch (err) {
      console.error('[ai config] routing context failed, ignoring agent rules:', err)
    }
  }
  const agent = pickAgent(agentRows, routed)
  if (!agent) return null

  let knowledgeSourceIds: string[] | null = null
  if (agent.knowledge_mode === 'selected') {
    const { data: links, error: linkErr } = await db
      .from('ai_agent_knowledge')
      .select('source_id')
      .eq('agent_id', agent.id)
    // Fail closed: an agent limited to some sources must never search all.
    knowledgeSourceIds = linkErr ? [] : (links ?? []).map((l: { source_id: string }) => l.source_id)
  }

  return {
    ...workspace,
    // On the platform the admin's instances choose the model; an agent's own model only applies to a business's own key.
    model: workspace.source === 'platform' ? workspace.model : agent.model?.trim() || workspace.model,
    systemPrompt: agent.system_prompt,
    autoReplyEnabled: agent.auto_reply_enabled,
    replyMode: agent.reply_mode === 'always' ? 'always' : 'fallback',
    autoReplyMaxPerConversation: agent.auto_reply_max_per_conversation,
    handoffAgentId: agent.handoff_agent_id,
    agentId: agent.id,
    agentName: agent.name,
    knowledgeSourceIds,
    toolIntegrations: Array.isArray(agent.tool_integrations) ? agent.tool_integrations : null,
    persona: {
      gender: agent.persona_gender ?? null, tone: agent.persona_tone ?? null, behaviour: agent.persona_behaviour ?? null,
      avoid: agent.persona_avoid ?? null, never: agent.persona_never ?? null,
    },
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted, check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true }
  }
}
