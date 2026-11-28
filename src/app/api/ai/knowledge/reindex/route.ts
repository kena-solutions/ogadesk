import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbedder } from '@/lib/ai/embedder'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { runKnowledgeQueue } from '@/lib/ai/ingest/pipeline'
import { IN_REQUEST_BUDGET_MS } from '@/lib/ai/ingest/route-helpers'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/knowledge/reindex  (admin+)
 *
 * Re-chunk and re-embed the whole library. The main use is after adding
 * an embeddings key: existing documents were stored keyword-only, and
 * this backfills their vectors so semantic search turns on. Also retries
 * documents whose indexing failed. Work that doesn't fit in this request
 * is finished by the knowledge cron.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-reindex:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { embed, corrupt } = await loadEmbedder(supabase, accountId)
    // The whole point of Reindex is usually to backfill embeddings - so
    // if a key is configured but can't be decrypted, don't quietly do a
    // keyword-only pass and report success. Stop and tell the admin.
    if (corrupt) {
      return NextResponse.json(
        { success: false, queued: 0, error: t('ai.knowledge.reindexKeyCorrupt') },
        { status: 200 },
      )
    }

    const admin = supabaseAdmin()
    // Clearing the hash forces a re-embed even when the text is unchanged.
    const { data: queued, error } = await admin
      .from('ai_knowledge_documents')
      .update({ status: 'queued', error: null, content_hash: null })
      .eq('account_id', accountId)
      .select('source_id')
    if (error) {
      console.error('[ai/knowledge/reindex] queue error:', error)
      return NextResponse.json({ error: t('ai.knowledge.loadDocsFailed') }, { status: 500 })
    }
    const sourceIds = [...new Set(((queued ?? []) as { source_id: string }[]).map((d) => d.source_id))]
    if (sourceIds.length > 0) {
      await admin.from('ai_knowledge_sources').update({ status: 'processing' }).in('id', sourceIds)
    }

    const stats = await runKnowledgeQueue(admin, {
      deadline: Date.now() + IN_REQUEST_BUDGET_MS,
      onlyAccountId: accountId,
    })
    const total = (queued ?? []).length
    const done = stats.indexed + stats.unchanged + stats.failed
    return NextResponse.json({
      success: stats.failed === 0,
      semantic: Boolean(embed),
      total,
      indexed: stats.indexed + stats.unchanged,
      failed: stats.failed,
      remaining: Math.max(0, total - done),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
