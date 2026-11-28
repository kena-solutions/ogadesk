import type { ChatMessage } from './types'
import type { HandoffReason } from './reply-log'
import { getT, type Translate } from '@/lib/i18n/translate'

/** Longest a quoted message runs before we ellipsize it. */
const MAX_QUOTE_LEN = 120
const MAX_CUSTOMER_QUOTES = 3

/**
 * Build the internal note the auto-reply bot leaves on a conversation when it
 * hands off to a human, so whoever picks it up knows where things stand
 * without scrolling. Deterministic - composed from context we already have
 * (no extra LLM call / token spend), so it can't fail or add latency.
 *
 * Reads as, e.g.:
 *   🤖 AI agent handed off after 2 replies. It wasn't sure of the answer.
 *   Customer: • “where is my order?” • “it's been 5 days”
 *   AI's last reply: “Let me check on that for you.”
 *   Knowledge: nothing matched.
 *
 * The first line is always the headline; the rest are optional details.
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it bailed
 * on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
  /** The AI asked to run an action that needs a teammate's approval (shown in the inbox). */
  pendingAction?: boolean
  /** Why it handed off. */
  reason?: HandoffReason
  /** Titles of the knowledge it found for the last question (empty/absent = nothing matched). */
  knowledgeTitles?: string[]
}, t: Translate = getT('Handoff')): string {
  const { messages, replyCount } = args

  const headline =
    t('summary', { count: replyCount }) +
    (args.reason ? ` ${t(`reason.${args.reason}`)}` : '') +
    (args.pendingAction ? t('pendingAction') : '')

  const lines = [headline]

  const customer = messages
    .filter((m) => m.role === 'user' && m.content.trim())
    .slice(-MAX_CUSTOMER_QUOTES)
    .map((m) => `• “${truncate(m.content, MAX_QUOTE_LEN)}”`)
  if (customer.length > 0) lines.push(`${t('customerSaid')} ${customer.join(' ')}`)

  const lastAi = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())
  if (lastAi) lines.push(`${t('aiLastSaid')} “${truncate(lastAi.content, MAX_QUOTE_LEN)}”`)

  if (args.knowledgeTitles) {
    const titles = Array.from(new Set(args.knowledgeTitles.map((x) => x.trim()).filter(Boolean)))
    lines.push(titles.length > 0 ? t('knowledgeUsed', { titles: titles.slice(0, 3).join(', ') }) : t('knowledgeNone'))
  }

  return lines.join('\n')
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}
