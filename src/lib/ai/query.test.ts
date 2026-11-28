import { describe, it, expect } from 'vitest'
import { buildRetrievalQuery, keywordQuery, latestUserMessage } from './query'

describe('latestUserMessage', () => {
  it('returns the most recent user turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    ).toBe('latest')
  })

  it('falls back to the last message when none are user', () => {
    expect(
      latestUserMessage([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(latestUserMessage([])).toBe('')
  })
})

describe('buildRetrievalQuery', () => {
  it('uses a full question as is', () => {
    expect(
      buildRetrievalQuery([
        { role: 'user', content: 'Do you deliver to Abuja?' },
        { role: 'assistant', content: 'Yes.' },
        { role: 'user', content: 'What are your opening hours on public holidays please?' },
      ]),
    ).toBe('What are your opening hours on public holidays please?')
  })

  it('joins a short follow-up with the previous question', () => {
    expect(
      buildRetrievalQuery([
        { role: 'user', content: 'Do you deliver to Abuja?' },
        { role: 'assistant', content: 'Yes, in 2 days.' },
        { role: 'user', content: 'how much is it?' },
      ]),
    ).toBe('Do you deliver to Abuja?\nhow much is it?')
  })

  it('handles a first short message and an empty thread', () => {
    expect(buildRetrievalQuery([{ role: 'user', content: 'refund?' }])).toBe('refund?')
    expect(buildRetrievalQuery([])).toBe('')
  })
})

describe('keywordQuery', () => {
  it('keeps only meaningful terms', () => {
    expect(keywordQuery('What is the price of the iPhone 15?')).toBe('price iphone 15')
    expect(keywordQuery('¿Cuál es el precio del envío?')).toBe('cuál precio envío')
    expect(keywordQuery('the and of')).toBe('')
  })

  it('drops common words in the other app languages too', () => {
    expect(keywordQuery('berapa harga untuk pengiriman ke Lagos?')).toBe('berapa harga pengiriman lagos')
    expect(keywordQuery('bei gani ya usafirishaji wa Nairobi')).toBe('bei usafirishaji nairobi')
    expect(keywordQuery('क्या डिलीवरी की कीमत है')).toBe('डिलीवरी कीमत')
    expect(keywordQuery('ما هو سعر الشحن')).toBe('سعر الشحن')
  })
})
