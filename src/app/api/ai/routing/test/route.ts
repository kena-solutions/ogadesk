import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { AGENT_COLUMNS, explainAgents, routeAgent, type AiAgentRow, type RoutingContext } from '@/lib/ai/agents'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/routing/test  (any member)
 *
 * Body: { channel?, tag_ids?: string[], text?, at?: ISO time } - which AI
 * agent would answer such a conversation, and why each agent was or wasn't
 * used. Pure: no AI call, nothing is sent or stored.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    const limit = checkRateLimit(`ai-routing-test:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const channel = body?.channel === 'web_chat' ? 'web_chat' : 'whatsapp'
    const tagIds = Array.isArray(body?.tag_ids) ? (body!.tag_ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const text = typeof body?.text === 'string' ? body.text.slice(0, 2000) : ''
    const at = typeof body?.at === 'string' ? new Date(body.at) : new Date()
    if (Number.isNaN(at.getTime())) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })

    const [{ data: rows, error }, { data: account }] = await Promise.all([
      supabase.from('ai_agents').select(AGENT_COLUMNS).eq('account_id', accountId),
      supabase.from('accounts').select('timezone').eq('id', accountId).maybeSingle(),
    ])
    if (error) return NextResponse.json({ error: t('ai.agents.loadFailed') }, { status: 500 })

    const agents = (rows ?? []) as unknown as AiAgentRow[]
    const context: RoutingContext = { tagIds, text, now: at, timezone: (account?.timezone as string | undefined) || 'UTC' }
    const target = { channel, context }
    const decision = routeAgent(agents, target)
    return NextResponse.json({
      agent: decision.agent ? { id: decision.agent.id, name: decision.agent.name } : null,
      reason: decision.reason,
      matched: decision.matched ?? [],
      considered: explainAgents(agents, target),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
