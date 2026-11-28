import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Two small helpers around "did something else already answer?":
//   - hasReplySince: the AI is a fallback, so before (and again right
//     before) answering it asks whether a flow, an automation or a teammate
//     has already replied to the customer's message.
//   - logAiReply: one best-effort row per attempt, for the Insights tab.
// ============================================================

export type ReplyOutcome = 'replied' | 'handoff' | 'skipped_fallback' | 'error'
export type HandoffReason = 'model' | 'reply_cap' | 'tool_approval' | 'ungrounded'

/** When the customer message being answered arrived. Falls back to the latest customer message. */
export async function inboundArrivedAt(
  db: SupabaseClient,
  conversationId: string,
  inboundMessageId?: string,
): Promise<string | null> {
  try {
    if (inboundMessageId) {
      const { data } = await db
        .from('messages')
        .select('created_at')
        .eq('conversation_id', conversationId)
        .eq('message_id', inboundMessageId)
        .limit(1)
        .maybeSingle()
      if (data?.created_at) return data.created_at as string
    }
    const { data } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data?.created_at as string | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * True when a message from the business (a flow, an automation or a
 * teammate) was sent in this conversation at/after `sinceIso`. The AI's own
 * replies and event notes ("handed off", etc.) don't count. Fails open
 * (false) so a lookup error never silences the AI.
 */
export async function hasReplySince(
  db: SupabaseClient,
  conversationId: string,
  sinceIso: string | null,
): Promise<boolean> {
  if (!sinceIso) return false
  try {
    const { data, error } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .in('sender_type', ['agent', 'bot'])
      .eq('ai_generated', false)
      .neq('content_type', 'event')
      .gte('created_at', sinceIso)
      .limit(1)
    if (error) return false
    return (data ?? []).length > 0
  } catch {
    return false
  }
}

export interface AiReplyLogEntry {
  accountId: string
  agentId?: string | null
  conversationId: string
  outcome: ReplyOutcome
  handoffReason?: HandoffReason | null
  assignedTo?: string | null
  sourcesCount?: number
  topScore?: number | null
  /** The customer's message; trimmed. */
  question?: string | null
}

/** Best-effort: never throws, never delays a reply for long. */
export async function logAiReply(db: SupabaseClient, e: AiReplyLogEntry): Promise<void> {
  try {
    const { error } = await db.from('ai_reply_log').insert({
      account_id: e.accountId,
      agent_id: e.agentId ?? null,
      conversation_id: e.conversationId,
      outcome: e.outcome,
      handoff_reason: e.handoffReason ?? null,
      assigned_to: e.assignedTo ?? null,
      sources_count: e.sourcesCount ?? 0,
      top_score: e.topScore ?? null,
      question: e.question ? e.question.trim().slice(0, 300) : null,
    })
    if (error) console.error('[ai reply log] insert failed:', error)
  } catch (err) {
    console.error('[ai reply log] insert threw:', err)
  }
}
