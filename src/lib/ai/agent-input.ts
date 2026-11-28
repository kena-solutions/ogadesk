// ============================================================
// Parse + validate an AI agent create/update body. Pure so the routes stay
// thin and the rules are unit-tested. Membership of the handoff teammate is
// checked by the route (it needs the DB).
// ============================================================

import { normalizeChannels, type AgentChannel, type KnowledgeMode, type ReplyMode } from './agents'

export interface AgentWrite {
  name?: string
  description?: string | null
  is_active?: boolean
  model?: string | null
  system_prompt?: string | null
  auto_reply_enabled?: boolean
  auto_reply_max_per_conversation?: number
  handoff_agent_id?: string | null
  channels?: AgentChannel[]
  priority?: number
  knowledge_mode?: KnowledgeMode
  reply_mode?: ReplyMode
  /** Humans handoffs rotate across, in order. Not a column: the service stores it in ai_agent_handoff_members. */
  handoff_member_ids?: string[]
  /** Optional persona overrides; null = inherit the platform default. */
  persona_gender?: string | null
  persona_tone?: string | null
  persona_behaviour?: string | null
  persona_avoid?: string | null
  persona_never?: string | null
  /** Integrations whose tools the agent may use; null = all connected ones. */
  tool_integrations?: string[] | null
}

export type AgentInputError =
  | 'name_required'
  | 'name_too_long'
  | 'prompt_too_long'
  | 'knowledge_mode_invalid'
  | 'persona_too_long'

export const MAX_HANDOFF_MEMBERS = 20
export const AGENT_NAME_MAX = 80
export const AGENT_PROMPT_MAX = 20_000
/** Max lengths of the persona fields (mirrored by CHECKs in migration 115). */
export const PERSONA_MAX = { persona_gender: 60, persona_tone: 400, persona_behaviour: 1500, persona_avoid: 1500, persona_never: 1500 } as const

const optionalText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/**
 * `partial` (PATCH) keeps only the fields present in the body; otherwise
 * (POST) every field gets its default and `name` is required.
 */
export function parseAgentInput(
  body: unknown,
  { partial }: { partial: boolean },
): { data: AgentWrite } | { error: AgentInputError } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const has = (k: string) => k in b
  const out: AgentWrite = {}

  if (!partial || has('name')) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return { error: 'name_required' }
    if (name.length > AGENT_NAME_MAX) return { error: 'name_too_long' }
    out.name = name
  }
  if (!partial || has('description')) out.description = optionalText(b.description)
  if (!partial || has('is_active')) out.is_active = partial ? b.is_active === true : b.is_active !== false
  if (!partial || has('model')) out.model = optionalText(b.model)
  if (!partial || has('system_prompt')) {
    const prompt = optionalText(b.system_prompt)
    if (prompt && prompt.length > AGENT_PROMPT_MAX) return { error: 'prompt_too_long' }
    out.system_prompt = prompt
  }
  if (!partial || has('auto_reply_enabled')) out.auto_reply_enabled = b.auto_reply_enabled === true
  if (!partial || has('auto_reply_max_per_conversation')) {
    const n = Number(b.auto_reply_max_per_conversation)
    out.auto_reply_max_per_conversation = Number.isFinite(n) ? Math.min(20, Math.max(1, Math.floor(n))) : 3
  }
  if (!partial || has('handoff_agent_id')) out.handoff_agent_id = optionalText(b.handoff_agent_id)
  if (!partial || has('channels')) {
    out.channels = has('channels') ? normalizeChannels(b.channels) : ['whatsapp', 'web_chat']
  }
  if (!partial || has('priority')) {
    const p = Number(b.priority)
    out.priority = Number.isFinite(p) ? Math.min(100, Math.max(-100, Math.floor(p))) : 0
  }
  for (const [key, max] of Object.entries(PERSONA_MAX) as [keyof typeof PERSONA_MAX, number][]) {
    if (!partial || has(key)) {
      const v = optionalText(b[key])
      if (v && v.length > max) return { error: 'persona_too_long' }
      out[key] = v
    }
  }
  if (!partial || has('knowledge_mode')) {
    const mode = has('knowledge_mode') ? b.knowledge_mode : 'selected'
    if (mode !== 'all' && mode !== 'selected') return { error: 'knowledge_mode_invalid' }
    out.knowledge_mode = mode
  }
  if (has('handoff_member_ids')) out.handoff_member_ids = parseIdList(b.handoff_member_ids, MAX_HANDOFF_MEMBERS) ?? []
  // 'always' = answer even when a flow/automation already replied; anything else = fallback (the default).
  if (!partial || has('reply_mode')) out.reply_mode = b.reply_mode === 'always' ? 'always' : 'fallback'
  // Only when sent (null = every connected integration). Ids are scoped to the account when tools are loaded.
  if (has('tool_integrations')) {
    out.tool_integrations = b.tool_integrations === null ? null : parseIdList(b.tool_integrations, 50) ?? null
  }
  return { data: out }
}

/** Unique, string-only ids from a request body field. */
export function parseIdList(input: unknown, max = 500): string[] | null {
  if (!Array.isArray(input)) return null
  const ids = input.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64)
  return Array.from(new Set(ids)).slice(0, max)
}
