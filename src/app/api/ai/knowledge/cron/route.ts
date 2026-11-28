import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { runKnowledgeQueue } from '@/lib/ai/ingest/pipeline'

/** Leaves headroom under the cron runner's 50 s job timeout. */
const RUN_BUDGET_MS = 40_000

/**
 * POST /api/ai/knowledge/cron
 *
 * The knowledge library's background worker, run by the Cloudflare cron
 * every 5 minutes with the shared cron secret: scheduled re-syncs, website
 * page discovery, and indexing of queued pages and documents.
 */
export async function POST(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })

  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const admin = supabaseAdmin()
    const stats = await runKnowledgeQueue(admin, { deadline: Date.now() + RUN_BUDGET_MS })
    // Once a day (the 03:00 UTC tick), drop AI reply-log rows older than the Insights window.
    const now = new Date()
    if (now.getUTCHours() === 3 && now.getUTCMinutes() < 5) {
      const { error } = await admin.rpc('prune_ai_reply_log')
      if (error) console.error('[knowledge cron] prune_ai_reply_log failed:', error.message)
    }
    return NextResponse.json(stats)
  } catch (err) {
    console.error('[knowledge cron] run failed:', err)
    return NextResponse.json({ error: 'run failed' }, { status: 500 })
  }
}
