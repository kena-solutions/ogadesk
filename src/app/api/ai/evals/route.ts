import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { EVAL_ORIGINS, MAX_EVAL_CASES_PER_AGENT, parseExpected } from '@/lib/ai/evals'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const COLUMNS = 'id, agent_id, question, origin, expected, last_result, last_run_at, created_at'

/** GET /api/ai/evals?agent_id=…  (any member): the agent's saved checks. */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const agentId = new URL(request.url).searchParams.get('agent_id')
    if (!agentId) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    const { data, error } = await supabase
      .from('ai_eval_cases')
      .select(COLUMNS)
      .eq('account_id', accountId)
      .eq('agent_id', agentId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[ai/evals GET] error:', error)
      return NextResponse.json({ error: t('ai.evals.loadFailed') }, { status: 500 })
    }
    return NextResponse.json({ cases: data ?? [], max: MAX_EVAL_CASES_PER_AGENT })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/evals  (admin+)
 *
 * Body: { agent_id, question, expected: {handoff, source_titles, sample_reply}, origin? }. Save a check.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-evals:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const agentId = typeof body?.agent_id === 'string' ? body.agent_id : ''
    const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 500) : ''
    const expected = parseExpected(body?.expected)
    const origin = (EVAL_ORIGINS as readonly string[]).includes(body?.origin as string) ? (body!.origin as string) : 'playground'
    if (!agentId || !question || !expected) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })

    const { data: agent } = await supabase.from('ai_agents').select('id').eq('id', agentId).eq('account_id', accountId).maybeSingle()
    if (!agent) return NextResponse.json({ error: t('ai.agents.notFound') }, { status: 404 })

    const { data, error } = await supabase
      .from('ai_eval_cases')
      .insert({ account_id: accountId, agent_id: agentId, question, origin, expected, created_by: userId })
      .select(COLUMNS)
      .single()
    if (error) {
      // 23514 = the per-agent limit trigger.
      if (error.code === '23514') {
        return NextResponse.json({ error: t('ai.evals.limitReached', { max: MAX_EVAL_CASES_PER_AGENT }) }, { status: 400 })
      }
      console.error('[ai/evals POST] error:', error)
      return NextResponse.json({ error: t('ai.evals.saveFailed') }, { status: 500 })
    }
    return NextResponse.json({ case: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
