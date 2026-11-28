import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/** DELETE /api/ai/evals/[id]  (admin+) */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase.from('ai_eval_cases').delete().eq('id', id).eq('account_id', accountId)
    if (error) {
      console.error('[ai/evals DELETE] error:', error)
      return NextResponse.json({ error: t('ai.evals.saveFailed') }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
