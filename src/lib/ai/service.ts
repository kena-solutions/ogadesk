// AI agents and their knowledge, shared by the dashboard (/api/ai/*) and the public API / MCP (/api/v1/ai/*), so
// both apply the same validation, limits and workspace scoping. Every function takes a client that can write this
// workspace (the member's own, or the service role) and the workspace id; callers check roles or scopes first.
// Results are { ok: true, data } or { ok: false, status, code } with a stable code the caller turns into text.
import type { SupabaseClient } from '@supabase/supabase-js'

import { AGENT_COLUMNS } from './agents'
import { parseAgentInput, parseIdList, type AgentInputError } from './agent-input'
import { AGENT_TEMPLATES, AGENT_TEMPLATE_IDS } from './agent-templates'
import { loadEmbeddingsKey } from './config'
import { KNOWLEDGE_LIMITS, nextSyncAt } from './ingest/limits'
import { SOURCE_COLUMNS, queueSourceSync, runKnowledgeQueue, type SourceRow } from './ingest/pipeline'
import { IN_REQUEST_BUDGET_MS, SOURCE_LIST_COLUMNS } from './ingest/route-helpers'
import { parseSourceInput, type SourceInputError } from './ingest/source-input'
import { minSimilarity, retrieveKnowledge } from './knowledge'

/** Most agents a workspace may have; keeps routing and the UI sane. */
export const MAX_AGENTS = 20
export const AGENT_SELECT = `${AGENT_COLUMNS}, description, updated_at`
const MAX_QUERY = 1000

export type ServiceError =
  | AgentInputError
  | SourceInputError
  | 'not_found'
  | 'handoff_not_member'
  | 'agent_limit'
  | 'default_undeletable'
  | 'source_ids_required'
  | 'unknown_sources'
  | 'source_limit'
  | 'query_required'
  | 'empty_update'
  | 'file_upload_only'
  | 'failed'

export type Result<T> = { ok: true; data: T } | { ok: false; status: 400 | 404 | 500; code: ServiceError }

const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const no = (status: 400 | 404 | 500, code: ServiceError): Result<never> => ({ ok: false, status, code })

/**
 * Replace an agent's handoff pool. `handoff_agent_id` (older clients) is kept equal to the first member, and a
 * client that sends only `handoff_agent_id` gets a pool of that one person.
 */
async function setHandoffPool(db: SupabaseClient, accountId: string, agentId: string, ids: string[]): Promise<boolean> {
  const unique = Array.from(new Set(ids))
  const { error: delErr } = await db.from('ai_agent_handoff_members').delete().eq('agent_id', agentId)
  if (delErr) return false
  if (unique.length > 0) {
    const { error } = await db
      .from('ai_agent_handoff_members')
      .insert(unique.map((user_id, i) => ({ agent_id: agentId, user_id, account_id: accountId, position: i + 1 })))
    if (error) return false
  }
  await db.from('ai_agents').update({ handoff_agent_id: unique[0] ?? null, handoff_cursor: 0 }).eq('id', agentId)
  return true
}

/** The pool a write asks for: explicit list, else derived from a lone handoff_agent_id, else untouched (null). */
function requestedPool(data: { handoff_member_ids?: string[]; handoff_agent_id?: string | null }): string[] | null {
  if (data.handoff_member_ids) return data.handoff_member_ids
  if ('handoff_agent_id' in data) return data.handoff_agent_id ? [data.handoff_agent_id] : []
  return null
}

async function allMembers(db: SupabaseClient, accountId: string, ids: string[]): Promise<boolean> {
  for (const id of ids) if (!(await isMember(db, accountId, id))) return false
  return true
}

/** A handoff target must be a member of the workspace (else a chat would be assigned to a stranger). */
async function isMember(db: SupabaseClient, accountId: string, userId: string | null | undefined) {
  if (!userId) return true
  const { data } = await db.from('account_members').select('user_id').eq('account_id', accountId).eq('user_id', userId).maybeSingle()
  return !!data
}

// ---------------------------------------------------------------- agents

export function agentTemplates() {
  return AGENT_TEMPLATE_IDS.map((id) => ({ ...AGENT_TEMPLATES[id] }))
}

export async function listAgents(db: SupabaseClient, accountId: string): Promise<Result<Record<string, unknown>[]>> {
  const [agents, links, pool] = await Promise.all([
    db.from('ai_agents').select(AGENT_SELECT).eq('account_id', accountId).order('is_default', { ascending: false }).order('created_at', { ascending: true }),
    db.from('ai_agent_knowledge').select('agent_id').eq('account_id', accountId),
    db.from('ai_agent_handoff_members').select('agent_id, user_id, position').eq('account_id', accountId).order('position'),
  ])
  if (agents.error) return no(500, 'failed')
  const counts = new Map<string, number>()
  for (const l of (links.data ?? []) as { agent_id: string }[]) counts.set(l.agent_id, (counts.get(l.agent_id) ?? 0) + 1)
  const members = new Map<string, string[]>()
  for (const m of (pool.data ?? []) as { agent_id: string; user_id: string }[]) members.set(m.agent_id, [...(members.get(m.agent_id) ?? []), m.user_id])
  return ok(((agents.data ?? []) as unknown as Record<string, unknown>[]).map((a) => ({
    ...a, source_count: counts.get(a.id as string) ?? 0, handoff_member_ids: members.get(a.id as string) ?? [],
  })))
}

export async function getAgent(db: SupabaseClient, accountId: string, id: string): Promise<Result<Record<string, unknown>>> {
  const { data: agent, error } = await db.from('ai_agents').select(AGENT_SELECT).eq('id', id).eq('account_id', accountId).maybeSingle()
  if (error) return no(500, 'failed')
  if (!agent) return no(404, 'not_found')
  const [{ data: links }, { data: pool }] = await Promise.all([
    db.from('ai_agent_knowledge').select('source_id').eq('agent_id', id),
    db.from('ai_agent_handoff_members').select('user_id').eq('agent_id', id).order('position'),
  ])
  return ok({
    ...(agent as unknown as Record<string, unknown>),
    source_ids: ((links ?? []) as { source_id: string }[]).map((l) => l.source_id),
    handoff_member_ids: ((pool ?? []) as { user_id: string }[]).map((m) => m.user_id),
  })
}

export async function createAgent(db: SupabaseClient, accountId: string, actorId: string | null, body: unknown): Promise<Result<Record<string, unknown>>> {
  const parsed = parseAgentInput(body, { partial: false })
  if ('error' in parsed) return no(400, parsed.error)
  const { handoff_member_ids: _ignored, ...columns } = parsed.data
  void _ignored
  const pool = requestedPool(parsed.data)
  if (!(await allMembers(db, accountId, [...(pool ?? []), ...(columns.handoff_agent_id ? [columns.handoff_agent_id] : [])]))) return no(400, 'handoff_not_member')
  const { count } = await db.from('ai_agents').select('id', { count: 'exact', head: true }).eq('account_id', accountId)
  if ((count ?? 0) >= MAX_AGENTS) return no(400, 'agent_limit')
  // The first agent in a workspace becomes its default.
  const { data, error } = await db
    .from('ai_agents')
    .insert({ ...columns, account_id: accountId, created_by: actorId, is_default: (count ?? 0) === 0 })
    .select(AGENT_SELECT)
    .single()
  if (error || !data) return no(500, 'failed')
  const row = data as unknown as Record<string, unknown>
  if (pool && pool.length > 0 && !(await setHandoffPool(db, accountId, row.id as string, pool))) return no(500, 'failed')
  return ok({ ...row, source_count: 0, handoff_member_ids: pool ?? [], handoff_agent_id: pool?.[0] ?? row.handoff_agent_id ?? null })
}

export async function updateAgent(db: SupabaseClient, accountId: string, id: string, body: unknown): Promise<Result<Record<string, unknown>>> {
  const parsed = parseAgentInput(body, { partial: true })
  if ('error' in parsed) return no(400, parsed.error)
  const { handoff_member_ids: _ignored, ...columns } = parsed.data
  void _ignored
  const pool = requestedPool(parsed.data)
  if (!(await allMembers(db, accountId, pool ?? []))) return no(400, 'handoff_not_member')
  if (Object.keys(parsed.data).length === 0) return no(400, 'empty_update')
  // The pool owns handoff_agent_id; drop it from the column update (setHandoffPool keeps it in step).
  const { handoff_agent_id: _legacy, ...plain } = columns
  void _legacy
  let row: Record<string, unknown> | null = null
  if (Object.keys(plain).length > 0) {
    const { data, error } = await db.from('ai_agents').update(plain).eq('id', id).eq('account_id', accountId).select(AGENT_SELECT).maybeSingle()
    if (error) return no(500, 'failed')
    if (!data) return no(404, 'not_found')
    row = data as unknown as Record<string, unknown>
  } else {
    const { data } = await db.from('ai_agents').select(AGENT_SELECT).eq('id', id).eq('account_id', accountId).maybeSingle()
    if (!data) return no(404, 'not_found')
    row = data as unknown as Record<string, unknown>
  }
  if (pool) {
    if (!(await setHandoffPool(db, accountId, id, pool))) return no(500, 'failed')
    row = { ...row, handoff_agent_id: pool[0] ?? null, handoff_member_ids: pool }
  }
  return ok(row)
}

/** The default agent can't be deleted. */
export async function deleteAgent(db: SupabaseClient, accountId: string, id: string): Promise<Result<{ id: string; deleted: true }>> {
  const { data: agent } = await db.from('ai_agents').select('id, is_default').eq('id', id).eq('account_id', accountId).maybeSingle()
  if (!agent) return no(404, 'not_found')
  if (agent.is_default) return no(400, 'default_undeletable')
  const { error } = await db.from('ai_agents').delete().eq('id', id).eq('account_id', accountId)
  if (error) return no(500, 'failed')
  return ok({ id, deleted: true })
}

/** Replace the library sources an agent is linked to (used when its knowledge_mode is 'selected'). */
export async function setAgentKnowledge(db: SupabaseClient, accountId: string, id: string, sourceIdsInput: unknown): Promise<Result<{ source_ids: string[] }>> {
  const sourceIds = parseIdList(sourceIdsInput)
  if (!sourceIds) return no(400, 'source_ids_required')
  const { data: agent } = await db.from('ai_agents').select('id').eq('id', id).eq('account_id', accountId).maybeSingle()
  if (!agent) return no(404, 'not_found')
  if (sourceIds.length > 0) {
    const { data: found } = await db.from('ai_knowledge_sources').select('id').eq('account_id', accountId).in('id', sourceIds)
    if ((found ?? []).length !== sourceIds.length) return no(400, 'unknown_sources')
  }
  const { data: current } = await db.from('ai_agent_knowledge').select('source_id').eq('agent_id', id)
  const have = new Set(((current ?? []) as { source_id: string }[]).map((l) => l.source_id))
  const want = new Set(sourceIds)
  const toAdd = sourceIds.filter((s) => !have.has(s))
  const toRemove = [...have].filter((s) => !want.has(s))
  if (toAdd.length > 0) {
    const { error } = await db.from('ai_agent_knowledge').insert(toAdd.map((source_id) => ({ agent_id: id, source_id, account_id: accountId })))
    if (error) return no(500, 'failed')
  }
  if (toRemove.length > 0) {
    const { error } = await db.from('ai_agent_knowledge').delete().eq('agent_id', id).in('source_id', toRemove)
    if (error) return no(500, 'failed')
  }
  return ok({ source_ids: sourceIds })
}

/** Pin which agent answers a conversation; null goes back to automatic (channel, then default). */
export async function setConversationAgent(db: SupabaseClient, accountId: string, conversationId: string, agentId: string | null): Promise<Result<{ conversation_id: string; agent_id: string | null }>> {
  if (agentId) {
    const { data: agent } = await db.from('ai_agents').select('id').eq('id', agentId).eq('account_id', accountId).maybeSingle()
    if (!agent) return no(404, 'not_found')
  }
  const { data, error } = await db.from('conversations').update({ ai_agent_id: agentId }).eq('id', conversationId).eq('account_id', accountId).select('id').maybeSingle()
  if (error) return no(500, 'failed')
  if (!data) return no(404, 'not_found')
  return ok({ conversation_id: conversationId, agent_id: agentId })
}

// ---------------------------------------------------------------- knowledge library

export async function listSources(db: SupabaseClient, accountId: string): Promise<Result<Record<string, unknown>[]>> {
  const [sources, links] = await Promise.all([
    db.from('ai_knowledge_sources').select(SOURCE_LIST_COLUMNS).eq('account_id', accountId).order('created_at', { ascending: false }),
    db.from('ai_agent_knowledge').select('agent_id, source_id').eq('account_id', accountId),
  ])
  if (sources.error) return no(500, 'failed')
  const bySource = new Map<string, string[]>()
  for (const l of (links.data ?? []) as { agent_id: string; source_id: string }[]) bySource.set(l.source_id, [...(bySource.get(l.source_id) ?? []), l.agent_id])
  return ok(((sources.data ?? []) as unknown as Record<string, unknown>[]).map((s) => ({ ...s, agent_ids: bySource.get(s.id as string) ?? [] })))
}

/**
 * Add a text, Q&A, web page or website source and index it (bounded; the cron finishes big websites). Files are
 * uploaded in the app only (their text is extracted in the browser).
 */
export async function createSource(
  db: SupabaseClient,
  indexer: SupabaseClient,
  accountId: string,
  actorId: string | null,
  body: unknown,
  opts: { linkAgentId?: string | null } = {},
): Promise<Result<Record<string, unknown>>> {
  if (body && typeof body === 'object' && (body as { type?: unknown }).type === 'file') return no(400, 'file_upload_only')
  const parsed = parseSourceInput(body, { accountId })
  if ('error' in parsed) return no(400, parsed.error)
  const input = parsed.data
  const { count } = await db.from('ai_knowledge_sources').select('id', { count: 'exact', head: true }).eq('account_id', accountId)
  if ((count ?? 0) >= KNOWLEDGE_LIMITS.maxSourcesPerAccount) return no(400, 'source_limit')
  const { data: source, error } = await db
    .from('ai_knowledge_sources')
    .insert({
      account_id: accountId,
      created_by: actorId,
      name: input.name,
      type: input.type,
      status: input.type === 'website' ? 'queued' : 'processing',
      config: input.config,
      sync_interval: input.syncInterval,
      next_sync_at: nextSyncAt(input.syncInterval),
    })
    .select('id')
    .single()
  if (error || !source) return no(500, 'failed')
  if (input.document) {
    const { error: docErr } = await db.from('ai_knowledge_documents').insert({
      account_id: accountId,
      source_id: source.id,
      created_by: actorId,
      title: input.document.title,
      content: input.document.content,
      url: input.document.url,
      status: 'queued',
    })
    if (docErr) {
      await db.from('ai_knowledge_sources').delete().eq('id', source.id)
      return no(500, 'failed')
    }
  }
  if (opts.linkAgentId) {
    const { data: agent } = await db.from('ai_agents').select('id').eq('id', opts.linkAgentId).eq('account_id', accountId).maybeSingle()
    if (agent) await db.from('ai_agent_knowledge').insert({ agent_id: agent.id, source_id: source.id, account_id: accountId })
  }
  await runKnowledgeQueue(indexer, { deadline: Date.now() + IN_REQUEST_BUDGET_MS, onlySourceId: source.id as string })
  const { data: fresh } = await db.from('ai_knowledge_sources').select(SOURCE_LIST_COLUMNS).eq('id', source.id).single()
  return ok((fresh ?? { id: source.id }) as unknown as Record<string, unknown>)
}

/** Re-sync now: pages are fetched again (unchanged ones skipped); text and Q&A are re-embedded. */
export async function syncSource(db: SupabaseClient, indexer: SupabaseClient, accountId: string, id: string): Promise<Result<Record<string, unknown>>> {
  const { data: row } = await db.from('ai_knowledge_sources').select(SOURCE_COLUMNS).eq('id', id).eq('account_id', accountId).maybeSingle()
  if (!row) return no(404, 'not_found')
  const source = row as unknown as SourceRow
  if (source.type === 'url' || source.type === 'website') {
    await queueSourceSync(indexer, source)
  } else {
    await indexer.from('ai_knowledge_documents').update({ status: 'queued', error: null, content_hash: null }).eq('source_id', id)
    await indexer.from('ai_knowledge_sources').update({ status: 'processing', error: null }).eq('id', id)
  }
  await runKnowledgeQueue(indexer, { deadline: Date.now() + IN_REQUEST_BUDGET_MS, onlySourceId: id })
  const { data: fresh } = await db.from('ai_knowledge_sources').select(SOURCE_LIST_COLUMNS).eq('id', id).single()
  return ok((fresh ?? { id }) as unknown as Record<string, unknown>)
}

/** Removes the source everywhere: its documents, chunks and agent links. (Uploaded files are removed by the app route.) */
export async function deleteSource(db: SupabaseClient, accountId: string, id: string): Promise<Result<{ id: string; deleted: true; type: string; config: unknown }>> {
  const { data: source } = await db.from('ai_knowledge_sources').select('id, type, config').eq('id', id).eq('account_id', accountId).maybeSingle()
  if (!source) return no(404, 'not_found')
  const { error } = await db.from('ai_knowledge_sources').delete().eq('id', id).eq('account_id', accountId)
  if (error) return no(500, 'failed')
  return ok({ id, deleted: true, type: source.type as string, config: source.config })
}

/** Retrieval only (no AI call, no credits): what an agent would be given for this question. */
export async function searchKnowledge(db: SupabaseClient, accountId: string, body: unknown) {
  const b = (body && typeof body === 'object' ? body : {}) as { query?: unknown; agent_id?: unknown }
  const query = typeof b.query === 'string' ? b.query.trim().slice(0, MAX_QUERY) : ''
  if (!query) return no(400, 'query_required')
  let sourceIds: string[] | null = null
  const agentId = typeof b.agent_id === 'string' && b.agent_id ? b.agent_id : null
  if (agentId) {
    const { data: agent } = await db.from('ai_agents').select('id, knowledge_mode').eq('id', agentId).eq('account_id', accountId).maybeSingle()
    if (!agent) return no(404, 'not_found')
    if (agent.knowledge_mode === 'selected') {
      const { data: links } = await db.from('ai_agent_knowledge').select('source_id').eq('agent_id', agentId)
      sourceIds = ((links ?? []) as { source_id: string }[]).map((l) => l.source_id)
    }
  }
  const { key } = await loadEmbeddingsKey(db, accountId)
  const hits = await retrieveKnowledge(db, accountId, { embeddingsApiKey: key }, query, { sourceIds })
  return ok({
    semantic: Boolean(key),
    min_similarity: minSimilarity(),
    hits: hits.map((h) => ({ source_id: h.sourceId, title: h.title, snippet: h.content.slice(0, 400), score: h.score, matched_by: h.matchedBy })),
  })
}
