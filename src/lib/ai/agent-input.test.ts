import { describe, it, expect } from 'vitest'
import { parseAgentInput, parseIdList } from './agent-input'

describe('parseAgentInput', () => {
  it('fills defaults on create and requires a name', () => {
    expect(parseAgentInput({}, { partial: false })).toEqual({ error: 'name_required' })
    expect(parseAgentInput({ name: ' Sales ' }, { partial: false })).toEqual({
      data: {
        name: 'Sales',
        description: null,
        is_active: true,
        model: null,
        system_prompt: null,
        auto_reply_enabled: false,
        auto_reply_max_per_conversation: 3,
        handoff_agent_id: null,
        channels: ['whatsapp', 'web_chat'],
        priority: 0,
        knowledge_mode: 'selected',
        reply_mode: 'fallback',
      persona_gender: null,
      persona_tone: null,
      persona_behaviour: null,
      persona_avoid: null,
      persona_never: null,
      },
    })
  })

  it('keeps only the fields sent on update', () => {
    expect(parseAgentInput({ priority: 7, channels: ['web_chat', 'fax'] }, { partial: true })).toEqual({
      data: { priority: 7, channels: ['web_chat'] },
    })
  })

  it('clamps numbers and rejects bad values', () => {
    const out = parseAgentInput({ auto_reply_max_per_conversation: 99, priority: -500 }, { partial: true })
    expect(out).toEqual({ data: { auto_reply_max_per_conversation: 20, priority: -100 } })
    expect(parseAgentInput({ knowledge_mode: 'some' }, { partial: true })).toEqual({ error: 'knowledge_mode_invalid' })
    expect(parseAgentInput({ name: 'x'.repeat(81) }, { partial: true })).toEqual({ error: 'name_too_long' })
    expect(parseAgentInput({ name: '   ' }, { partial: true })).toEqual({ error: 'name_required' })
  })
})

describe('parseIdList', () => {
  it('dedupes strings and rejects non-arrays', () => {
    expect(parseIdList(['a', 'a', 3, '', 'b'])).toEqual(['a', 'b'])
    expect(parseIdList('a')).toBeNull()
  })

  it('trims persona fields, treats blank as inherit (null), and rejects over-long ones', () => {
    const ok = parseAgentInput({ name: 'Ada', persona_tone: '  warm ', persona_never: '   ', persona_gender: 'female' }, { partial: false })
    expect(ok).toMatchObject({ data: { persona_tone: 'warm', persona_never: null, persona_gender: 'female' } })
    expect(parseAgentInput({ name: 'Ada', persona_gender: 'x'.repeat(61) }, { partial: false })).toEqual({ error: 'persona_too_long' })
    expect(parseAgentInput({ persona_avoid: 'x'.repeat(1501) }, { partial: true })).toEqual({ error: 'persona_too_long' })
    // PATCH only touches what is sent.
    expect(parseAgentInput({ persona_tone: 'calm' }, { partial: true })).toEqual({ data: { persona_tone: 'calm' } })
  })
})

describe('parseAgentInput tool_integrations', () => {
  it('is only written when sent; null means every integration', () => {
    expect(parseAgentInput({ priority: 1 }, { partial: true })).toEqual({ data: { priority: 1 } })
    expect(parseAgentInput({ tool_integrations: null }, { partial: true })).toEqual({ data: { tool_integrations: null } })
    expect(parseAgentInput({ tool_integrations: ['a', 'a', 7, 'b'] }, { partial: true })).toEqual({ data: { tool_integrations: ['a', 'b'] } })
  })
})
