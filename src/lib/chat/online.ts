import type { SupabaseClient } from '@supabase/supabase-js'
import { OFFLINE_AFTER_MS } from '@/lib/presence'
import { checkAiAdminGate } from '@/lib/ai/admin-gate'
import { AGENT_COLUMNS, pickAgent, type AiAgentRow } from '@/lib/ai/agents'

// ============================================================
// "Online" badge for the live-chat widget: the visitor sees Online when we are
// inside business hours (if the widget has any) AND someone can answer: an AI
// agent that auto-replies, or a teammate whose dashboard heartbeat is fresh.
// ============================================================

export { isWithinHours, type ChatHours } from '@/lib/hours'

export interface ChatAvailability {
  aiActive: boolean
  humansOnline: number
  /** First name of the teammate most recently active in the dashboard, when there is one. */
  agentName?: string | null
}

/** Pure: the widget's "Online" decision. */
export function computeOnline(withinHours: boolean, a: ChatAvailability): boolean {
  return withinHours && (a.aiActive || a.humansOnline > 0)
}

export interface PresenceLike {
  user_id: string
  status: string
  last_seen_at: string
}

/**
 * Pure: teammates whose dashboard is open right now. A fresh heartbeat is what counts: someone
 * 'away' (idle for a few minutes) still has the tab open and can answer, so only 'offline' or
 * a stale heartbeat rule a teammate out. Newest first.
 */
export function reachableTeammates(rows: PresenceLike[], now: number): PresenceLike[] {
  return rows
    .filter((r) => (r.status === 'online' || r.status === 'away') && now - new Date(r.last_seen_at).getTime() <= OFFLINE_AFTER_MS)
    .sort((a, b) => new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime())
}

const firstName = (full: string | null | undefined): string | null => (full ?? '').trim().split(/\s+/)[0] || null

/** Who can answer right now, from the DB (service-role client). */
export async function loadChatAvailability(
  db: SupabaseClient,
  accountId: string,
  now: number = Date.now(),
): Promise<ChatAvailability> {
  const since = new Date(now - OFFLINE_AFTER_MS).toISOString()
  const [ai, agents, presence] = await Promise.all([
    db.from('ai_configs').select('is_active, auto_reply_enabled').eq('account_id', accountId).maybeSingle(),
    db.from('ai_agents').select(AGENT_COLUMNS).eq('account_id', accountId),
    db.from('member_presence').select('user_id, status, last_seen_at').eq('account_id', accountId).gte('last_seen_at', since),
  ])
  const cfg = ai.data as { is_active?: boolean; auto_reply_enabled?: boolean } | null
  // The agent a web chat would get decides whether AI answers; accounts
  // without agents yet fall back to the workspace flag.
  const agentRows = (agents.data as AiAgentRow[] | null) ?? []
  const webAgent = agentRows.length > 0 ? pickAgent(agentRows, { channel: 'web_chat' }) : null
  const autoReplies = agentRows.length > 0 ? webAgent?.auto_reply_enabled === true : cfg?.auto_reply_enabled === true
  // An admin pause (platform-wide or this business) means AI will not answer, so don't promise it to visitors.
  const aiActive = !!cfg && cfg.is_active === true && autoReplies && (await checkAiAdminGate(db, accountId)).allowed

  const fresh = reachableTeammates((presence.data as PresenceLike[] | null) ?? [], now)
  let humansOnline = 0
  let agentName: string | null = null
  if (fresh.length > 0) {
    // Only teammates who can actually reply (agent and above), not viewers.
    const { data: roles } = await db
      .from('profiles')
      .select('user_id, full_name')
      .eq('account_id', accountId)
      .in('user_id', fresh.map((r) => r.user_id))
      .in('account_role', ['owner', 'admin', 'agent'])
    const people = (roles ?? []) as { user_id: string; full_name: string | null }[]
    humansOnline = people.length
    const newest = fresh.find((r) => people.some((p) => p.user_id === r.user_id))
    agentName = firstName(people.find((p) => p.user_id === newest?.user_id)?.full_name)
  }
  return { aiActive, humansOnline, agentName }
}
