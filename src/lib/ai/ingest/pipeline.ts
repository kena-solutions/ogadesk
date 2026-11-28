// ============================================================
// Knowledge library pipeline. A source owns documents; each document is
// fetched (web pages), chunked and embedded once, then searched by every
// agent linked to the source.
//
//   queued source (website)  --discover-->  queued documents (one per page)
//   queued document          --index----->  ready | failed
//   source status            = roll-up of its documents
//
// Runs from the create/sync routes (a first slice, so results show at
// once) and from the 5-minute cron (the rest, plus scheduled re-syncs).
// Always uses the service-role client: callers authorise first.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { chunkText } from '../chunk'
import { ingestDocument } from '../knowledge'
import { EMBED_UNAVAILABLE, loadEmbedder, type Embedder } from '../embedder'
import { htmlToText } from './html'
import { qaChunks } from './qa'
import { capText, KNOWLEDGE_LIMITS, nextSyncAt, type SourceType, type SyncInterval } from './limits'
import { fetchPage, type PageFetcher } from './fetch'
import { discoverWebsitePages } from './website'
import { parsePathPrefixes } from './crawl-rules'

export type SourceStatus = 'queued' | 'processing' | 'ready' | 'partial' | 'failed'
export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed'

export interface SourceRow {
  id: string
  account_id: string
  type: SourceType
  status: SourceStatus
  config: Record<string, unknown> | null
  sync_interval: SyncInterval
}

export interface DocumentRow {
  id: string
  account_id: string
  source_id: string
  title: string
  content: string
  url: string | null
  content_hash: string | null
  chunk_count: number
}

export const SOURCE_COLUMNS = 'id, account_id, type, status, config, sync_interval'
const STALE_DISCOVERY_MS = 15 * 60_000
const DOC_COLUMNS = 'id, account_id, source_id, title, content, url, content_hash, chunk_count'

/** Chunks for a document, by source type. */
export function chunksFor(type: SourceType, content: string): string[] {
  return type === 'qa' ? qaChunks(content) : chunkText(content)
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A source's status from its documents' statuses. */
export function rollupStatus(statuses: DocumentStatus[]): SourceStatus {
  if (statuses.length === 0) return 'failed'
  if (statuses.some((s) => s === 'queued' || s === 'processing')) return 'processing'
  const failed = statuses.filter((s) => s === 'failed').length
  if (failed === 0) return 'ready'
  return failed === statuses.length ? 'failed' : 'partial'
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.slice(0, 500)
}

/**
 * Fetch (web pages), chunk and embed one document. Never throws: a
 * failure is recorded on the document. Unchanged content (same hash, and
 * already chunked) is not re-embedded.
 */
export async function indexDocument(
  db: SupabaseClient,
  doc: DocumentRow,
  source: Pick<SourceRow, 'type'>,
  embedder: Embedder | null,
  fetcher: PageFetcher = fetchPage,
): Promise<'ready' | 'unchanged' | 'failed'> {
  try {
    let content = doc.content
    let title = doc.title
    if (doc.url && (source.type === 'url' || source.type === 'website')) {
      const page = await fetcher(doc.url)
      const isHtml = /html/i.test(page.contentType) || /<(html|body)\b/i.test(page.body)
      const extracted = isHtml ? htmlToText(page.body) : { title: null, text: page.body }
      content = capText(extracted.text)
      title = extracted.title ?? title
      if (!content.trim()) throw new Error('No readable text on this page.')
    }

    const hash = await sha256(content)
    if (hash === doc.content_hash && doc.chunk_count > 0) {
      await db
        .from('ai_knowledge_documents')
        .update({ status: 'ready', error: null, claimed_at: null })
        .eq('id', doc.id)
      return 'unchanged'
    }

    const result = await ingestDocument(
      db,
      doc.account_id,
      { embeddingsApiKey: null, embedder },
      doc.id,
      content,
      { chunks: chunksFor(source.type, content), title },
    )
    await db
      .from('ai_knowledge_documents')
      .update({
        title: title.slice(0, 300),
        content,
        // Keyword-only (embedding failed) keeps no hash, so the next sync retries the embed.
        content_hash: result.keywordOnly ? null : hash,
        status: 'ready',
        // 'No embeddings provider' is a normal state (no key / platform has none): not worth a warning on every document.
        error:
          result.keywordOnly && (result.embedError as { code?: string } | null)?.code !== EMBED_UNAVAILABLE
            ? `Indexed for keyword search only: ${errorMessage(result.embedError)}`
            : null,
        chunk_count: result.chunkCount,
        claimed_at: null,
      })
      .eq('id', doc.id)
    return 'ready'
  } catch (err) {
    await db
      .from('ai_knowledge_documents')
      .update({ status: 'failed', error: errorMessage(err), claimed_at: null })
      .eq('id', doc.id)
    return 'failed'
  }
}

/** Recompute a source's status and counts from its documents. */
export async function refreshSource(db: SupabaseClient, sourceId: string): Promise<SourceStatus | null> {
  const { data: docs, error } = await db
    .from('ai_knowledge_documents')
    .select('status, chunk_count, error')
    .eq('source_id', sourceId)
  if (error) return null
  const rows = (docs ?? []) as { status: DocumentStatus; chunk_count: number; error: string | null }[]

  const { data: src } = await db.from('ai_knowledge_sources').select('status, error').eq('id', sourceId).maybeSingle()
  // A website still waiting for discovery has no documents yet.
  if (rows.length === 0 && src?.status === 'queued') return 'queued'

  const status = rollupStatus(rows.map((r) => r.status))
  const update: Record<string, unknown> = {
    status,
    doc_count: rows.length,
    chunk_count: rows.reduce((n, r) => n + (r.chunk_count ?? 0), 0),
  }
  if (status !== 'processing') update.last_synced_at = new Date().toISOString()
  if (status === 'ready') update.error = null
  else if (status === 'failed' && rows.length > 0) update.error = rows.find((r) => r.error)?.error ?? null
  else if (status === 'failed') update.error = src?.error ?? 'Nothing to index.'
  await db.from('ai_knowledge_sources').update(update).eq('id', sourceId)
  return status
}

/** Website config from a source row, with safe defaults. */
export function websiteConfig(config: Record<string, unknown> | null) {
  const c = config ?? {}
  const maxPages = Number(c.maxPages)
  return {
    startUrl: typeof c.startUrl === 'string' ? c.startUrl : '',
    maxPages: Number.isFinite(maxPages)
      ? Math.min(KNOWLEDGE_LIMITS.maxWebsitePages, Math.max(1, Math.floor(maxPages)))
      : KNOWLEDGE_LIMITS.defaultWebsitePages,
    include: parsePathPrefixes(c.include),
    exclude: parsePathPrefixes(c.exclude),
  }
}

/**
 * Find a website's pages and queue one document per page. Pages that are
 * no longer found are removed; pages already indexed are re-queued (their
 * hash skips the embed when unchanged).
 */
export async function discoverSource(
  db: SupabaseClient,
  source: SourceRow,
  fetcher: PageFetcher = fetchPage,
  deadline?: number,
): Promise<number> {
  await db.from('ai_knowledge_sources').update({ status: 'processing', error: null }).eq('id', source.id)
  const cfg = websiteConfig(source.config)
  let urls: string[] = []
  try {
    urls = (await discoverWebsitePages(cfg, fetcher, deadline)).urls
  } catch (err) {
    await db.from('ai_knowledge_sources').update({ status: 'failed', error: errorMessage(err) }).eq('id', source.id)
    return 0
  }

  const { data: existing } = await db.from('ai_knowledge_documents').select('id, url').eq('source_id', source.id)
  const byUrl = new Map(((existing ?? []) as { id: string; url: string | null }[]).map((d) => [d.url, d.id]))

  // Stay inside the account's document budget.
  const { count } = await db
    .from('ai_knowledge_documents')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', source.account_id)
  const room = Math.max(0, KNOWLEDGE_LIMITS.maxDocsPerAccount - (count ?? 0))
  const fresh = urls.filter((u) => !byUrl.has(u)).slice(0, room)
  const keep = new Set(urls)

  const stale = [...byUrl.entries()].filter(([u]) => !u || !keep.has(u)).map(([, id]) => id)
  if (stale.length > 0) await db.from('ai_knowledge_documents').delete().in('id', stale)
  const requeue = [...byUrl.entries()].filter(([u]) => u && keep.has(u)).map(([, id]) => id)
  if (requeue.length > 0) {
    await db.from('ai_knowledge_documents').update({ status: 'queued', error: null }).in('id', requeue)
  }
  if (fresh.length > 0) {
    await db.from('ai_knowledge_documents').insert(
      fresh.map((url) => ({
        account_id: source.account_id,
        source_id: source.id,
        title: url,
        content: '',
        url,
        status: 'queued',
      })),
    )
  }

  const total = fresh.length + requeue.length
  if (total === 0) {
    await db
      .from('ai_knowledge_sources')
      .update({ status: 'failed', error: 'No pages found. Check the address, or that the site allows crawling.' })
      .eq('id', source.id)
  }
  return total
}

/** Start a re-sync: websites rediscover, single pages refetch. */
export async function queueSourceSync(db: SupabaseClient, source: SourceRow): Promise<void> {
  const next = nextSyncAt(source.sync_interval)
  if (source.type === 'website') {
    await db.from('ai_knowledge_sources').update({ status: 'queued', error: null, next_sync_at: next }).eq('id', source.id)
    return
  }
  await db.from('ai_knowledge_documents').update({ status: 'queued', error: null }).eq('source_id', source.id)
  await db.from('ai_knowledge_sources').update({ status: 'processing', error: null, next_sync_at: next }).eq('id', source.id)
}

export interface QueueRunStats {
  synced: number
  discovered: number
  indexed: number
  unchanged: number
  failed: number
}

/**
 * Work the queue until `deadline`: due re-syncs, website discovery, then
 * documents in batches. `onlySourceId` limits the run to one source (the
 * create/sync routes).
 */
export async function runKnowledgeQueue(
  db: SupabaseClient,
  opts: {
    deadline: number
    batch?: number
    /** Limit the run to one source (create / sync routes)… */
    onlySourceId?: string
    /** …or one account (reindex). Unscoped = the cron, all accounts. */
    onlyAccountId?: string
    fetcher?: PageFetcher
  },
): Promise<QueueRunStats> {
  const scoped = Boolean(opts.onlySourceId || opts.onlyAccountId)
  const stats: QueueRunStats = { synced: 0, discovered: 0, indexed: 0, unchanged: 0, failed: 0 }
  const fetcher = opts.fetcher ?? fetchPage
  const batch = opts.batch ?? 5
  const touched = new Set<string>()

  if (!scoped) {
    // A website whose discovery was cut off (crashed run) is left
    // 'processing' with no pages; send it back for discovery.
    await db
      .from('ai_knowledge_sources')
      .update({ status: 'queued' })
      .eq('type', 'website')
      .eq('status', 'processing')
      .eq('doc_count', 0)
      .lt('updated_at', new Date(Date.now() - STALE_DISCOVERY_MS).toISOString())

    const { data: due } = await db
      .from('ai_knowledge_sources')
      .select(SOURCE_COLUMNS)
      .in('type', ['url', 'website'])
      .lte('next_sync_at', new Date().toISOString())
      .limit(20)
    for (const s of (due ?? []) as SourceRow[]) {
      await queueSourceSync(db, s)
      stats.synced += 1
    }
  }

  let discoverQuery = db
    .from('ai_knowledge_sources')
    .select(SOURCE_COLUMNS)
    .eq('type', 'website')
    .eq('status', 'queued')
    .limit(3)
  if (opts.onlySourceId) discoverQuery = discoverQuery.eq('id', opts.onlySourceId)
  if (opts.onlyAccountId) discoverQuery = discoverQuery.eq('account_id', opts.onlyAccountId)
  const { data: toDiscover } = await discoverQuery
  for (const s of (toDiscover ?? []) as SourceRow[]) {
    if (Date.now() >= opts.deadline) break
    stats.discovered += await discoverSource(db, s, fetcher, opts.deadline)
    touched.add(s.id)
  }

  const sources = new Map<string, SourceRow>()
  const embedders = new Map<string, Embedder | null>()
  while (Date.now() < opts.deadline) {
    let docs: DocumentRow[]
    if (scoped) {
      let q = db.from('ai_knowledge_documents').select(DOC_COLUMNS).eq('status', 'queued')
      q = opts.onlySourceId ? q.eq('source_id', opts.onlySourceId) : q.eq('account_id', opts.onlyAccountId as string)
      const { data } = await q.limit(batch)
      docs = (data ?? []) as DocumentRow[]
      if (docs.length > 0) {
        await db
          .from('ai_knowledge_documents')
          .update({ status: 'processing', claimed_at: new Date().toISOString() })
          .in('id', docs.map((d) => d.id))
      }
    } else {
      const { data, error } = await db.rpc('claim_ai_knowledge_documents', { p_limit: batch })
      if (error) {
        console.error('[knowledge queue] claim failed:', error)
        break
      }
      docs = (data ?? []) as DocumentRow[]
    }
    if (docs.length === 0) break

    for (const doc of docs) {
      let source = sources.get(doc.source_id)
      if (!source) {
        const { data } = await db.from('ai_knowledge_sources').select(SOURCE_COLUMNS).eq('id', doc.source_id).maybeSingle()
        if (!data) continue
        source = data as SourceRow
        sources.set(source.id, source)
      }
      if (!embedders.has(doc.account_id)) {
        embedders.set(doc.account_id, (await loadEmbedder(db, doc.account_id)).embed)
      }
      const outcome = await indexDocument(db, doc, source, embedders.get(doc.account_id) ?? null, fetcher)
      if (outcome === 'ready') stats.indexed += 1
      else if (outcome === 'unchanged') stats.unchanged += 1
      else stats.failed += 1
      touched.add(doc.source_id)
    }
  }

  for (const id of touched) await refreshSource(db, id)
  return stats
}
