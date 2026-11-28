import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

import { retrieveKnowledge, ingestDocument, sourceRefs, fuseRankings } from './knowledge'

interface FakeState {
  semantic: { id: string; content: string }[]
  fts: { id: string; content: string }[]
  chunkCount: number
  rpcCalls: string[]
  rpcArgs: Record<string, unknown>[]
  countScopedTo: string[] | null
  inserted: Record<string, unknown>[] | null
  deletedIds: string[] | null
  existingChunkIds: string[]
  events: string[]
  insertError: unknown
}

function makeDb() {
  const state: FakeState = {
    semantic: [],
    fts: [],
    chunkCount: 5, // account has a non-empty KB by default
    rpcCalls: [],
    rpcArgs: [],
    countScopedTo: null,
    inserted: null,
    deletedIds: null,
    existingChunkIds: ['old-1', 'old-2'],
    events: [],
    insertError: null,
  }
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push(name)
      state.rpcArgs.push(args)
      if (name === 'match_ai_knowledge_semantic_v2')
        return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'match_ai_knowledge_fts_v2')
        return Promise.resolve({ data: state.fts, error: null })
      return Promise.resolve({ data: null, error: null })
    },
    from: () => ({
      // retrieveKnowledge's empty-KB count guard.
      select: () => ({
        eq: () => {
          state.events.push('list')
          const result = Promise.resolve({
            count: state.chunkCount,
            data: state.existingChunkIds.map((id) => ({ id })),
            error: null,
          })
          // retrieveKnowledge narrows the count to the agent's sources.
          return Object.assign(result, {
            in: (_col: string, ids: string[]) => {
              state.countScopedTo = ids
              return result
            },
          })
        },
      }),
      delete: () => ({
        in: (_col: string, ids: string[]) => {
          state.events.push('delete')
          state.deletedIds = [...(state.deletedIds ?? []), ...ids]
          return Promise.resolve({ error: null })
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        state.events.push('insert')
        if (state.insertError) return Promise.resolve({ error: state.insertError })
        state.inserted = rows
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

type Row = { id: string; content: string; score?: number; source_id?: string; document_id?: string; doc_title?: string }

describe('retrieveKnowledge', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, '  ')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 0
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q')).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
  })

  it('uses keywords only when there is no embeddings key, without stopwords', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'What is the refund policy?')
    expect(out.map((h) => h.content)).toEqual(['F1'])
    expect(out[0].matchedBy).toBe('keyword')
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_fts_v2'])
    expect(state.rpcArgs[0].p_query).toBe('refund policy')
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('skips the keyword search when the question is only stopwords', async () => {
    const { db, state } = makeDb()
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'what is this?')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('runs both searches and ranks chunks found by both first', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 'a', content: 'A', score: 0.6 },
      { id: 'b', content: 'B', score: 0.5 },
    ] as Row[]
    state.fts = [
      { id: 'b', content: 'B', score: 0.2 },
      { id: 'c', content: 'C', score: 0.1 },
    ] as Row[]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'shipping cost', { k: 3 })
    expect(out.map((h) => [h.chunkId, h.matchedBy])).toEqual([
      ['b', 'both'],
      ['a', 'semantic'],
      ['c', 'keyword'],
    ])
    // The semantic similarity is kept as the shown score.
    expect(out[0].score).toBe(0.5)
    expect(state.rpcCalls.sort()).toEqual(['match_ai_knowledge_fts_v2', 'match_ai_knowledge_semantic_v2'])
  })

  it('drops semantic matches below the similarity floor', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 'near', content: 'N', score: 0.45 },
      { id: 'far', content: 'F', score: 0.12 },
    ] as Row[]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'opening hours')
    expect(out.map((h) => h.chunkId)).toEqual(['near'])
  })

  it('returns nothing when no match is relevant, so the agent can hand off', async () => {
    const { db, state } = makeDb()
    state.semantic = [{ id: 'x', content: 'X', score: 0.05 }] as Row[]
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'quantum physics')).toEqual([])
  })

  it('returns where each excerpt came from', async () => {
    const { db, state } = makeDb()
    state.fts = [
      { id: 'c1', content: 'Refunds within 30 days', source_id: 'src-1', document_id: 'doc-1', doc_title: 'Returns policy', score: 0.4 },
    ] as Row[]
    const [hit] = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'refund')
    expect(hit).toEqual({
      chunkId: 'c1',
      sourceId: 'src-1',
      documentId: 'doc-1',
      title: 'Returns policy',
      content: 'Refunds within 30 days',
      score: 0.4,
      matchedBy: 'keyword',
    })
  })

  it('searches the whole library when no sources are given', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'delivery')
    expect(state.countScopedTo).toBeNull()
    expect(state.rpcArgs[0].p_source_ids).toBeNull()
  })

  it("limits the search to an agent's linked sources", async () => {
    const { db, state } = makeDb()
    await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'delivery', {
      sourceIds: ['src-a', 'src-b'],
    })
    expect(state.countScopedTo).toEqual(['src-a', 'src-b'])
    expect(state.rpcArgs.map((a) => a.p_source_ids)).toEqual([
      ['src-a', 'src-b'],
      ['src-a', 'src-b'],
    ])
  })

  it('returns nothing, with no embed or RPC, for an agent with no linked sources', async () => {
    const { db, state } = makeDb()
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', { sourceIds: [] })
    expect(out).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
    expect(state.events).toEqual([])
  })
})

describe('retrieveKnowledge with a platform embedder', () => {
  it('searches by meaning through the given embedder, without an own key', async () => {
    const { db, state } = makeDb()
    state.semantic = [{ id: 's1', content: 'S1', score: 0.7 }] as Row[]
    const embedder = vi.fn(async (inputs: string[]) => inputs.map(() => [0.5]))
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null, embedder }, 'delivery time')
    expect(embedder).toHaveBeenCalledWith(['delivery time'])
    expect(out.map((h) => h.matchedBy)).toEqual(['semantic'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('quietly uses keywords when the platform has no embeddings provider', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const embedder = vi.fn(async () => {
      throw Object.assign(new Error('none'), { code: 'embed_unavailable' })
    })
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null, embedder }, 'delivery time')
    expect(out.map((x) => x.matchedBy)).toEqual(['keyword'])
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('embeds new chunks through the embedder at ingest', async () => {
    const { db, state } = makeDb()
    const embedder = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 2]))
    const result = await ingestDocument(db, 'acct', { embeddingsApiKey: null, embedder }, 'doc-1', 'hello world', { title: 'FAQ' })
    expect(embedder).toHaveBeenCalledWith(['FAQ\n\nhello world'])
    expect(result.keywordOnly).toBe(false)
    expect(state.inserted![0].embedding).toBe('[1,2]')
  })
})

describe('re-ranking', () => {
  const hit = (chunkId: string, content: string, title: string | null = null) => ({
    chunkId, documentId: 'd', sourceId: 's', title, content, score: 0.5, matchedBy: 'semantic' as const,
  })

  it('breaks a near-tie in favour of the chunk that contains the question words', () => {
    // Semantic ranks the vague chunk first, but only the second one answers a question about refund timing.
    const vague = hit('vague', 'We care about every customer and want you to be happy.')
    const exact = hit('exact', 'Refunds take 5 business days to reach your account.')
    const out = fuseRankings([vague, exact], [], 2, 'how long do refunds take')
    expect(out.map((h) => h.chunkId)).toEqual(['exact', 'vague'])
  })

  it('rewards a title that mentions the question', () => {
    const a = hit('a', 'Our hours are 9 to 5.', 'Opening hours')
    const b = hit('b', 'Our hours are 9 to 5.', 'About us')
    expect(fuseRankings([b, a], [], 2, 'what are your opening hours').map((h) => h.chunkId)[0]).toBe('a')
  })

  it('does not overturn a clear winner found by both searches', () => {
    const both = hit('both', 'Unrelated words here.')
    const lexical = hit('lex', 'refund refund timing')
    const out = fuseRankings([both, hit('x', 'q')], [both, lexical], 3, 'refund timing')
    expect(out[0].chunkId).toBe('both')
  })

  it('keeps the order when the question has no usable words', () => {
    const out = fuseRankings([hit('a', 'one'), hit('b', 'two')], [], 2, 'is it the one?')
    expect(out.map((h) => h.chunkId)).toEqual(['a', 'b'])
  })
})

describe('sourceRefs', () => {
  it('keeps one reference per document, best first', () => {
    const hit = (chunkId: string, documentId: string, score: number) => ({
      chunkId, documentId, sourceId: 's', title: documentId, content: '', score, matchedBy: 'semantic' as const,
    })
    expect(sourceRefs([hit('c1', 'd1', 0.81234), hit('c2', 'd1', 0.5), hit('c3', 'd2', 0.4)])).toEqual([
      { source_id: 's', document_id: 'd1', title: 'd1', score: 0.812, matched_by: 'semantic' },
      { source_id: 's', document_id: 'd2', title: 'd2', score: 0.4, matched_by: 'semantic' },
    ])
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    const { db, state } = makeDb()
    const result = await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(result).toEqual({ keywordOnly: false, embedError: null, chunkCount: 1 })
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(state.deletedIds).toEqual(['old-1', 'old-2'])
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBe('[0,0]') // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', '   ')
    expect(state.deletedIds).toEqual(['old-1', 'old-2'])
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('reports keyword-only success when embedding fails', async () => {
    const { db, state } = makeDb()
    const embedError = new Error('rate limited')
    h.embedTexts.mockRejectedValueOnce(embedError)
    const result = await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(result).toEqual({ keywordOnly: true, embedError, chunkCount: 1 })
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('keeps the existing chunks until the embed has finished', async () => {
    const { db, state } = makeDb()
    h.embedTexts.mockImplementationOnce(async () => {
      expect(state.events).toEqual([])
      throw new Error('timeout')
    })
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(state.events).toEqual(['list', 'insert', 'delete'])
  })

  it('keeps the existing chunks when the insert fails', async () => {
    const { db, state } = makeDb()
    state.insertError = new Error('insert failed')
    await expect(
      ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world'),
    ).rejects.toThrow('insert failed')
    expect(state.deletedIds).toBeNull()
  })

  it('deletes previous chunks in batches', async () => {
    const { db, state } = makeDb()
    state.existingChunkIds = Array.from({ length: 250 }, (_, i) => `old-${i}`)
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    expect(state.events.filter((e) => e === 'delete')).toHaveLength(3)
    expect(state.deletedIds).toHaveLength(250)
  })
})
