// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'openai_compatible'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` - `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  /** Base URL for OpenAI-compatible providers; null for native providers. */
  baseUrl: string | null
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  /** 'fallback' (default) = stay silent when a flow/automation already replied. */
  replyMode?: 'fallback' | 'always'
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** Platform AI: embeds with the platform's providers and credits (see embedder.ts). */
  embedder?: ((inputs: string[]) => Promise<number[][]>) | null
  /** The AI agent this config was resolved for (see `loadAgentConfig`).
   *  Absent/null for the legacy single-config path. */
  agentId?: string | null
  agentName?: string | null
  /** 'platform' = powered by the admin-configured provider chain and counted against plan credits (no key of
   *  the business's own); 'own' (or absent) = the business's key. */
  source?: 'own' | 'platform'
  /** The agent's own persona fields; null/absent = inherit the platform default (see lib/ai/persona.ts). */
  persona?: AgentPersona | null
  /** Library sources the agent may search. null = the whole library
   *  (knowledge_mode 'all', or the legacy path); [] = none linked. */
  knowledgeSourceIds?: string[] | null
  /** Integrations whose tools the agent may use (ai_agents.tool_integrations). null/absent = all connected. */
  toolIntegrations?: string[] | null
}

/** Optional per-agent persona overrides (null = use the platform default). The agent's name is `agentName`. */
export interface AgentPersona {
  gender: string | null
  tone: string | null
  behaviour: string | null
  avoid: string | null
  never: string | null
}

/** One retrieved knowledge excerpt, with where it came from. */
export interface KnowledgeHit {
  chunkId: string
  sourceId: string | null
  documentId: string | null
  title: string | null
  content: string
  /** Semantic similarity (0-1) or full-text rank; higher is better. */
  score: number
  /** Which search found it; 'both' ranks highest. */
  matchedBy: 'semantic' | 'keyword' | 'both'
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
