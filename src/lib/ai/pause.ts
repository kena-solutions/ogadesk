import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A person replied in this chat, so the AI steps back: the chat is marked as
 * paused for the AI and the inbox shows its "Resume AI" banner. Called by the
 * dashboard's send and by a reply typed on the business phone (coexistence),
 * not by API integrations, broadcasts or the AI itself. Best-effort and
 * idempotent: only flips chats where the AI is still on.
 */
export async function pauseAiForHumanReply(db: SupabaseClient, conversationId: string): Promise<void> {
  try {
    const { error } = await db
      .from('conversations')
      .update({ ai_autoreply_disabled: true })
      .eq('id', conversationId)
      .eq('ai_autoreply_disabled', false)
    if (error) console.error('[ai] pause on human reply failed:', error.message)
  } catch (err) {
    console.error('[ai] pause on human reply threw:', err instanceof Error ? err.message : err)
  }
}
