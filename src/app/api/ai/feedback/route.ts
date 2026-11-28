import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseFeedback } from '@/lib/ai/feedback'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/feedback  (agent+)
 *
 * Body: { message_id, rating: 'up' | 'down', reason? }. Rate an AI reply;
 * rating the same message again replaces the earlier rating.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`ai-feedback:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const input = parseFeedback(await request.json().catch(() => null))
    if (!input) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })

    // RLS scopes this to the caller's workspace; only AI replies can be rated.
    const { data: message } = await supabase
      .from('messages')
      .select('id, conversation_id, ai_generated, ai_agent_id')
      .eq('id', input.messageId)
      .maybeSingle()
    if (!message || !message.ai_generated) {
      return NextResponse.json({ error: t('ai.feedback.notRateable') }, { status: 404 })
    }

    const { error } = await supabase.from('ai_message_feedback').upsert(
      {
        account_id: accountId,
        message_id: message.id,
        conversation_id: message.conversation_id,
        agent_id: message.ai_agent_id ?? null,
        user_id: userId,
        rating: input.rating,
        reason: input.reason,
      },
      { onConflict: 'message_id,user_id' },
    )
    if (error) {
      console.error('[ai/feedback POST] error:', error)
      return NextResponse.json({ error: t('ai.feedback.saveFailed') }, { status: 500 })
    }
    return NextResponse.json({ message_id: message.id, rating: input.rating, reason: input.reason })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/ai/feedback?message_id=…  (agent+): take back your own rating. */
export async function DELETE(request: Request) {
  try {
    const { supabase, userId } = await requireRole('agent')
    const messageId = new URL(request.url).searchParams.get('message_id') ?? ''
    if (!messageId) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    const { error } = await supabase.from('ai_message_feedback').delete().eq('message_id', messageId).eq('user_id', userId)
    if (error) {
      console.error('[ai/feedback DELETE] error:', error)
      return NextResponse.json({ error: t('ai.feedback.saveFailed') }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
