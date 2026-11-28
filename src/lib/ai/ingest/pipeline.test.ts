import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ ingest: vi.fn() }))
vi.mock('../knowledge', () => ({ ingestDocument: h.ingest }))
vi.mock('../embedder', () => ({ loadEmbedder: async () => ({ embed: null, source: 'none', corrupt: false }), EMBED_UNAVAILABLE: 'embed_unavailable' }))

import { chunksFor, indexDocument, rollupStatus, sha256, type DocumentRow } from './pipeline'
import { FetchPageError, type PageFetcher } from './fetch'

/** Records document updates. */
function fakeDb() {
  const updates: Record<string, unknown>[] = []
  const db = {
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        updates.push(payload)
        return { eq: async () => ({ error: null }) }
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, updates }
}

const doc = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  id: 'd1',
  account_id: 'a1',
  source_id: 's1',
  title: 'https://acme.com/faq',
  content: '',
  url: 'https://acme.com/faq',
  content_hash: null,
  chunk_count: 0,
  ...over,
})

const emb = async (inputs: string[]) => inputs.map(() => [0])
const page = (body: string): PageFetcher => async (url) => ({ url, contentType: 'text/html', body })

beforeEach(() => {
  h.ingest.mockReset()
  h.ingest.mockResolvedValue({ keywordOnly: false, embedError: null, chunkCount: 2 })
})

describe('rollupStatus', () => {
  it('summarises document states', () => {
    expect(rollupStatus(['ready', 'ready'])).toBe('ready')
    expect(rollupStatus(['ready', 'queued'])).toBe('processing')
    expect(rollupStatus(['ready', 'failed'])).toBe('partial')
    expect(rollupStatus(['failed'])).toBe('failed')
    expect(rollupStatus([])).toBe('failed')
  })
})

describe('chunksFor', () => {
  it('splits Q&A per pair and other text by paragraph', () => {
    expect(chunksFor('qa', 'Q: a\nA: b\n\nQ: c\nA: d')).toHaveLength(2)
    expect(chunksFor('text', 'one\n\ntwo')).toHaveLength(1)
  })
})

describe('indexDocument', () => {
  it('fetches a page, extracts its text and title, and indexes it', async () => {
    const { db, updates } = fakeDb()
    const out = await indexDocument(db, doc(), { type: 'website' }, emb, page('<title>FAQ</title><p>Hello there</p>'))
    expect(out).toBe('ready')
    expect(h.ingest).toHaveBeenCalledWith(db, 'a1', { embeddingsApiKey: null, embedder: emb }, 'd1', 'Hello there', { chunks: ['Hello there'], title: 'FAQ' })
    expect(updates.at(-1)).toMatchObject({ title: 'FAQ', content: 'Hello there', status: 'ready', chunk_count: 2, error: null })
    expect(updates.at(-1)!.content_hash).toBe(await sha256('Hello there'))
  })

  it('skips the embed when the page has not changed', async () => {
    const { db, updates } = fakeDb()
    const hash = await sha256('Hello there')
    const out = await indexDocument(db, doc({ content_hash: hash, chunk_count: 1 }), { type: 'url' }, emb, page('<p>Hello there</p>'))
    expect(out).toBe('unchanged')
    expect(h.ingest).not.toHaveBeenCalled()
    expect(updates.at(-1)).toMatchObject({ status: 'ready' })
  })

  it('indexes stored text without fetching', async () => {
    const { db } = fakeDb()
    const fetcher = vi.fn()
    await indexDocument(db, doc({ url: null, content: 'Q: a\nA: b' }), { type: 'qa' }, null, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(h.ingest.mock.calls[0][5]).toMatchObject({ chunks: ['Q: a\nA: b'] })
  })

  it('records a failed fetch on the document instead of throwing', async () => {
    const { db, updates } = fakeDb()
    const failing: PageFetcher = async () => {
      throw new FetchPageError('http', 'https://acme.com/faq returned HTTP 404')
    }
    await expect(indexDocument(db, doc(), { type: 'url' }, null, failing)).resolves.toBe('failed')
    expect(updates.at(-1)).toMatchObject({ status: 'failed', error: 'https://acme.com/faq returned HTTP 404' })
  })

  it('fails a page with no readable text', async () => {
    const { db, updates } = fakeDb()
    await indexDocument(db, doc(), { type: 'url' }, null, page('<script>x()</script>'))
    expect(updates.at(-1)).toMatchObject({ status: 'failed' })
  })

  it('keeps no hash when only keyword indexing worked, so a sync retries the embed', async () => {
    const { db, updates } = fakeDb()
    h.ingest.mockResolvedValue({ keywordOnly: true, embedError: new Error('rate limited'), chunkCount: 1 })
    await indexDocument(db, doc({ url: null, content: 'Hi' }), { type: 'text' }, emb)
    expect(updates.at(-1)).toMatchObject({ content_hash: null, status: 'ready' })
    expect(String(updates.at(-1)!.error)).toContain('rate limited')
  })
})
