// ============================================================
// AI agents: which agent handles a conversation, and how its settings
// layer on top of the workspace config (provider, keys, master switch).
//
// The selection itself is pure (`pickAgent`) so it is trivially
// testable; `loadAgentConfig` in ./config does the DB reads.
// ============================================================

import { isWithinHours, type ChatHours } from '@/lib/hours'

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
  /** When to use this agent (see AgentRouting); null/absent = no rules. */
  routing?: AgentRouting | null
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
  'id, name, is_active, is_default, model, system_prompt, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, channels, priority, knowledge_mode, reply_mode, routing, created_at, persona_gender, persona_tone, persona_behaviour, persona_avoid, persona_never, tool_integrations'

export const AGENT_CHANNELS: readonly AgentChannel[] = ['whatsapp', 'web_chat']

/** Optional rules deciding when an agent is used. Empty/absent = no rules. All kinds given must match (AND);
 *  within tags or keywords any one is enough. */
export interface AgentRouting {
  /** The contact has at least one of these tags (ids). */
  tags?: string[]
  /** The conversation so far contains at least one of these words/phrases (case-insensitive). */
  keywords?: string[]
  /** Only inside these business hours, in the workspace time zone. */
  hours?: ChatHours | null
}

export interface RoutingContext {
  tagIds: string[]
  /** What the customer has said in this conversation (joined). */
  text: string
  now: Date
  timezone: string
}

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
  /** Facts the routing rules are checked against. */
  context?: RoutingContext
  /** Loads the context on demand; only called when some active agent has rules. */
  contextLoader?: () => Promise<RoutingContext>
}

export type RouteReason = 'pinned' | 'default_requested' | 'override' | 'rules' | 'channel' | 'default' | 'none'

export interface RouteDecision {
  agent: AiAgentRow | null
  reason: RouteReason
  /** For 'rules': which kinds of rule matched. */
  matched?: ('tags' | 'keywords' | 'hours')[]
}

export function hasRouting(routing: AgentRouting | null | undefined): boolean {
  return !!routing && ((routing.tags?.length ?? 0) > 0 || (routing.keywords?.length ?? 0) > 0 || !!routing.hours?.enabled)
}

/** Which rule kinds match, or null when any given rule fails (or there is no context to check it against). */
export function matchRouting(routing: AgentRouting, ctx: RoutingContext | undefined): ('tags' | 'keywords' | 'hours')[] | null {
  const matched: ('tags' | 'keywords' | 'hours')[] = []
  if ((routing.tags?.length ?? 0) > 0) {
    if (!ctx || !routing.tags!.some((t) => ctx.tagIds.includes(t))) return null
    matched.push('tags')
  }
  if ((routing.keywords?.length ?? 0) > 0) {
    const text = ctx?.text.toLowerCase() ?? ''
    if (!routing.keywords!.some((k) => k.trim() && text.includes(k.trim().toLowerCase()))) return null
    matched.push('keywords')
  }
  if (routing.hours?.enabled) {
    if (!isWithinHours(routing.hours, ctx?.timezone ?? 'UTC', ctx?.now ?? new Date())) return null
    matched.push('hours')
  }
  return matched
}

const byPriority = (a: AiAgentRow, b: AiAgentRow) =>
  b.priority - a.priority || Number(b.is_default) - Number(a.is_default) || a.created_at.localeCompare(b.created_at)

/**
 * Choose the agent for a target, and say why:
 *   1. the pinned `agentId` (any state);
 *   2. the conversation's override, if active;
 *   3. active agents whose rules match (tag / keyword / hours), best priority first;
 *   4. active agents with no rules that cover the channel, best priority first;
 *   5. the default agent, if active (its own rules are ignored: it is the catch-all).
 * An agent whose rules don't match is skipped. Returns agent null when nothing qualifies (AI off for this chat).
 */
export function routeAgent(agents: AiAgentRow[], target: AgentTarget): RouteDecision {
  if (target.agentId) return { agent: agents.find((a) => a.id === target.agentId) ?? null, reason: 'pinned' }
  if (target.defaultAgent) return { agent: agents.find((a) => a.is_default) ?? null, reason: 'default_requested' }

  const active = agents.filter((a) => a.is_active)

  if (target.conversationAgentId) {
    const pinned = active.find((a) => a.id === target.conversationAgentId)
    if (pinned) return { agent: pinned, reason: 'override' }
  }

  const covers = (a: AiAgentRow) => !target.channel || (a.channels ?? []).includes(target.channel)

  const ruled = active
    .filter((a) => hasRouting(a.routing) && covers(a))
    .map((a) => ({ a, matched: matchRouting(a.routing as AgentRouting, target.context) }))
    .filter((x): x is { a: AiAgentRow; matched: ('tags' | 'keywords' | 'hours')[] } => x.matched !== null)
    .sort((x, y) => byPriority(x.a, y.a))
  if (ruled.length > 0) return { agent: ruled[0].a, reason: 'rules', matched: ruled[0].matched }

  if (target.channel) {
    const covering = active.filter((a) => !hasRouting(a.routing) && covers(a)).sort(byPriority)
    if (covering.length > 0) return { agent: covering[0], reason: 'channel' }
  }

  const fallback = active.find((a) => a.is_default) ?? null
  return { agent: fallback, reason: fallback ? 'default' : 'none' }
}

export type AgentStatus = 'chosen' | 'eligible' | 'off' | 'other_channel' | 'rules_not_met'

/** Why each agent was or wasn't used for a target; for the routing test box. */
export function explainAgents(agents: AiAgentRow[], target: AgentTarget): { id: string; status: AgentStatus }[] {
  const chosen = routeAgent(agents, target).agent
  return agents.map((a) => {
    if (chosen && a.id === chosen.id) return { id: a.id, status: 'chosen' as const }
    if (!a.is_active) return { id: a.id, status: 'off' as const }
    if (target.channel && !(a.channels ?? []).includes(target.channel)) return { id: a.id, status: 'other_channel' as const }
    if (hasRouting(a.routing) && matchRouting(a.routing as AgentRouting, target.context) === null) return { id: a.id, status: 'rules_not_met' as const }
    return { id: a.id, status: 'eligible' as const }
  })
}

export function pickAgent(agents: AiAgentRow[], target: AgentTarget): AiAgentRow | null {
  return routeAgent(agents, target).agent
}

/** Clean a channel list from a request body: known values only, de-duplicated. */
export function normalizeChannels(input: unknown): AgentChannel[] {
  if (!Array.isArray(input)) return []
  return AGENT_CHANNELS.filter((c) => input.includes(c))
}
