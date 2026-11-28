import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig, KnowledgeHit } from './types'
import { chunkText } from './chunk'
import { toVectorLiteral } from './embeddings'
import { EMBED_UNAVAILABLE, ownKeyEmbedder, type Embedder } from './embedder'
import { keywordQuery } from './query'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

/** What meaning-based search can use: the business's own key, or an embedder (platform AI). */
export type EmbedConfig = Pick<AiConfig, 'embeddingsApiKey'> & { embedder?: Embedder | null }

export function embedderOf(config: EmbedConfig): Embedder | null {
  return config.embedder ?? (config.embeddingsApiKey ? ownKeyEmbedder(config.embeddingsApiKey) : null)
}

export interface IngestResult {
  keywordOnly: boolean
  embedError: unknown
  chunkCount: number
}

const CHUNK_DELETE_BATCH = 100

interface MatchRow {
  id: string
  content: string
  source_id?: string | null
  document_id?: string | null
  doc_title?: string | null
  score?: number | null
}

/**
 * (Re)build the chunks for one document. Re-chunks the content and -
 * when the account has an embeddings key - embeds each chunk. Runs under
 * whatever client the caller passes (service-role for ingest routes).
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: EmbedConfig,
  documentId: string,
  content: string,
  opts: {
    chunks?: string[]
    /** Document title: prefixed to each chunk's embedding input (not to the
     *  stored text) so a question that names the topic finds it. */
    title?: string | null
  } = {},
): Promise<IngestResult> {
  // Callers may pre-split (e.g. one chunk per Q&A pair); default is the
  // paragraph-aware chunker.
  const chunks = opts.chunks ?? chunkText(content)

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  const embed = embedderOf(config)
  if (embed && chunks.length > 0) {
    try {
      const title = opts.title?.trim()
      embeddings = await embed(title ? chunks.map((c) => `${title}\n\n${c}`) : chunks)
    } catch (err) {
      embedError = err
    }
  }

  const { data: previousChunks, error: listErr } = await db
    .from('ai_knowledge_chunks')
    .select('id')
    .eq('document_id', documentId)
  if (listErr) throw listErr

  if (chunks.length > 0) {
    const rows = chunks.map((content, i) => ({
      document_id: documentId,
      account_id: accountId,
      chunk_index: i,
      content,
      embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
    }))
    const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
    if (insErr) throw insErr
  }

  const previousIds = (previousChunks ?? []).map((row: { id: string }) => row.id)
  for (let i = 0; i < previousIds.length; i += CHUNK_DELETE_BATCH) {
    const { error: delErr } = await db
      .from('ai_knowledge_chunks')
      .delete()
      .in('id', previousIds.slice(i, i + CHUNK_DELETE_BATCH))
    if (delErr) throw delErr
  }

  return { keywordOnly: embedError !== null, embedError, chunkCount: chunks.length }
}

export interface RetrieveOptions {
  /** Max excerpts to return (default 5). */
  k?: number
  /** Library sources to search. null/undefined = the whole library;
   *  [] = nothing (an agent with no linked knowledge). */
  sourceIds?: string[] | null
  /** Override the semantic similarity floor (tests, test-search tuning). */
  minSimilarity?: number
}

/** Semantic matches below this cosine similarity are dropped as noise.
 *  Tuned for text-embedding-3-small, where unrelated text scores ~0.1-0.25
 *  and on-topic text ~0.4+. Override with AI_KNOWLEDGE_MIN_SIMILARITY. */
export const DEFAULT_MIN_SIMILARITY = 0.3

export function minSimilarity(): number {
  const raw = Number(process.env.AI_KNOWLEDGE_MIN_SIMILARITY)
  return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : DEFAULT_MIN_SIMILARITY
}

/** Reciprocal Rank Fusion constant (the usual 60). */
const RRF_K = 60
/** Candidates fetched from each path per result returned. */
const CANDIDATE_FACTOR = 3

/**
 * Merge ranked lists with Reciprocal Rank Fusion: a chunk scores
 * sum(1 / (RRF_K + rank)) over the lists it appears in, so a chunk found
 * by both meaning and keywords outranks one found by either alone.
 * Each list must already be best-first.
 */
/** How much re-ranking can move a chunk: about the gap between ranks 1 and 2 in one list, so it breaks near-ties
 *  (the chunk that really contains the question's words wins) without overturning a clear winner. */
const COVERAGE_WEIGHT = 0.012
const TITLE_WEIGHT = 0.006

/** Words of the question that count for matching (stopwords removed); [] when there are none. */
function queryTerms(query: string | undefined): string[] {
  return query ? keywordQuery(query).split(' ').filter(Boolean) : []
}

/**
 * Re-rank candidates (already fused) by how well they match the question's own words, cheaply and the same way
 * every time: the share of the question's terms that appear in the chunk, plus a bonus when the title does.
 * No model call. With no usable terms the order is unchanged.
 */
export function rerankScore(hit: KnowledgeHit, terms: string[]): number {
  if (terms.length === 0) return 0
  const body = hit.content.toLowerCase()
  const title = (hit.title ?? '').toLowerCase()
  const inBody = terms.filter((t) => body.includes(t)).length
  const inTitle = terms.some((t) => title.includes(t))
  return (inBody / terms.length) * COVERAGE_WEIGHT + (inTitle ? TITLE_WEIGHT : 0)
}

export function fuseRankings(semantic: KnowledgeHit[], keyword: KnowledgeHit[], k: number, query?: string): KnowledgeHit[] {
  const terms = queryTerms(query)
  const fused = new Map<string, { hit: KnowledgeHit; rrf: number }>()
  const add = (list: KnowledgeHit[]) =>
    list.forEach((hit, rank) => {
      const prev = fused.get(hit.chunkId)
      const rrf = 1 / (RRF_K + rank + 1)
      if (!prev) {
        fused.set(hit.chunkId, { hit, rrf })
      } else {
        // Keep the semantic similarity as the displayed score; mark both.
        prev.rrf += rrf
        prev.hit = { ...prev.hit, matchedBy: 'both' }
      }
    })
  add(semantic)
  add(keyword)
  return [...fused.values()]
    .map((f) => ({ hit: f.hit, score: f.rrf + rerankScore(f.hit, terms) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((f) => f.hit)
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`, with the
 * source, document and title each came from.
 *
 * Hybrid: when an embeddings key is configured, the nearest chunks by
 * meaning (minus weak matches below the similarity floor) and the best
 * keyword matches (stopwords removed, titles weighted) are fused by rank.
 * Keyword-only without a key. Returns [] when nothing is relevant, which
 * lets the agent hand off instead of answering from noise. Best-effort:
 * any failure degrades to fewer or zero results and never throws into the
 * draft / auto-reply path.
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: EmbedConfig,
  queryText: string,
  opts: RetrieveOptions = {},
): Promise<KnowledgeHit[]> {
  const k = opts.k ?? 5
  const sourceIds = opts.sourceIds ?? null
  const query = queryText.trim()
  if (!query || k <= 0) return []
  if (sourceIds && sourceIds.length === 0) return []

  // Skip everything when there is nothing to search - otherwise every
  // draft / auto-reply would pay for a query embedding + two RPCs just to
  // get []. One cheap indexed COUNT (head, no rows) instead of a paid
  // embeddings call on the hot path.
  try {
    let countQuery = db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (sourceIds) countQuery = countQuery.in('source_id', sourceIds)
    const { count, error } = await countQuery
    if (error || !count) return []
  } catch {
    return []
  }

  const candidates = k * CANDIDATE_FACTOR
  const floor = opts.minSimilarity ?? minSimilarity()
  const terms = keywordQuery(query)

  const semanticSearch = async (): Promise<KnowledgeHit[]> => {
    const embed = embedderOf(config)
    if (!embed) return []
    try {
      const [queryEmbedding] = await embed([query])
      if (!queryEmbedding) return []
      const { data, error } = await db.rpc('match_ai_knowledge_semantic_v2', {
        p_account_id: accountId,
        p_query_embedding: toVectorLiteral(queryEmbedding),
        p_match_count: candidates,
        p_source_ids: sourceIds,
      })
      if (error || !Array.isArray(data)) return []
      return (data as MatchRow[]).map((r) => toHit(r, 'semantic')).filter((h) => h.score >= floor)
    } catch (err) {
      // No embeddings provider on the platform is a normal state, not worth a log line per reply.
      if ((err as { code?: string })?.code !== EMBED_UNAVAILABLE) {
        console.error('[ai knowledge] semantic retrieval failed, using keywords only:', err)
      }
      return []
    }
  }

  const keywordSearch = async (): Promise<KnowledgeHit[]> => {
    if (!terms) return []
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts_v2', {
        p_account_id: accountId,
        p_query: terms,
        p_match_count: candidates,
        p_source_ids: sourceIds,
      })
      if (error || !Array.isArray(data)) return []
      return (data as MatchRow[]).map((r) => toHit(r, 'keyword'))
    } catch (err) {
      console.error('[ai knowledge] keyword retrieval failed:', err)
      return []
    }
  }

  const [semantic, keyword] = await Promise.all([semanticSearch(), keywordSearch()])
  return fuseRankings(semantic, keyword, k, query)
}

function toHit(row: MatchRow, matchedBy: KnowledgeHit['matchedBy']): KnowledgeHit {
  return {
    chunkId: row.id,
    sourceId: row.source_id ?? null,
    documentId: row.document_id ?? null,
    title: row.doc_title ?? null,
    content: row.content,
    score: typeof row.score === 'number' ? row.score : 0,
    matchedBy,
  }
}

/** What a reply was grounded in, as stored on the message / returned to the UI. */
export interface KnowledgeSourceRef {
  source_id: string | null
  document_id: string | null
  title: string | null
  score: number
  matched_by: KnowledgeHit['matchedBy']
}

/** One reference per document (the best-scoring chunk), in hit order. */
export function sourceRefs(hits: KnowledgeHit[]): KnowledgeSourceRef[] {
  const seen = new Set<string>()
  const out: KnowledgeSourceRef[] = []
  for (const h of hits) {
    const key = h.documentId ?? h.chunkId
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      source_id: h.sourceId,
      document_id: h.documentId,
      title: h.title,
      score: Math.round(h.score * 1000) / 1000,
      matched_by: h.matchedBy,
    })
  }
  return out
}
