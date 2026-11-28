import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbedder } from '@/lib/ai/embedder'
import { minSimilarity, retrieveKnowledge } from '@/lib/ai/knowledge'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const MAX_QUERY = 1000

/**
 * POST /api/ai/knowledge/search  (any member)
 *
 * Body: { query, agent_id? } - run knowledge retrieval only (no AI call,
 * no credits) and return what an agent would be given for this question.
 * With `agent_id`, the search is limited to that agent's knowledge.
 * Used by the library's "Test a question" box.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    const limit = checkRateLimit(`ai-kb-search:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const query = typeof body?.query === 'string' ? body.query.trim().slice(0, MAX_QUERY) : ''
    if (!query) return NextResponse.json({ error: t('ai.library.queryRequired') }, { status: 400 })

    let sourceIds: string[] | null = null
    const agentId = typeof body?.agent_id === 'string' && body.agent_id ? body.agent_id : null
    if (agentId) {
      const { data: agent } = await supabase
        .from('ai_agents')
        .select('id, knowledge_mode')
        .eq('id', agentId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!agent) return NextResponse.json({ error: t('ai.agents.notFound') }, { status: 404 })
      if (agent.knowledge_mode === 'selected') {
        const { data: links } = await supabase.from('ai_agent_knowledge').select('source_id').eq('agent_id', agentId)
        sourceIds = ((links ?? []) as { source_id: string }[]).map((l) => l.source_id)
      }
    }

    const { embed, source } = await loadEmbedder(supabase, accountId)
    const hits = await retrieveKnowledge(supabase, accountId, { embeddingsApiKey: null, embedder: embed }, query, { sourceIds })
    return NextResponse.json({
      semantic: source === 'own' || hits.some((h) => h.matchedBy !== 'keyword'),
      min_similarity: minSimilarity(),
      hits: hits.map((h) => ({
        source_id: h.sourceId,
        title: h.title,
        snippet: h.content.slice(0, 400),
        score: h.score,
        matched_by: h.matchedBy,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
