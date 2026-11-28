import type { SupabaseClient } from '@supabase/supabase-js'
import type { RoutingContext } from './agents'

const MAX_CUSTOMER_MESSAGES = 20

/**
 * What routing rules are checked against for one conversation: the contact's
 * tags, what the customer has said so far, and the workspace's clock. Only
 * called when some agent actually has rules (see loadAgentConfig).
 */
export async function loadRoutingContext(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; contactId?: string | null },
): Promise<RoutingContext> {
  let contactId = args.contactId ?? null
  if (!contactId) {
    const { data } = await db.from('conversations').select('contact_id').eq('id', args.conversationId).maybeSingle()
    contactId = (data?.contact_id as string | undefined) ?? null
  }
  const [tags, messages, account] = await Promise.all([
    contactId
      ? db.from('contact_tags').select('tag_id').eq('contact_id', contactId)
      : Promise.resolve({ data: [] as { tag_id: string }[] }),
    db
      .from('messages')
      .select('content_text')
      .eq('conversation_id', args.conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(MAX_CUSTOMER_MESSAGES),
    db.from('accounts').select('timezone').eq('id', args.accountId).maybeSingle(),
  ])
  return {
    tagIds: ((tags.data ?? []) as { tag_id: string }[]).map((t) => t.tag_id),
    text: ((messages.data ?? []) as { content_text: string | null }[])
      .map((m) => m.content_text ?? '')
      .filter(Boolean)
      .join('\n'),
    now: new Date(),
    timezone: (account.data?.timezone as string | undefined) || 'UTC',
  }
}
