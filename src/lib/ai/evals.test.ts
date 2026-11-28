import { describe, it, expect } from 'vitest'
import { evaluateCase, expectedFrom, parseExpected } from './evals'

const answered = { handoff: false, source_titles: ['Returns policy'], sample_reply: 'x' }

describe('evaluateCase', () => {
  it('is the same when it still answers with the knowledge it used before', () => {
    expect(evaluateCase(answered, { handoff: false, source_titles: ['Returns policy', 'Shipping'], reply: 'new wording' })).toBe('same')
  })

  it('matches knowledge titles regardless of case and spacing', () => {
    expect(evaluateCase(answered, { handoff: false, source_titles: [' returns POLICY '], reply: '' })).toBe('same')
  })

  it('flags an answer that used to work and now hands off', () => {
    expect(evaluateCase(answered, { handoff: true, source_titles: [], reply: '' })).toBe('now_handoff')
  })

  it('flags an answer that no longer finds the knowledge it used', () => {
    expect(evaluateCase(answered, { handoff: false, source_titles: ['Shipping'], reply: '' })).toBe('changed')
    expect(evaluateCase(answered, { handoff: false, source_titles: [], reply: '' })).toBe('changed')
  })

  it('does not care about sources when none were expected', () => {
    expect(evaluateCase({ handoff: false, source_titles: [], sample_reply: '' }, { handoff: false, source_titles: [], reply: '' })).toBe('same')
  })

  it('handles checks whose good result was a handoff', () => {
    const wantsHandoff = { handoff: true, source_titles: [], sample_reply: '' }
    expect(evaluateCase(wantsHandoff, { handoff: true, source_titles: [], reply: '' })).toBe('same')
    expect(evaluateCase(wantsHandoff, { handoff: false, source_titles: [], reply: 'sure' })).toBe('now_answers')
  })
})

describe('expectedFrom / parseExpected', () => {
  it('remembers whether it answered, which knowledge it used, and a sample', () => {
    expect(expectedFrom({ handoff: false, source_titles: ['A', ' A ', '', 'B'], reply: 'hi' })).toEqual({
      handoff: false,
      source_titles: ['A', 'B'],
      sample_reply: 'hi',
    })
  })

  it('validates a request body', () => {
    expect(parseExpected({ handoff: false, source_titles: ['A', 3], sample_reply: 'x' })).toEqual({ handoff: false, source_titles: ['A'], sample_reply: 'x' })
    expect(parseExpected({ handoff: 'no' })).toBeNull()
    expect(parseExpected(null)).toBeNull()
  })
})
