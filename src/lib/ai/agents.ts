// ============================================================
// AI agents: which agent handles a conversation, and how its settings
// layer on top of the workspace config (provider, keys, master switch).
//
// The selection itself is pure (`pickAgent`) so it is trivially
// testable; `loadAgentConfig` in ./config does the DB reads.
// ============================================================

export type AgentChannel = 'whatsapp' | 'web_chat'
export type KnowledgeMode = 'all' | 'selected'
/** 'fallback' = reply only when no flow or automation already replied; 'always' = reply regardless. */
export type ReplyMode = 'fallback' | 'always'

export interface AiAgentRow {
  id: string
  name: string
  is_active: boolean
  is_default: boolean
  model: string | null
  system_prompt: string | null
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  channels: string[] | null
  priority: number
  knowledge_mode: KnowledgeMode
  reply_mode?: ReplyMode
  created_at: string
  /** Optional persona overrides; null = inherit the platform default. */
  persona_gender?: string | null
  persona_tone?: string | null
  persona_behaviour?: string | null
  persona_avoid?: string | null
  persona_never?: string | null
  /** Integrations whose tools this agent may use; null = all connected integrations. */
  tool_integrations?: string[] | null
}

export const AGENT_COLUMNS =
  'id, name, is_active, is_default, model, system_prompt, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, channels, priority, knowledge_mode, reply_mode, created_at, persona_gender, persona_tone, persona_behaviour, persona_avoid, persona_never, tool_integrations'

export const AGENT_CHANNELS: readonly AgentChannel[] = ['whatsapp', 'web_chat']

export interface AgentTarget {
  /** Pin one agent (Playground, or an explicit choice). Inactive agents are
   *  still returned so they can be tested before going live. */
  agentId?: string | null
  /** `conversations.ai_agent_id`: a manual override from the inbox. Used
   *  only when that agent is active. */
  conversationAgentId?: string | null
  /** `conversations.channel`. */
  channel?: string | null
  /** The default agent, in any state (Playground with no agent chosen). */
  defaultAgent?: boolean
}

/**
 * Choose the agent for a target:
 *   1. the pinned `agentId` (any state);
 *   2. the conversation's override, if active;
 *   3. the active agent covering the channel with the highest priority
 *      (the default agent wins ties, then the oldest);
 *   4. the default agent, if active.
 * Returns null when nothing qualifies (AI is off for this conversation).
 */
export function pickAgent(agents: AiAgentRow[], target: AgentTarget): AiAgentRow | null {
  if (target.agentId) {
    return agents.find((a) => a.id === target.agentId) ?? null
  }
  if (target.defaultAgent) {
    return agents.find((a) => a.is_default) ?? null
  }

  const active = agents.filter((a) => a.is_active)

  if (target.conversationAgentId) {
    const pinned = active.find((a) => a.id === target.conversationAgentId)
    if (pinned) return pinned
  }

  if (target.channel) {
    const covering = active
      .filter((a) => (a.channels ?? []).includes(target.channel as string))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          Number(b.is_default) - Number(a.is_default) ||
          a.created_at.localeCompare(b.created_at),
      )
    if (covering.length > 0) return covering[0]
  }

  return active.find((a) => a.is_default) ?? null
}

/** Clean a channel list from a request body: known values only, de-duplicated. */
export function normalizeChannels(input: unknown): AgentChannel[] {
  if (!Array.isArray(input)) return []
  return AGENT_CHANNELS.filter((c) => input.includes(c))
}
