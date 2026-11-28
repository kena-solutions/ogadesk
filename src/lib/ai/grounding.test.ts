import { describe, it, expect } from 'vitest'
import { canonicalNumber, checkGrounding, extractFacts } from './grounding'

describe('canonicalNumber', () => {
  it('reads thousands separators and decimals in common formats', () => {
    expect(canonicalNumber('5,000')).toBe('5000')
    expect(canonicalNumber('5 000')).toBe('5000')
    expect(canonicalNumber('5,000.50')).toBe('5000.5')
    expect(canonicalNumber('5.000,50')).toBe('5000.5')
    expect(canonicalNumber('12,5')).toBe('12.5')
    expect(canonicalNumber('5.000')).toBe('5000')
  })
})

describe('extractFacts', () => {
  it('finds prices, percentages, multi-digit numbers, links and emails', () => {
    const f = extractFacts('The plan is ₦5,000 per month, 20% off, delivery in 30 days. See https://acme.com/pricing or mail Help@Acme.com.')
    expect(f.numbers.sort()).toEqual(['20', '30', '5000'])
    expect(f.urls).toEqual(['acme.com/pricing'])
    expect(f.emails).toEqual(['help@acme.com'])
  })

  it('ignores single digits and times, but not a single digit with a currency or percent', () => {
    expect(extractFacts('We have 2 options, open at 9:00 or 5 minutes later').numbers).toEqual([])
    expect(extractFacts('Only $5 or 5%').numbers).toEqual(['5'])
  })

  it('reads Arabic-Indic and Devanagari digits', () => {
    expect(extractFacts('السعر ٥٠٠٠ ريال').numbers).toEqual(['5000'])
    expect(extractFacts('कीमत ५०० रुपये है').numbers).toEqual(['500'])
  })

  it('does not read digits inside a link or email as numbers', () => {
    expect(extractFacts('Visit https://acme.com/p/12345 or a12345@x.co').numbers).toEqual([])
  })
})

describe('checkGrounding', () => {
  const kb = 'Standard delivery costs ₦2,500 and takes 3 to 5 working days. Free over ₦50,000. Returns within 30 days at https://acme.com/returns'

  it('passes a reply whose facts are all in the knowledge', () => {
    expect(checkGrounding('Delivery is ₦2,500 and free above 50000 naira. Returns: https://acme.com/returns', [kb])).toEqual({ ok: true, unsupported: [] })
  })

  it('flags an invented price, date or link', () => {
    const r = checkGrounding('Delivery is ₦3,000, and you can return within 14 days at https://other.com', [kb])
    expect(r.ok).toBe(false)
    expect(r.unsupported.sort()).toEqual(['14', '3000', 'other.com'])
  })

  it('counts facts from the conversation and the instructions as supported', () => {
    expect(checkGrounding('Your order 884213 ships today for ₦1,200', [kb, 'customer: order 884213 please', 'Our flat fee is 1200']).ok).toBe(true)
  })

  it('accepts a link that is a prefix of a known one', () => {
    expect(checkGrounding('See acme.com/returns', ['https://acme.com/returns/policy']).ok).toBe(true)
    expect(checkGrounding('See https://acme.com/returns', ['www.acme.com/returns']).ok).toBe(true)
  })

  it('is fine with replies that state no risky facts', () => {
    expect(checkGrounding('Sure, happy to help! Which item is it about?', []).ok).toBe(true)
  })

  it('flags a fact when there is no evidence at all', () => {
    expect(checkGrounding('That costs 4,500.', []).ok).toBe(false)
  })

  it('matches numbers across digit systems', () => {
    expect(checkGrounding('السعر 5000', ['السعر ٥٠٠٠ ريال']).ok).toBe(true)
  })
})
