import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assignHandoff } from './handoff-pool'

function fakeDb(opts: { pool?: string[]; next?: string | null }) {
  const log = { updates: [] as Record<string, unknown>[], isNull: [] as string[], notifications: [] as Record<string, unknown>[], rpc: [] as string[] }
  const db = {
    from: (table: string) => {
      if (table === 'ai_agent_handoff_members') {
        const chain = { select: () => chain, eq: () => chain, order: async () => ({ data: (opts.pool ?? []).map((user_id) => ({ user_id })), error: null }) }
        return chain
      }
      if (table === 'conversations') {
        return {
          update: (row: Record<string, unknown>) => {
            log.updates.push(row)
            return { eq: () => ({ is: async (col: string) => (log.isNull.push(col), { error: null }) }) }
          },
        }
      }
      return {
        insert: async (rows: Record<string, unknown>[]) => {
          log.notifications.push(...rows)
          return { error: null }
        },
      }
    },
    rpc: async (name: string) => {
      log.rpc.push(name)
      return { data: opts.next ?? null, error: null }
    },
  } as unknown as SupabaseClient
  return { db, log }
}

const base = { accountId: 'a', conversationId: 'c', contactId: 'ct', agentId: 'ag', legacyAssigneeId: null }

describe('assignHandoff', () => {
  it('assigns the next online person from the pool, never over an existing assignee', async () => {
    const { db, log } = fakeDb({ pool: ['u1', 'u2'], next: 'u2' })
    expect(await assignHandoff(db, base)).toEqual({ assignedTo: 'u2', notified: 0 })
    expect(log.updates).toEqual([{ assigned_agent_id: 'u2' }])
    expect(log.isNull).toEqual(['assigned_agent_id'])
  })

  it('leaves the chat queued and notifies everyone when nobody in the pool is online', async () => {
    const { db, log } = fakeDb({ pool: ['u1', 'u2'], next: null })
    const out = await assignHandoff(db, { ...base, question: 'Where is my order?' })
    expect(out).toEqual({ assignedTo: null, notified: 2 })
    expect(log.updates).toEqual([])
    expect(log.notifications.map((n) => [n.user_id, n.type, n.body])).toEqual([
      ['u1', 'ai_handoff', 'Where is my order?'],
      ['u2', 'ai_handoff', 'Where is my order?'],
    ])
  })

  it('falls back to the single legacy handoff person when the agent has no pool', async () => {
    const { db, log } = fakeDb({ pool: [] })
    expect(await assignHandoff(db, { ...base, legacyAssigneeId: 'old' })).toEqual({ assignedTo: 'old', notified: 0 })
    expect(log.rpc).toEqual([])
  })

  it('stays in the shared queue with no pool and no legacy person', async () => {
    const { db, log } = fakeDb({ pool: [] })
    expect(await assignHandoff(db, base)).toEqual({ assignedTo: null, notified: 0 })
    expect(log.notifications).toEqual([])
  })
})
