import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pauseAiForHumanReply } from './pause'

function fake(error: unknown = null) {
  const calls: string[] = []
  const chain: Record<string, unknown> = {
    update: (row: Record<string, unknown>) => (calls.push(`update:${JSON.stringify(row)}`), chain),
    eq: (c: string, v: unknown) => (calls.push(`eq:${c}=${v}`), c === 'ai_autoreply_disabled' ? Promise.resolve({ error }) : chain),
  }
  return { db: { from: () => chain } as unknown as SupabaseClient, calls }
}

describe('pauseAiForHumanReply', () => {
  it('pauses the AI only on chats where it is still on', async () => {
    const { db, calls } = fake()
    await pauseAiForHumanReply(db, 'c1')
    expect(calls).toEqual(['update:{"ai_autoreply_disabled":true}', 'eq:id=c1', 'eq:ai_autoreply_disabled=false'])
  })

  it('never throws', async () => {
    await expect(pauseAiForHumanReply(fake(new Error('x')).db, 'c1')).resolves.toBeUndefined()
    const broken = { from: () => { throw new Error('boom') } } as unknown as SupabaseClient
    await expect(pauseAiForHumanReply(broken, 'c1')).resolves.toBeUndefined()
  })
})
