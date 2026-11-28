import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasReplySince, inboundArrivedAt, logAiReply } from './reply-log'

/** A chainable fake that records filters and resolves to `result`. */
function fake(result: { data: unknown; error?: unknown }) {
  const calls: [string, unknown[]][] = []
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'neq', 'gte', 'order', 'limit']) {
    chain[m] = (...a: unknown[]) => {
      calls.push([m, a])
      return chain
    }
  }
  chain.maybeSingle = async () => ({ data: result.data, error: result.error ?? null })
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: result.data, error: result.error ?? null })
  chain.insert = async (row: unknown) => {
    calls.push(['insert', [row]])
    return { error: result.error ?? null }
  }
  const db = { from: () => chain } as unknown as SupabaseClient
  return { db, calls }
}

describe('hasReplySince', () => {
  it("counts only the business's own non-AI, non-event messages after the customer's", async () => {
    const { db, calls } = fake({ data: [{ id: 'm1' }] })
    expect(await hasReplySince(db, 'c1', '2026-11-28T10:00:00Z')).toBe(true)
    const names = calls.map(([m, a]) => `${m}:${a.join(',')}`)
    expect(names).toContain('in:sender_type,agent,bot')
    expect(names).toContain('eq:ai_generated,false')
    expect(names).toContain('neq:content_type,event')
    expect(names).toContain('gte:created_at,2026-11-28T10:00:00Z')
  })

  it('is false with no replies, no timestamp, or a lookup error (fails open)', async () => {
    expect(await hasReplySince(fake({ data: [] }).db, 'c1', '2026-11-28T10:00:00Z')).toBe(false)
    expect(await hasReplySince(fake({ data: [{ id: 1 }] }).db, 'c1', null)).toBe(false)
    expect(await hasReplySince(fake({ data: null, error: new Error('x') }).db, 'c1', '2026-11-28T10:00:00Z')).toBe(false)
  })
})

describe('inboundArrivedAt', () => {
  it('uses the message with the given id, else the latest customer message', async () => {
    expect(await inboundArrivedAt(fake({ data: { created_at: 'T1' } }).db, 'c1', 'wamid.1')).toBe('T1')
    expect(await inboundArrivedAt(fake({ data: null }).db, 'c1')).toBeNull()
  })
})

describe('logAiReply', () => {
  it('trims the question and never throws', async () => {
    const { db, calls } = fake({ data: null })
    await logAiReply(db, { accountId: 'a', conversationId: 'c', outcome: 'handoff', handoffReason: 'model', question: 'x'.repeat(500) })
    const row = calls.find(([m]) => m === 'insert')![1][0] as Record<string, unknown>
    expect((row.question as string).length).toBe(300)
    expect(row.handoff_reason).toBe('model')
    await expect(logAiReply(fake({ data: null, error: new Error('boom') }).db, { accountId: 'a', conversationId: 'c', outcome: 'replied' })).resolves.toBeUndefined()
  })
})
