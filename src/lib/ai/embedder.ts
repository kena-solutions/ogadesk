import type { SupabaseClient } from '@supabase/supabase-js'

import { decryptSecretsObject } from '@/lib/payments/secrets'
import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from './admin-client'
import { aiBaseUrl, aiType, estimateCostUsd } from './catalogue'
import { EMBEDDING_DIMENSIONS, embedTexts, embedTextsWith, type EmbedResult, type EmbedTarget } from './embeddings'
import { creditError, platformCredits } from './run'
import { AiError } from './types'
import { logAiUsage, type LogAiUsageArgs } from './usage'

// ============================================================
// Who pays for embeddings (the vectors behind meaning-based knowledge search):
//   - the business, with its own OpenAI key (ai_configs.embeddings_api_key); or
//   - the platform, for businesses on OgaDesk AI: the admin-configured provider instances that list the 'embed'
//     purpose, in priority order with failover, counted against the plan's AI credits like chat tokens.
// No embeddings available (no key, no platform instance, out of credits) is not an error for the callers: search
// falls back to keywords and ingest stores the chunks keyword-only.
// ============================================================

export type Embedder = (inputs: string[]) => Promise<number[][]>

export const EMBED_PURPOSE = 'embed'
/** Thrown (quietly) when the platform has no usable embeddings instance: callers just use keywords. */
export const EMBED_UNAVAILABLE = 'embed_unavailable'

export const ownKeyEmbedder = (apiKey: string): Embedder => (inputs) => embedTexts(apiKey, inputs)

type RouteEntry = { id: string; kind: string; name: string; model: string; reason: string | null }

export interface EmbedDeps {
  admin: () => SupabaseClient
  embed: (target: EmbedTarget, inputs: string[]) => Promise<EmbedResult>
  log: (db: SupabaseClient, args: LogAiUsageArgs) => Promise<void>
  now: () => number
}
const defaultDeps: EmbedDeps = {
  admin: () => supabaseAdmin(),
  embed: (target, inputs) => embedTextsWith(target, inputs),
  log: (db, args) => logAiUsage(db, args),
  now: () => Date.now(),
}

// An empty route is remembered briefly so a business on platform AI whose admin hasn't set up embeddings doesn't
// cost two database calls on every reply.
const NO_ROUTE_TTL_MS = 60_000
let noRouteUntil = 0
export function __resetEmbedderCacheForTests() {
  noRouteUntil = 0
}

/** The embeddings URL for an instance: native OpenAI, or the compatible provider's base URL + /embeddings. */
export function embeddingsUrl(kind: string, config: Record<string, unknown>): string | null {
  const type = aiType(kind)
  if (!type) return null
  if (type.adapter === 'openai') return 'https://api.openai.com/v1/embeddings'
  if (type.adapter !== 'openai_compatible') return null // Anthropic has no embeddings endpoint
  const base = aiBaseUrl(kind, config)
  if (!base) return null
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`
}

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

export function platformEmbedder(accountId: string, deps: EmbedDeps = defaultDeps): Embedder {
  return async (inputs) => {
    if (inputs.length === 0) return []
    if (deps.now() < noRouteUntil) throw new AiError('No embeddings provider.', { code: EMBED_UNAVAILABLE, status: 503 })
    const admin = deps.admin()

    const route = ((await rpc<RouteEntry[]>(admin, 'ai_route', { p_purpose: EMBED_PURPOSE })) ?? []).filter((r) => !r.reason)
    if (route.length === 0) {
      noRouteUntil = deps.now() + NO_ROUTE_TTL_MS
      throw new AiError('No embeddings provider.', { code: EMBED_UNAVAILABLE, status: 503 })
    }
    const credits = await platformCredits(admin, accountId)
    if (!credits.allowed) throw creditError(credits)

    let last: unknown = null
    for (const inst of route) {
      try {
        const row = await rpc<{ kind: string; model: string; config: Record<string, unknown>; secrets: string | null; timeoutMs: number; priceIn: number } | null>(admin, 'ai_instance_secrets', { p_id: inst.id })
        const url = row ? embeddingsUrl(row.kind, row.config ?? {}) : null
        if (!row || !url) throw new AiError('Embeddings instance is not set up.', { code: 'not_configured', status: 503 })
        const secrets = await decryptSecretsObject(row.secrets)
        if (!secrets.api_key) throw new AiError('The provider key is missing.', { code: 'invalid_key', status: 401 })
        const result = await deps.embed(
          { apiKey: secrets.api_key, url, model: row.model, timeoutMs: row.timeoutMs, expectedDimensions: EMBEDDING_DIMENSIONS },
          inputs,
        )
        void admin.rpc('ai_instance_report', { p_id: inst.id, p_ok: true, p_error: null })
        void deps.log(admin, {
          accountId, conversationId: null, mode: 'embed', provider: row.kind, model: row.model,
          usage: { promptTokens: result.tokens, completionTokens: 0, totalTokens: result.tokens },
          source: 'platform', instanceId: inst.id, costUsd: estimateCostUsd(result.tokens, 0, Number(row.priceIn), 0),
        })
        return result.vectors
      } catch (e) {
        last = e
        void admin.rpc('ai_instance_report', { p_id: inst.id, p_ok: false, p_error: e instanceof Error ? e.message.slice(0, 300) : 'failed' })
      }
    }
    throw last instanceof AiError ? last : new AiError('Embeddings failed.', { code: 'provider_error', status: 503 })
  }
}

export interface LoadedEmbedder {
  embed: Embedder | null
  /** Which key pays: the business's own, the platform's instances, or nobody. */
  source: 'own' | 'platform' | 'none'
  /** A key is stored but can't be decrypted (rotated ENCRYPTION_KEY): the caller should say so. */
  corrupt: boolean
}

/** The embedder for a workspace, from its ai_configs row. Works with any client that can read that row. */
export async function loadEmbedder(db: SupabaseClient, accountId: string): Promise<LoadedEmbedder> {
  const { data, error } = await db.from('ai_configs').select('api_key, embeddings_api_key').eq('account_id', accountId).maybeSingle()
  if (error || !data) return { embed: null, source: 'none', corrupt: false }
  if (data.embeddings_api_key) {
    try {
      return { embed: ownKeyEmbedder(decrypt(data.embeddings_api_key as string)), source: 'own', corrupt: false }
    } catch {
      console.error(`[ai embedder] embeddings key for account ${accountId} could not be decrypted, check ENCRYPTION_KEY.`)
      return { embed: null, source: 'none', corrupt: true }
    }
  }
  // A NULL chat key means the business uses the platform's AI (same rule as loadAiConfig).
  if (data.api_key === null) return { embed: platformEmbedder(accountId), source: 'platform', corrupt: false }
  return { embed: null, source: 'none', corrupt: false }
}
