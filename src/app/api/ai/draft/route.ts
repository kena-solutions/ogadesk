import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAgentConfig } from '@/lib/ai/config'
import { checkGrounding } from '@/lib/ai/grounding'
import { loadRoutingContext } from '@/lib/ai/routing-context'
import { buildConversationContext } from '@/lib/ai/context'
import { retrieveKnowledge, sourceRefs } from '@/lib/ai/knowledge'
import { runGeneration } from '@/lib/ai/run'
import { loadToolRuntime } from '@/lib/ai/tools/registry'
import { loadPlatformPrompt, personaPrompt } from '@/lib/ai/persona'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { buildRetrievalQuery } from '@/lib/ai/query'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/draft  (agent+)
 *
 * Body: { conversation_id }
 * Returns: { draft } - a suggested reply for the agent to edit + send.
 *
 * Uses the account's configured provider/key (BYO). Read-only: it never
 * sends or stores anything, just hands text back to the composer.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const userLimit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    // Also cap the whole team's draws on the shared BYO provider key.
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json(
        { error: t('ai.conversationIdRequired') },
        { status: 400 },
      )
    }

    // RLS scopes the SSR client to the caller's account, so a missing
    // row means "not yours / not found" either way.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id, channel, ai_agent_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/draft] conversation lookup error:', convErr)
      return NextResponse.json({ error: t('common.failedToLoadConversation') }, { status: 500 })
    }
    if (!conversation) {
      return NextResponse.json({ error: t('common.conversationNotFound') }, { status: 404 })
    }

    // Draft as the agent that handles this conversation (override →
    // channel → default), with that agent's prompt and knowledge.
    const config = await loadAgentConfig(supabase, accountId, {
      conversationAgentId: conversation.ai_agent_id ?? null,
      channel: conversation.channel ?? 'whatsapp',
      contextLoader: () => loadRoutingContext(supabase, { accountId, conversationId }),
    }).catch((err) => {
      // Decrypt failure - surface distinctly from "not configured".
      console.error('[ai/draft] loadAgentConfig error:', err)
      throw new AiError(t('ai.storedKeyUndecryptable'), {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: t('ai.notConfigured'),
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const messages = await buildConversationContext(supabase, conversationId)
    // Nothing to draft from - a brand-new thread with no customer text
    // would otherwise produce a nonsensical reply-to-nothing.
    if (messages.length === 0) {
      return NextResponse.json(
        {
          error: t('ai.noMessages'),
          code: 'no_messages',
        },
        { status: 400 },
      )
    }

    // Ground the draft in the account's knowledge base (best-effort -
    // returns [] when there's no KB or retrieval fails).
    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      buildRetrievalQuery(messages),
      { sourceIds: config.knowledgeSourceIds ?? null },
    )

    const platform = personaPrompt(await loadPlatformPrompt(supabaseAdmin()), config.persona, config.agentName)
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'draft',
      knowledge,
      platform,
    })

    // One entry point: the business's own key, or the platform's provider chain with failover and plan credits.
    // Usage is logged inside, through the service role (the log has no `authenticated` INSERT policy).
    // Drafts may look things up with read tools; actions are never run from a draft (only suggested).
    const tools = await loadToolRuntime(supabaseAdmin(), {
      accountId, conversationId, agentId: config.agentId ?? null, mode: 'draft', allowedIntegrations: config.toolIntegrations ?? null,
    })
    const { text, toolsExecuted } = await runGeneration(supabaseAdmin(), {
      config, systemPrompt, messages, accountId, conversationId, mode: 'draft', agentId: config.agentId ?? null, tools,
    })

    // Facts in the draft that nothing backs up (a price, date or link the AI wasn't given): the teammate checks them
    // before sending. Never blocks a draft.
    let unsupported: string[] = []
    if (!toolsExecuted) {
      try {
        unsupported = checkGrounding(text, [systemPrompt, ...messages.map((m) => m.content)]).unsupported
      } catch (err) {
        console.error('[ai/draft] grounding check failed:', err)
      }
    }

    return NextResponse.json({ draft: text, agent: config.agentName ?? null, sources: sourceRefs(knowledge), unsupported })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
