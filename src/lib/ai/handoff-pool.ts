import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Who gets a chat when an AI agent hands off.
//   - the agent has a pool of humans: the next one in turn who is online
//     (next_handoff_assignee, migration 137);
//   - nobody in the pool is online: the chat stays in the shared queue and
//     the whole pool is notified, so whoever is free picks it up;
//   - no pool: the agent's single legacy handoff person, if any.
// Never overwrites an existing human assignee.
// ============================================================

export interface HandoffResult {
  /** The human the chat was assigned to; null = shared queue. */
  assignedTo: string | null
  /** Pool members notified because nobody was online. */
  notified: number
}

export async function assignHandoff(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string | null
    agentId: string | null | undefined
    /** The agent's older single handoff person (used when it has no pool). */
    legacyAssigneeId: string | null | undefined
    /** What the customer last said, for the notification body. */
    question?: string | null
  },
): Promise<HandoffResult> {
  const { accountId, conversationId, agentId } = args
  let pool: string[] = []
  if (agentId) {
    const { data } = await db
      .from('ai_agent_handoff_members')
      .select('user_id')
      .eq('agent_id', agentId)
      .order('position')
    pool = ((data ?? []) as { user_id: string }[]).map((m) => m.user_id)
  }

  let assignee: string | null = null
  if (pool.length > 0 && agentId) {
    const { data, error } = await db.rpc('next_handoff_assignee', { p_agent: agentId })
    if (error) console.error('[ai handoff] next_handoff_assignee failed:', error)
    assignee = (typeof data === 'string' && data) || null
  } else if (args.legacyAssigneeId) {
    assignee = args.legacyAssigneeId
  }

  if (assignee) {
    // Assigning fires `on_conversation_assigned`, which notifies them.
    await db
      .from('conversations')
      .update({ assigned_agent_id: assignee })
      .eq('id', conversationId)
      .is('assigned_agent_id', null)
    return { assignedTo: assignee, notified: 0 }
  }

  if (pool.length === 0) return { assignedTo: null, notified: 0 }

  // Nobody in the pool is online: shared queue, but tell everyone on the pool.
  const body = args.question ? args.question.trim().slice(0, 140) : null
  const { error } = await db.from('notifications').insert(
    pool.map((user_id) => ({
      account_id: accountId,
      user_id,
      type: 'ai_handoff',
      conversation_id: conversationId,
      contact_id: args.contactId,
      title: 'A customer needs a person',
      body,
    })),
  )
  if (error) {
    console.error('[ai handoff] pool notification failed:', error)
    return { assignedTo: null, notified: 0 }
  }
  return { assignedTo: null, notified: pool.length }
}
