// ============================================================
// Browser-side AI agent list, cached briefly per account so the inbox
// (agent picker, message badges) doesn't refetch on every thread switch.
// ============================================================

import type { AgentChannel, KnowledgeMode, ReplyMode } from './agents'

export interface AgentDto {
  id: string
  name: string
  description: string | null
  is_active: boolean
  is_default: boolean
  model: string | null
  system_prompt: string | null
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  channels: AgentChannel[]
  priority: number
  knowledge_mode: KnowledgeMode
  reply_mode?: ReplyMode
  persona_gender?: string | null
  persona_tone?: string | null
  persona_behaviour?: string | null
  persona_avoid?: string | null
  persona_never?: string | null
  tool_integrations?: string[] | null
  source_count: number
  created_at: string
  updated_at: string
}

const TTL_MS = 30_000
const cache = new Map<string, { agents: AgentDto[]; expiresAt: number }>()

export function invalidateAgents(accountId?: string): void {
  if (accountId) cache.delete(accountId)
  else cache.clear()
}

/** The account's agents (default first). [] on any error. */
export async function fetchAgents(accountId: string, force = false): Promise<AgentDto[]> {
  const hit = cache.get(accountId)
  if (!force && hit && hit.expiresAt > Date.now()) return hit.agents
  try {
    const res = await fetch('/api/ai/agents', { cache: 'no-store' })
    if (!res.ok) return []
    const json = (await res.json()) as { agents?: AgentDto[] }
    const agents = json.agents ?? []
    cache.set(accountId, { agents, expiresAt: Date.now() + TTL_MS })
    return agents
  } catch {
    return []
  }
}
