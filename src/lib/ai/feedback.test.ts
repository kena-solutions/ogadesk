import { describe, it, expect } from 'vitest'
import { parseFeedback } from './feedback'

const ID = '11111111-1111-1111-1111-111111111111'

describe('parseFeedback', () => {
  it('accepts a thumbs-down with a known reason', () => {
    expect(parseFeedback({ message_id: ID, rating: 'down', reason: 'wrong' })).toEqual({ messageId: ID, rating: 'down', reason: 'wrong' })
  })

  it('drops the reason on a thumbs-up and ignores unknown reasons', () => {
    expect(parseFeedback({ message_id: ID, rating: 'up', reason: 'wrong' })?.reason).toBeNull()
    expect(parseFeedback({ message_id: ID, rating: 'down', reason: 'nope' })?.reason).toBeNull()
    expect(parseFeedback({ message_id: ID, rating: 'down' })?.reason).toBeNull()
  })

  it('rejects bad ids, ratings and bodies', () => {
    expect(parseFeedback({ message_id: 'x', rating: 'up' })).toBeNull()
    expect(parseFeedback({ message_id: ID, rating: 'meh' })).toBeNull()
    expect(parseFeedback(null)).toBeNull()
    expect(parseFeedback('up')).toBeNull()
  })
})
