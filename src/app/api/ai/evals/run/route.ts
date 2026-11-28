import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { evaluateCase, parseExpected, type EvalResult } from '@/lib/ai/evals'
import { runAgentOnQuestion } from '@/lib/ai/evals-run'
import { AiError } from '@/lib/ai/types'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/evals/run  (admin+)
 *
 * Body: { case_id }. Run one check: ask the agent the saved question (same path as the Playground, no tools, nothing
 * sent or stored in any conversation), compare with the saved expectation, store and return the result. The page
 * calls this once per check so no request runs long. Costs one normal AI call (plan credits on OgaDesk AI).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-evals-run:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { case_id?: unknown } | null
    const caseId = typeof body?.case_id === 'string' ? body.case_id : ''
    if (!caseId) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })

    const { data: row } = await supabase
      .from('ai_eval_cases')
      .select('id, agent_id, question, expected')
      .eq('id', caseId)
      .eq('account_id', accountId)
      .maybeSingle()
    const expected = parseExpected(row?.expected)
    if (!row || !expected) return NextResponse.json({ error: t('ai.evals.notFound') }, { status: 404 })

    const observed = await runAgentOnQuestion(supabase, accountId, row.agent_id as string, row.question as string)
    if (!observed) return NextResponse.json({ error: t('ai.noAgentConfigured'), code: 'ai_not_configured' }, { status: 400 })

    const result: EvalResult = { ...observed, status: evaluateCase(expected, observed), ran_at: new Date().toISOString() }
    const { error } = await supabase
      .from('ai_eval_cases')
      .update({ last_result: result, last_run_at: result.ran_at })
      .eq('id', caseId)
      .eq('account_id', accountId)
    if (error) console.error('[ai/evals run] storing the result failed:', error)
    return NextResponse.json({ result })
  } catch (err) {
    if (err instanceof AiError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    return toErrorResponse(err)
  }
}
