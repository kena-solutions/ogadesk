import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAgentConfig: vi.fn(),
  logAiReply: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  sendTypingIndicator: vi.fn(),
  loadToolRuntime: vi.fn(),
  runOverride: null as null | ((...a: unknown[]) => unknown),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    replied: false as boolean,
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    updates: [] as { payload: Record<string, unknown>; isNull: string[] }[],
    rpcCalls: [] as { name: string; args: unknown }[],
    latestInbound: [] as { message_id: string }[],
    blocked: false as boolean,
  },
}))

vi.mock('./config', () => ({ loadAgentConfig: h.loadAgentConfig }))
vi.mock('./reply-log', () => ({
  inboundArrivedAt: async () => '2026-11-28T10:00:00Z',
  hasReplySince: async () => h.state.replied,
  logAiReply: h.logAiReply,
}))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./knowledge')>()),
  retrieveKnowledge: h.retrieveKnowledge,
}))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./tools/registry', () => ({ loadToolRuntime: h.loadToolRuntime }))
vi.mock('./run', async (orig) => {
  const actual = await orig<typeof import('./run')>()
  return { ...actual, runGeneration: (...a: Parameters<typeof actual.runGeneration>) => (h.runOverride ? h.runOverride(...a) : actual.runGeneration(...a)) }
})
// The platform persona layer reads the database; keep these tests about the reply flow.
vi.mock('./persona', () => ({ loadPlatformPrompt: async () => ({}), personaPrompt: () => ({ guardrails: '', persona: '' }) }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.latestInbound, error: null }),
        }
        return chain
      }
      if (table === 'contacts') {
        // blocked_at lookup: the contact is not blocked in these scenarios
        // unless a test sets `blocked`.
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: { blocked_at: h.state.blocked ? '2026-01-01T00:00:00Z' : null },
              error: null,
            }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = { ...h.state.updatePayload, ...payload }
          const record = { payload, isNull: [] as string[] }
          h.state.updates.push(record)
          const result = Promise.resolve({ error: null })
          const filter = Object.assign(result, {
            is: (column: string) => {
              record.isNull.push(column)
              return result
            },
          })
          return { eq: () => filter }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    baseUrl: null,
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.replied = false
  h.logAiReply.mockReset()
  h.state.claim = true
  h.state.blocked = false
  h.state.updatePayload = null
  h.state.updates = []
  h.state.rpcCalls = []
  h.state.latestInbound = [{ message_id: 'wamid.inbound-1' }]
  h.loadAgentConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
  h.loadToolRuntime.mockResolvedValue(null)
  h.runOverride = null
})

describe('dispatchInboundToAiReply, eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('sends nothing, and spends no LLM call, for a blocked contact', async () => {
    h.state.blocked = true
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue([
      {
        chunkId: 'c1',
        sourceId: 's1',
        documentId: 'd1',
        title: 'Returns policy',
        content: 'Returns accepted within 30 days.',
        score: 0.8,
        matchedBy: 'semantic',
      },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('(Returns policy) Returns accepted within 30 days.')
    // The reply records what it was grounded in.
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSources: [
          { source_id: 's1', document_id: 'd1', title: 'Returns policy', score: 0.8, matched_by: 'semantic' },
        ],
      }),
    )
  })

  it('answers as the agent for this conversation, with its knowledge only', async () => {
    h.state.conv = { ...h.state.conv, channel: 'whatsapp', ai_agent_id: 'agent-sales' }
    h.loadAgentConfig.mockResolvedValue(
      aiConfig({ agentId: 'agent-sales', knowledgeSourceIds: ['src-1'] }),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAgentConfig).toHaveBeenCalledWith(expect.anything(), 'acct-1', {
      conversationAgentId: 'agent-sales',
      channel: 'whatsapp',
      contextLoader: expect.any(Function),
    })
    expect(h.retrieveKnowledge.mock.calls[0][4]).toEqual({ sourceIds: ['src-1'] })
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ aiAgentId: 'agent-sales' }),
    )
  })

  it('stays quiet when no agent covers the conversation', async () => {
    h.loadAgentConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('stays silent when a flow, automation or teammate already replied (fallback mode)', async () => {
    h.state.replied = true
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.logAiReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'skipped_fallback' }))
  })

  it('answers anyway when the agent is set to always reply', async () => {
    h.state.replied = true
    h.loadAgentConfig.mockResolvedValue(aiConfig({ replyMode: 'always' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('is not blocked by an active message automation that sent nothing', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('logs a reply with its sources and question', async () => {
    h.loadAgentConfig.mockResolvedValue(aiConfig({ agentId: 'agent-1' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.logAiReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'replied', question: 'hi', agentId: 'agent-1' }),
    )
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the slot claim is refused after a human takeover', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('leaves the reply to the newer run when another inbound arrived', async () => {
    h.state.latestInbound = [{ message_id: 'wamid.inbound-2' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('replies when the triggering inbound is still the latest', async () => {
    h.state.latestInbound = [{ message_id: 'wamid.inbound-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAgentConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAgentConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply, typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAgentConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply, handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAgentConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('assigns the handoff agent only while the thread is still unassigned', async () => {
    h.loadAgentConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    const pause = h.state.updates.find((u) => 'ai_autoreply_disabled' in u.payload)
    const assign = h.state.updates.find((u) => 'assigned_agent_id' in u.payload)
    expect(pause?.payload).not.toHaveProperty('assigned_agent_id')
    expect(pause?.isNull).toEqual([])
    expect(assign?.payload).toEqual({ assigned_agent_id: 'agent-7' })
    expect(assign?.isNull).toEqual(['assigned_agent_id'])
  })
})

describe('dispatchInboundToAiReply, AI tools', () => {
  it('passes the agent\'s tools to the model', async () => {
    const runtime = { specs: [], execute: vi.fn() }
    h.loadToolRuntime.mockResolvedValue(runtime)
    h.loadAgentConfig.mockResolvedValue(aiConfig({ agentId: 'ag-1', toolIntegrations: ['i1'] }))
    const seen: unknown[] = []
    h.runOverride = async (_db: unknown, args: unknown) => { seen.push(args); return { text: 'Hi', handoff: false } }
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadToolRuntime).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: 'auto_reply', agentId: 'ag-1', allowedIntegrations: ['i1'], conversationId: 'conv-1' }))
    expect(seen[0]).toMatchObject({ tools: runtime })
  })

  it('sends the holding message, then hands off when an action waits for approval', async () => {
    h.runOverride = async () => ({ text: 'I have passed this to the team, someone will confirm shortly.', handoff: false, pendingApproval: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(String(h.state.updatePayload?.ai_handoff_summary)).toMatch(/approve/)
  })

  it('still hands off when the reply slot is lost but an action is pending', async () => {
    h.state.claim = false
    h.runOverride = async () => ({ text: 'One moment.', handoff: false, pendingApproval: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })
})
