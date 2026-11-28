import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { expectedFrom, type EvalResult } from '@/lib/ai/evals'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/evals/[id]/accept  (admin+)
 *
 * "This new answer is fine": the last run becomes the check's expected result.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { data: row } = await supabase
      .from('ai_eval_cases')
      .select('id, last_result')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    const last = row?.last_result as EvalResult | null
    if (!row || !last) return NextResponse.json({ error: t('ai.evals.nothingToAccept') }, { status: 404 })

    const expected = expectedFrom(last)
    const { error } = await supabase
      .from('ai_eval_cases')
      .update({ expected, last_result: { ...last, status: 'same' } })
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/evals accept] error:', error)
      return NextResponse.json({ error: t('ai.evals.saveFailed') }, { status: 500 })
    }
    return NextResponse.json({ expected })
  } catch (err) {
    return toErrorResponse(err)
  }
}
