import { describe, expect, it } from 'vitest'
import { isFeatureEnabled, pipelineKindsFor } from './use-cases'

describe('isFeatureEnabled', () => {
  it('shows everything when no use case is picked', () => {
    expect(isFeatureEnabled('action.createDeal', [])).toBe(true)
    expect(isFeatureEnabled('action.createDeal', null)).toBe(true)
  })
  it('shows untagged features always', () => {
    expect(isFeatureEnabled(undefined, ['developer'])).toBe(true)
  })
  it('gates by the picked use cases', () => {
    expect(isFeatureEnabled('action.createDeal', ['support'])).toBe(false)
    expect(isFeatureEnabled('action.createDeal', ['support', 'sales'])).toBe(true)
    expect(isFeatureEnabled('action.createTicket', ['support'])).toBe(true)
    expect(isFeatureEnabled('nav.aiAgents', ['developer'])).toBe(false)
    expect(isFeatureEnabled('nav.forms', ['developer'])).toBe(true)
  })
})

describe('pipelineKindsFor', () => {
  it('filters by sales-only or support-only, otherwise all', () => {
    expect(pipelineKindsFor(['sales'])).toEqual(['sales'])
    expect(pipelineKindsFor(['support', 'developer'])).toEqual(['support'])
    expect(pipelineKindsFor(['sales', 'support'])).toBeNull()
    expect(pipelineKindsFor([])).toBeNull()
    expect(pipelineKindsFor(['marketing'])).toBeNull()
  })
})
