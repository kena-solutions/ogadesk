import { isBlocked, isPlanArchived } from '@/lib/contacts/block-guard'
import { supabaseAdmin } from './admin-client'
import { loadAgentConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge, sourceRefs } from './knowledge'
import { runGeneration } from './run'
import { loadPlatformPrompt, personaPrompt } from './persona'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { loadToolRuntime } from './tools/registry'
import { buildRetrievalQuery, latestUserMessage } from './query'
import type { AiConfig, ChatMessage, KnowledgeHit } from './types'
import { assignHandoff } from './handoff-pool'
import { loadRoutingContext } from './routing-context'
import { hasReplySince, inboundArrivedAt, logAiReply, type HandoffReason } from './reply-log'
import {
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { pushToRoom } from '@/lib/chat/room'

interface DispatchArgs {
  /** Tenancy key - drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws - a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here - we're
 * reacting to a customer message that just landed - so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
  } = args

  try {
    const db = supabaseAdmin()

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, channel, ai_agent_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here

    // The agent for this thread: the inbox override, else the agent that
    // covers its channel, else the default agent.
    const config = await loadAgentConfig(db, accountId, {
      conversationAgentId: conv.ai_agent_id ?? null,
      channel: conv.channel ?? 'whatsapp',
      contextLoader: () => loadRoutingContext(db, { accountId, conversationId, contactId }),
    })
    if (!config || !config.autoReplyEnabled) return
    // Blocked contacts, and contacts a lower plan archived, get no AI reply (and no LLM spend / typing indicator).
    const { data: blockedRow } = await db
      .from('contacts')
      .select('blocked_at, plan_archived_at')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (isBlocked(blockedRow) || isPlanArchived(blockedRow)) return

    // The AI is a fallback: flows, then automations, already ran for this
    // message (the caller excludes ones a Flow consumed), so if any of them
    // - or a teammate - already replied to it, stay silent rather than
    // double-text the customer. Agents set to 'always' skip this check.
    const fallbackOnly = config.replyMode !== 'always'
    const inboundAt = fallbackOnly ? await inboundArrivedAt(db, conversationId, inboundMessageId) : null
    const skipForFallback = async (): Promise<boolean> => {
      if (!fallbackOnly || !(await hasReplySince(db, conversationId, inboundAt))) return false
      await logAiReply(db, { accountId, agentId: config.agentId, conversationId, outcome: 'skipped_fallback' })
      return true
    }
    if (await skipForFallback()) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return
    const question = latestUserMessage(messages)

    // The reply limit for this chat is reached: a person takes over (notified, with a note), instead of the bot
    // going quiet and leaving the customer unanswered. The atomic claim below is the authoritative cap check.
    if ((conv.ai_reply_count ?? 0) >= config.autoReplyMaxPerConversation) {
      await handOffConversation(db, { accountId, conversationId, contactId, config, messages, replyCount: conv.ai_reply_count ?? 0, question, knowledge: [] }, 'reply_cap', false)
      return
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit, skipping this inbound.`,
      )
      return
    }

    // Every gate has passed - we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first, so there's
    // nothing to undo on the handoff / no-text path. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    if (conv.channel === 'web_chat') {
      // Website chat: show the visitor "typing…" over their socket instead.
      await pushToRoom(conversationId, { type: 'typing', from: 'agent', on: true }, 'visitor').catch(() => undefined)
    } else if (inboundMessageId) {
      await showTypingIndicator(db, accountId, inboundMessageId)
    }

    // Ground the reply in the agent's knowledge (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      buildRetrievalQuery(messages),
      { sourceIds: config.knowledgeSourceIds ?? null },
    )

    const platform = personaPrompt(await loadPlatformPrompt(db), config.persona, config.agentName)
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      platform,
    })

    // The business's connected tools (plan feature `ai_tools`, the agent's allowed integrations). null = none.
    const tools = await loadToolRuntime(db, {
      accountId, conversationId, agentId: config.agentId ?? null, mode: 'auto_reply', allowedIntegrations: config.toolIntegrations ?? null,
    })

    // One entry point: the business's own key, or the platform's provider chain with failover and plan credits.
    // Token spend is logged inside (regardless of handoff - the provider call happened either way).
    const { text, handoff, pendingApproval } = await runGeneration(db, {
      config, systemPrompt, messages, accountId, conversationId, mode: 'auto_reply', agentId: config.agentId ?? null, tools,
    })

    // Stop auto-replying on this thread and hand it to a human: (a) pause the bot here (sticky until re-enabled),
    // (b) route the conversation to the configured handoff agent - null leaves it in the shared queue - and (c) leave
    // a short internal note so whoever picks it up has context. Assigning fires the `on_conversation_assigned`
    // trigger, which notifies the agent.
    const handOff = (pendingAction: boolean, reason: HandoffReason = 'model') =>
      handOffConversation(db, { accountId, conversationId, contactId, config, messages, replyCount: conv.ai_reply_count ?? 0, question, knowledge }, reason, pendingAction)

    // Something else (a delayed automation, a teammate) may have replied while the model was thinking.
    if (await skipForFallback()) return

    if (handoff || !text) {
      // The model can't (or shouldn't) answer.
      await handOff(!!pendingApproval, pendingApproval ? 'tool_approval' : 'model')
      return
    }

    if (
      inboundMessageId &&
      (await hasNewerInbound(db, conversationId, inboundMessageId))
    ) {
      if (pendingApproval) await handOff(true, 'tool_approval')
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands -
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue - e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) {
      if (pendingApproval) {
        await handOff(true, 'tool_approval')
      } else {
        // Lost the claim: most often the cap (another inbound took the last slot). If the chat is still the AI's and
        // at its limit, hand it to a person rather than leaving the customer unanswered.
        const { data: now } = await db
          .from('conversations')
          .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
          .eq('id', conversationId)
          .maybeSingle()
        if (now && !now.assigned_agent_id && !now.ai_autoreply_disabled && (now.ai_reply_count ?? 0) >= config.autoReplyMaxPerConversation) {
          await handOff(false, 'reply_cap')
        }
      }
      return
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
      aiAgentId: config.agentId ?? null,
      aiSources: sourceRefs(knowledge),
    })

    // The AI asked for an action a teammate must approve: it has told the customer the team will confirm; now a
    // human takes the thread (the approval banner is in the inbox).
    await logAiReply(db, {
      accountId, agentId: config.agentId, conversationId, outcome: 'replied',
      sourcesCount: knowledge.length, topScore: knowledge[0]?.score ?? null, question,
    })
    if (pendingApproval) await handOff(true, 'tool_approval')
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

interface HandoffContext {
  accountId: string
  conversationId: string
  contactId: string
  config: AiConfig
  messages: ChatMessage[]
  replyCount: number
  question: string
  /** What retrieval found for the last question (empty when nothing matched or it wasn't looked up). */
  knowledge: KnowledgeHit[]
}

/**
 * Stop auto-replying on this thread and hand it to a human: (a) pause the bot here (sticky until re-enabled),
 * (b) route the conversation to the next online person in the agent's pool - or leave it in the shared queue and
 * tell the whole pool when nobody is online - and (c) leave an internal note so whoever picks it up has context.
 * Assigning fires the `on_conversation_assigned` trigger, which notifies the agent. Never stomps an existing human
 * assignment.
 */
async function handOffConversation(
  db: ReturnType<typeof supabaseAdmin>,
  ctx: HandoffContext,
  reason: HandoffReason,
  pendingAction: boolean,
): Promise<void> {
  const { accountId, conversationId, contactId, config, knowledge, question } = ctx
  const summary = buildHandoffSummary({
    messages: ctx.messages,
    replyCount: ctx.replyCount,
    pendingAction,
    reason,
    knowledgeTitles: knowledge.map((k) => k.title ?? ''),
  })
  await db.from('conversations').update({ ai_autoreply_disabled: true, ai_handoff_summary: summary }).eq('id', conversationId)
  const { assignedTo } = await assignHandoff(db, {
    accountId, conversationId, contactId, agentId: config.agentId, legacyAssigneeId: config.handoffAgentId, question,
  })
  await logAiReply(db, {
    accountId, agentId: config.agentId, conversationId, outcome: 'handoff', handoffReason: reason,
    assignedTo, sourcesCount: knowledge.length, topScore: knowledge[0]?.score ?? null, question,
  })
}

async function hasNewerInbound(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('message_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data || data.length === 0) return false
  return data[0].message_id !== inboundMessageId
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * - the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}
