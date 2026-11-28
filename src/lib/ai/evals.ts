// ============================================================
// Checks: pure rules for comparing what an agent does now with what it did
// when the user was happy with it. No AI judge: the comparison is whether it
// still answers (or hands off, as before) and still uses the same knowledge.
// ============================================================

export interface EvalExpected {
  /** True when the good result was a handoff to a person. */
  handoff: boolean
  /** Titles of the knowledge the good reply used. */
  source_titles: string[]
  sample_reply: string
}

export interface EvalObserved {
  handoff: boolean
  source_titles: string[]
  reply: string
}

export type EvalStatus = 'same' | 'changed' | 'now_handoff' | 'now_answers'

export interface EvalResult extends EvalObserved {
  status: EvalStatus
  ran_at: string
}

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Same: it behaves as before (answers, or hands off, as it did, and still finds the knowledge it used).
 * Now hands off / Now answers: it flipped. Changed: it still answers but none of the knowledge it used before
 * was found, so the answer now rests on something else. Wording differences alone never fail a check.
 */
export function evaluateCase(expected: EvalExpected, observed: EvalObserved): EvalStatus {
  if (!expected.handoff && observed.handoff) return 'now_handoff'
  if (expected.handoff && !observed.handoff) return 'now_answers'
  if (expected.handoff) return 'same'
  const want = expected.source_titles.map(norm).filter(Boolean)
  if (want.length === 0) return 'same'
  const have = new Set(observed.source_titles.map(norm))
  return want.some((t) => have.has(t)) ? 'same' : 'changed'
}

/** What to store as the expected result when the user saves a reply they like. */
export function expectedFrom(observed: EvalObserved): EvalExpected {
  return {
    handoff: observed.handoff,
    source_titles: Array.from(new Set(observed.source_titles.map((t) => t.trim()).filter(Boolean))).slice(0, 5),
    sample_reply: observed.reply.slice(0, 1000),
  }
}

export function parseExpected(input: unknown): EvalExpected | null {
  if (!input || typeof input !== 'object') return null
  const b = input as Record<string, unknown>
  if (typeof b.handoff !== 'boolean') return null
  const titles = Array.isArray(b.source_titles) ? b.source_titles.filter((t): t is string => typeof t === 'string') : []
  return {
    handoff: b.handoff,
    source_titles: titles.map((t) => t.slice(0, 200)).slice(0, 5),
    sample_reply: typeof b.sample_reply === 'string' ? b.sample_reply.slice(0, 1000) : '',
  }
}

export const EVAL_ORIGINS = ['playground', 'feedback', 'gap'] as const
export const MAX_EVAL_CASES_PER_AGENT = 50
