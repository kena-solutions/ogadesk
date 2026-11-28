import { describe, it, expect } from 'vitest'
import { buildHandoffSummary } from './handoff'

describe('buildHandoffSummary', () => {
  it('has a headline with the reply count', () => {
    const summary = buildHandoffSummary({ messages: [{ role: 'user', content: 'help' }], replyCount: 1 })
    expect(summary.split('\n')[0]).toBe('🤖 AI agent handed off after 1 reply.')
  })

  it('says "without replying" when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({ messages: [{ role: 'user', content: 'agent please' }], replyCount: 0 })
    expect(summary.split('\n')[0]).toBe('🤖 AI agent handed off without replying.')
  })

  it('adds why it handed off', () => {
    const base = { messages: [{ role: 'user' as const, content: 'x' }], replyCount: 2 }
    expect(buildHandoffSummary({ ...base, reason: 'model' })).toContain("It wasn't sure of the answer.")
    expect(buildHandoffSummary({ ...base, reason: 'reply_cap' })).toContain('reply limit')
    expect(buildHandoffSummary({ ...base, reason: 'ungrounded' })).toContain("couldn't verify")
  })

  it('quotes the last three customer messages in order, and the last AI reply', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'old reply' },
        { role: 'user', content: 'two' },
        { role: 'user', content: 'three' },
        { role: 'user', content: 'four' },
        { role: 'assistant', content: 'Let me check on that.' },
      ],
      replyCount: 2,
    })
    const lines = summary.split('\n')
    expect(lines[1]).toBe('Customer: • “two” • “three” • “four”')
    expect(lines[2]).toBe('AI’s last reply: “Let me check on that.”')
  })

  it('says whether knowledge matched', () => {
    const base = { messages: [{ role: 'user' as const, content: 'x' }], replyCount: 0 }
    expect(buildHandoffSummary({ ...base, knowledgeTitles: [] })).toContain('Knowledge: nothing matched.')
    expect(buildHandoffSummary({ ...base, knowledgeTitles: ['Returns', 'Returns', 'Shipping'] })).toContain(
      'Knowledge: Returns, Shipping',
    )
    expect(buildHandoffSummary(base)).not.toContain('Knowledge')
  })

  it('notes a pending approval', () => {
    expect(buildHandoffSummary({ messages: [], replyCount: 1, pendingAction: true })).toContain('waiting for a teammate')
  })

  it('collapses whitespace and truncates a long message', () => {
    const summary = buildHandoffSummary({ messages: [{ role: 'user', content: `a   b ${'x'.repeat(300)}` }], replyCount: 0 })
    expect(summary).toContain('…')
    expect(summary.split('\n')[1].length).toBeLessThan(160)
  })

  it('degrades gracefully with no messages', () => {
    expect(buildHandoffSummary({ messages: [], replyCount: 0 })).toBe('🤖 AI agent handed off without replying.')
  })
})
