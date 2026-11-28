import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  queued: [] as { source_id: string }[],
  corrupt: false,
  run: vi.fn(),
  sourceUpdates: [] as string[][],
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acc-1', userId: 'user-1', role: 'admin', supabase: {} }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 500,
  }),
}))

vi.mock('@/lib/ai/embedder', () => ({
  loadEmbedder: async () => ({ embed: h.corrupt ? null : async () => [], source: h.corrupt ? 'none' : 'own', corrupt: h.corrupt }),
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      update: () => {
        if (table === 'ai_knowledge_documents') {
          return { eq: () => ({ select: async () => ({ data: h.queued, error: null }) }) }
        }
        return {
          in: async (_col: string, ids: string[]) => {
            h.sourceUpdates.push(ids)
            return { error: null }
          },
        }
      },
    }),
  }),
}))

vi.mock('@/lib/ai/ingest/pipeline', () => ({ runKnowledgeQueue: h.run }))

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function reindex() {
  return POST() as unknown as Promise<{ status: number; body: Record<string, unknown> }>
}

beforeEach(() => {
  __resetRateLimitForTests()
  h.corrupt = false
  h.queued = [{ source_id: 's1' }, { source_id: 's1' }, { source_id: 's2' }]
  h.sourceUpdates = []
  h.run.mockReset()
  h.run.mockResolvedValue({ synced: 0, discovered: 0, indexed: 3, unchanged: 0, failed: 0 })
})

describe('POST /api/ai/knowledge/reindex', () => {
  it("queues the account's documents and indexes them in-request", async () => {
    const res = await reindex()
    expect(res.body).toEqual({ success: true, semantic: true, total: 3, indexed: 3, failed: 0, remaining: 0 })
    expect(h.sourceUpdates).toEqual([['s1', 's2']])
    expect(h.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ onlyAccountId: 'acc-1' }))
  })

  it('reports failures and what the cron will finish', async () => {
    h.run.mockResolvedValue({ synced: 0, discovered: 0, indexed: 1, unchanged: 0, failed: 1 })
    const res = await reindex()
    expect(res.body).toMatchObject({ success: false, indexed: 1, failed: 1, remaining: 1 })
  })

  it('stops without indexing when the stored embeddings key is corrupt', async () => {
    h.corrupt = true
    const res = await reindex()
    expect(res.body).toMatchObject({ success: false, queued: 0 })
    expect(h.run).not.toHaveBeenCalled()
  })
})
