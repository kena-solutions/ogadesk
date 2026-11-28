import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * GET /api/ai/insights?days=30  (admin+)
 *
 * How the AI agents are doing: per agent, how many replies, handoffs and
 * skipped (something else had already replied); the questions the AI handed
 * off because no knowledge matched (gaps worth writing an answer for); and
 * the knowledge replies leaned on most.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-insights:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const raw = Number(new URL(request.url).searchParams.get('days'))
    const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.floor(raw))) : 30

    const [stats, feedback] = await Promise.all([
      supabase.rpc('ai_agent_stats', { p_account: accountId, p_days: days }),
      supabase.rpc('ai_feedback_summary', { p_account: accountId, p_days: days }),
    ])
    if (stats.error) {
      console.error('[ai/insights] stats failed:', stats.error)
      return NextResponse.json({ error: t('ai.insightsFailed') }, { status: 500 })
    }
    // Ratings are a bonus: if that function isn't there yet, the rest still shows.
    if (feedback.error) console.error('[ai/insights] feedback summary failed:', feedback.error)
    return NextResponse.json({
      days,
      ...(stats.data as Record<string, unknown>),
      feedback: feedback.error ? { agents: [], down: [], up: [] } : feedback.data,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
