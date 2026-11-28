import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider, AiUsage } from './types'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: 'auto_reply' | 'draft' | 'playground' | 'embed'
  provider: AiProvider | string
  model: string
  /** Provider usage; a no-op when null (nothing worth recording). */
  usage: AiUsage | null
  /** The AI agent that made the call, when known. */
  agentId?: string | null
  /** 'platform' = served by an admin-configured instance (counts against plan credits). Default 'own'. */
  source?: 'own' | 'platform'
  instanceId?: string | null
  costUsd?: number | null
  /** Every instance tried, for failover analytics. */
  attempts?: unknown[]
  /** All instances failed: log the attempts even though no tokens were used. */
  failed?: boolean
}

/**
 * Best-effort append to `ai_usage_log` - one row per LLM call, for cost
 * visibility on the account's BYO key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 *
 * Pass the service-role admin client from the webhook, or the RLS-scoped
 * SSR client from a route - writes land either way (there's no
 * `authenticated` INSERT policy, so an SSR write relies on the service
 * role; callers that must persist from a route should pass the admin
 * client).
 */
export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage && !args.failed) return
  try {
    const { error } = await db.from('ai_usage_log').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      prompt_tokens: args.usage?.promptTokens ?? 0,
      completion_tokens: args.usage?.completionTokens ?? 0,
      total_tokens: args.usage?.totalTokens ?? 0,
      source: args.source ?? 'own',
      ...(args.instanceId ? { instance_id: args.instanceId } : {}),
      ...(args.costUsd != null ? { cost_usd: args.costUsd } : {}),
      ...(args.attempts ? { attempts: args.attempts } : {}),
      ...(args.agentId ? { agent_id: args.agentId } : {}),
    })
    if (error) {
      console.error('[ai usage] log insert failed:', error)
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err)
  }
}
