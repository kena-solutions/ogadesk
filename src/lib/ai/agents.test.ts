import { describe, it, expect } from 'vitest'
import { normalizeChannels, pickAgent, routeAgent, type AiAgentRow, type RoutingContext } from './agents'
import { parseRouting } from './agent-input'

function agent(overrides: Partial<AiAgentRow>): AiAgentRow {
  return {
    id: 'a',
    name: 'Agent',
    is_active: true,
    is_default: false,
    model: null,
    system_prompt: null,
    auto_reply_enabled: true,
    auto_reply_max_per_conversation: 3,
    handoff_agent_id: null,
    channels: ['whatsapp', 'web_chat'],
    priority: 0,
    knowledge_mode: 'selected',
    created_at: '2026-11-01T00:00:00Z',
    ...overrides,
  }
}

const DEFAULT = agent({ id: 'default', is_default: true, knowledge_mode: 'all' })
const SALES = agent({ id: 'sales', channels: ['whatsapp'], priority: 5 })
const SUPPORT = agent({ id: 'support', channels: ['web_chat'], priority: 1 })

describe('pickAgent', () => {
  it('returns a pinned agent even when it is inactive', () => {
    const off = agent({ id: 'off', is_active: false })
    expect(pickAgent([DEFAULT, off], { agentId: 'off' })?.id).toBe('off')
    expect(pickAgent([DEFAULT], { agentId: 'missing' })).toBeNull()
  })

  it('returns the default agent in any state when asked for it', () => {
    const offDefault = { ...DEFAULT, is_active: false }
    expect(pickAgent([offDefault, SALES], { defaultAgent: true })?.id).toBe('default')
  })

  it("uses the conversation's override when that agent is active", () => {
    expect(
      pickAgent([DEFAULT, SALES, SUPPORT], { conversationAgentId: 'support', channel: 'whatsapp' })?.id,
    ).toBe('support')
  })

  it('ignores an override pointing at an inactive agent', () => {
    const off = { ...SUPPORT, is_active: false }
    expect(
      pickAgent([DEFAULT, SALES, off], { conversationAgentId: 'support', channel: 'whatsapp' })?.id,
    ).toBe('sales')
  })

  it('picks the highest-priority active agent covering the channel', () => {
    expect(pickAgent([DEFAULT, SALES, SUPPORT], { channel: 'whatsapp' })?.id).toBe('sales')
    expect(pickAgent([DEFAULT, SALES, SUPPORT], { channel: 'web_chat' })?.id).toBe('support')
  })

  it('prefers the default agent on a priority tie, then the oldest', () => {
    const older = agent({ id: 'older', created_at: '2026-01-01T00:00:00Z' })
    const newer = agent({ id: 'newer', created_at: '2026-06-01T00:00:00Z' })
    expect(pickAgent([newer, older], { channel: 'whatsapp' })?.id).toBe('older')
    expect(pickAgent([older, DEFAULT], { channel: 'whatsapp' })?.id).toBe('default')
  })

  it('falls back to the default agent when nothing covers the channel', () => {
    const onlyWeb = { ...DEFAULT, channels: ['web_chat'] }
    expect(pickAgent([onlyWeb, SUPPORT], { channel: 'whatsapp' })?.id).toBe('default')
  })

  it('returns null when every agent is off', () => {
    const agents = [{ ...DEFAULT, is_active: false }, { ...SALES, is_active: false }]
    expect(pickAgent(agents, { channel: 'whatsapp' })).toBeNull()
  })
})

describe('normalizeChannels', () => {
  it('keeps known channels once, in a stable order', () => {
    expect(normalizeChannels(['web_chat', 'sms', 'whatsapp', 'web_chat'])).toEqual([
      'whatsapp',
      'web_chat',
    ])
    expect(normalizeChannels('whatsapp')).toEqual([])
  })
})

describe('routing rules', () => {
  const T1 = '11111111-1111-1111-1111-111111111111'
  const ctx = (over: Partial<RoutingContext> = {}): RoutingContext => ({
    tagIds: [], text: '', now: new Date('2026-11-30T10:00:00Z'), timezone: 'UTC', ...over,
  })
  const vip = agent({ id: 'vip', priority: 9, routing: { tags: [T1] } })
  const billing = agent({ id: 'billing', priority: 5, routing: { keywords: ['invoice', 'Refund'] } })
  const office = agent({ id: 'office', priority: 1, routing: { hours: { enabled: true, days: [1], from: '09:00', to: '17:00' } } })
  const general = agent({ id: 'general', priority: 1 })

  it('uses a rule agent when its tag matches, ahead of a plain channel agent', () => {
    const d = routeAgent([DEFAULT, general, vip], { channel: 'whatsapp', context: ctx({ tagIds: [T1] }) })
    expect(d).toMatchObject({ reason: 'rules', matched: ['tags'] })
    expect(d.agent?.id).toBe('vip')
  })

  it('matches keywords case-insensitively anywhere in what the customer said', () => {
    const d = routeAgent([DEFAULT, billing], { channel: 'whatsapp', context: ctx({ text: 'I need my INVOICE and a REFUND' }) })
    expect(d.agent?.id).toBe('billing')
    expect(d.matched).toEqual(['keywords'])
  })

  it('skips a rule agent whose rules do not match, then falls to the channel agent', () => {
    const d = routeAgent([DEFAULT, vip, billing, general], { channel: 'whatsapp', context: ctx({ text: 'hello' }) })
    expect(d).toMatchObject({ reason: 'channel' })
    expect(d.agent?.id).toBe('general')
  })

  it('requires every kind of rule to match (tag AND hours)', () => {
    const both = agent({ id: 'both', routing: { tags: [T1], hours: { enabled: true, days: [1], from: '09:00', to: '17:00' } } })
    // Monday 10:00 UTC and tagged: matches. Tagged but Tuesday: does not.
    expect(routeAgent([DEFAULT, both], { channel: 'whatsapp', context: ctx({ tagIds: [T1] }) }).agent?.id).toBe('both')
    const tue = ctx({ tagIds: [T1], now: new Date('2026-12-01T10:00:00Z') })
    expect(routeAgent([DEFAULT, both], { channel: 'whatsapp', context: tue }).agent?.id).toBe('default')
  })

  it('applies business hours in the workspace time zone', () => {
    const at = (iso: string, tz: string) => routeAgent([DEFAULT, office], { channel: 'whatsapp', context: ctx({ now: new Date(iso), timezone: tz }) }).agent?.id
    expect(at('2026-11-30T10:00:00Z', 'UTC')).toBe('office')
    expect(at('2026-11-30T20:00:00Z', 'UTC')).toBe('default')
    // 20:00 UTC is 21:00 in Lagos (still closed), but 08:30 UTC is 09:30 there (open).
    expect(at('2026-11-30T08:30:00Z', 'Africa/Lagos')).toBe('office')
  })

  it('never matches rule agents without context, and the default ignores its own rules', () => {
    expect(routeAgent([DEFAULT, vip], { channel: 'whatsapp' }).agent?.id).toBe('default')
    const ruledDefault = { ...DEFAULT, routing: { keywords: ['zzz'] } }
    expect(routeAgent([ruledDefault], { channel: 'whatsapp', context: ctx() }).agent?.id).toBe('default')
  })

  it('still lets an inbox pin beat rules, and keeps the highest priority among matches', () => {
    const pinned = routeAgent([DEFAULT, vip, general], { conversationAgentId: 'general', channel: 'whatsapp', context: ctx({ tagIds: [T1] }) })
    expect(pinned).toMatchObject({ reason: 'override' })
    const both = routeAgent([DEFAULT, vip, billing], { channel: 'whatsapp', context: ctx({ tagIds: [T1], text: 'invoice' }) })
    expect(both.agent?.id).toBe('vip')
  })

  it('respects channels for rule agents too', () => {
    const webOnly = agent({ id: 'web', channels: ['web_chat'], routing: { keywords: ['hi'] } })
    expect(routeAgent([DEFAULT, webOnly], { channel: 'whatsapp', context: ctx({ text: 'hi' }) }).agent?.id).toBe('default')
  })
})

describe('parseRouting', () => {
  it('keeps valid tag ids, keywords and hours; drops the rest', () => {
    expect(
      parseRouting({
        tags: ['11111111-1111-1111-1111-111111111111', 'nope', '11111111-1111-1111-1111-111111111111'],
        keywords: ' invoice, Refund ,,',
        hours: { enabled: true, days: [1, 9, 2], from: '08:30', to: '25:00' },
      }),
    ).toEqual({
      tags: ['11111111-1111-1111-1111-111111111111'],
      keywords: ['invoice', 'Refund'],
      hours: { enabled: true, days: [1, 2], from: '08:30', to: '17:00' },
    })
  })

  it('returns null when no rule is set', () => {
    expect(parseRouting({ tags: [], keywords: [], hours: { enabled: false } })).toBeNull()
    expect(parseRouting(null)).toBeNull()
  })
})
