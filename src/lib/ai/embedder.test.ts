import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ credits: { allowed: true } as Record<string, unknown> }))
vi.mock('@/lib/payments/secrets', () => ({ decryptSecretsObject: async (s: string | null) => (s ? { api_key: `key:${s}` } : {}) }))
vi.mock('./run', () => ({
  platformCredits: async () => h.credits,
  creditError: () => Object.assign(new Error('credits'), { code: 'ai_credits_exhausted' }),
}))
vi.mock('./admin-client', () => ({ supabaseAdmin: () => ({}) }))

import { __resetEmbedderCacheForTests, embeddingsUrl, EMBED_UNAVAILABLE, platformEmbedder, type EmbedDeps } from './embedder'

interface Instance { id: string; kind: string; model: string; secrets: string | null; reason?: string | null; config?: Record<string, unknown> }

function setup(instances: Instance[], embedImpl?: EmbedDeps['embed']) {
  const rpcCalls: string[] = []
  const reports: { id: string; ok: boolean }[] = []
  const logs: Record<string, unknown>[] = []
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push(fn)
      if (fn === 'ai_route') return { data: instances.map((i) => ({ id: i.id, kind: i.kind, name: i.id, model: i.model, reason: i.reason ?? null })), error: null }
      if (fn === 'ai_instance_secrets') {
        const i = instances.find((x) => x.id === args.p_id)!
        return { data: { kind: i.kind, model: i.model, config: i.config ?? {}, secrets: i.secrets, timeoutMs: 1000, priceIn: 0.02 }, error: null }
      }
      if (fn === 'ai_instance_report') reports.push({ id: args.p_id as string, ok: args.p_ok as boolean })
      return { data: null, error: null }
    },
  } as unknown as SupabaseClient
  const embedCalls: { url?: string; model?: string; key: string; dims?: number }[] = []
  const deps: EmbedDeps = {
    admin: () => admin,
    embed:
      embedImpl ??
      (async (t, inputs) => {
        embedCalls.push({ url: t.url, model: t.model, key: t.apiKey, dims: t.expectedDimensions })
        return { vectors: inputs.map(() => [1]), tokens: inputs.length * 10 }
      }),
    log: async (_db, a) => void logs.push(a as unknown as Record<string, unknown>),
    now: Date.now,
  }
  return { deps, rpcCalls, reports, logs, embedCalls }
}

beforeEach(() => {
  __resetEmbedderCacheForTests()
  h.credits = { allowed: true }
})

describe('embeddingsUrl', () => {
  it('builds the endpoint per provider kind', () => {
    expect(embeddingsUrl('openai', {})).toBe('https://api.openai.com/v1/embeddings')
    expect(embeddingsUrl('openrouter', {})).toBe('https://openrouter.ai/api/v1/embeddings')
    expect(embeddingsUrl('openai_compatible', { base_url: 'https://x.test/v1/' })).toBe('https://x.test/v1/embeddings')
    expect(embeddingsUrl('anthropic', {})).toBeNull()
    expect(embeddingsUrl('nope', {})).toBeNull()
  })
})

describe('platformEmbedder', () => {
  it('embeds with the first eligible instance, logging tokens as platform embed usage', async () => {
    const s = setup([{ id: 'i1', kind: 'openai', model: 'text-embedding-3-small', secrets: 's1' }])
    const out = await platformEmbedder('acct', s.deps)(['a', 'b'])
    expect(out).toEqual([[1], [1]])
    expect(s.embedCalls[0]).toEqual({ url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small', key: 'key:s1', dims: 1536 })
    expect(s.logs[0]).toMatchObject({
      accountId: 'acct', mode: 'embed', source: 'platform', instanceId: 'i1',
      usage: { promptTokens: 20, completionTokens: 0, totalTokens: 20 },
    })
    expect(s.reports).toEqual([{ id: 'i1', ok: true }])
  })

  it('fails over to the next instance and reports the failure', async () => {
    let n = 0
    const s = setup(
      [
        { id: 'i1', kind: 'openai', model: 'm', secrets: 's1' },
        { id: 'i2', kind: 'openrouter', model: 'm2', secrets: 's2' },
      ],
      async (_t, inputs) => {
        if (n++ === 0) throw new Error('boom')
        return { vectors: inputs.map(() => [2]), tokens: 5 }
      },
    )
    expect(await platformEmbedder('acct', s.deps)(['a'])).toEqual([[2]])
    expect(s.reports).toEqual([{ id: 'i1', ok: false }, { id: 'i2', ok: true }])
  })

  it('skips instances that are not eligible (disabled, wrong purpose, cooling down)', async () => {
    const s = setup([
      { id: 'off', kind: 'openai', model: 'm', secrets: 's', reason: 'disabled' },
      { id: 'ok', kind: 'openai', model: 'm', secrets: 's2' },
    ])
    await platformEmbedder('acct', s.deps)(['a'])
    expect(s.logs[0]).toMatchObject({ instanceId: 'ok' })
  })

  it('says "unavailable" quietly when no instance serves embeddings, and remembers it briefly', async () => {
    const s = setup([])
    const embed = platformEmbedder('acct', s.deps)
    await expect(embed(['a'])).rejects.toMatchObject({ code: EMBED_UNAVAILABLE })
    const before = s.rpcCalls.length
    await expect(embed(['a'])).rejects.toMatchObject({ code: EMBED_UNAVAILABLE })
    expect(s.rpcCalls.length).toBe(before) // no extra database calls
  })

  it('refuses when the plan credits are used up, before calling any provider', async () => {
    h.credits = { allowed: false, reason: 'credits_exhausted' }
    const s = setup([{ id: 'i1', kind: 'openai', model: 'm', secrets: 's' }])
    await expect(platformEmbedder('acct', s.deps)(['a'])).rejects.toMatchObject({ code: 'ai_credits_exhausted' })
    expect(s.embedCalls).toEqual([])
  })

  it('does nothing for no input', async () => {
    const s = setup([])
    expect(await platformEmbedder('acct', s.deps)([])).toEqual([])
    expect(s.rpcCalls).toEqual([])
  })

  it('fails when every instance fails', async () => {
    const s = setup([{ id: 'i1', kind: 'openai', model: 'm', secrets: 's' }], async () => {
      throw new Error('down')
    })
    await expect(platformEmbedder('acct', s.deps)(['a'])).rejects.toMatchObject({ code: 'provider_error' })
  })
})
