// Teammates rate AI replies: validation shared by the route and its tests.

export const FEEDBACK_REASONS = ['wrong', 'out_of_date', 'tone', 'other'] as const
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]
export type FeedbackRating = 'up' | 'down'

export interface FeedbackInput {
  messageId: string
  rating: FeedbackRating
  reason: FeedbackReason | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Parse a feedback body. A reason only means something on a thumbs-down, so it is dropped on a thumbs-up. */
export function parseFeedback(body: unknown): FeedbackInput | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.message_id !== 'string' || !UUID_RE.test(b.message_id)) return null
  if (b.rating !== 'up' && b.rating !== 'down') return null
  const reason =
    b.rating === 'down' && typeof b.reason === 'string' && (FEEDBACK_REASONS as readonly string[]).includes(b.reason)
      ? (b.reason as FeedbackReason)
      : null
  return { messageId: b.message_id, rating: b.rating, reason }
}
