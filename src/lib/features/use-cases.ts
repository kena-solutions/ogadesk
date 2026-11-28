import type { UseCase } from '@/lib/onboarding/options'

/**
 * Use-case gating: which workspace use cases (picked at onboarding, editable
 * in Settings) surface which feature. Every customer-visible feature -- a nav
 * item, dashboard widget, inbox/contact/bulk button -- gets an id here.
 * See .claude/skills/use-case-gating/SKILL.md.
 *
 * Rules (see isFeatureEnabled):
 *  - no use case picked (or still loading) => everything is shown;
 *  - a feature that is not listed here is always shown;
 *  - otherwise it is shown when at least one of its use cases is picked.
 * Hiding is cosmetic (nav, widgets, buttons): pages stay reachable by URL.
 */
const ALL: readonly UseCase[] = ['developer', 'support', 'sales', 'marketing']
const NON_DEV: readonly UseCase[] = ['support', 'sales', 'marketing']

export const featureUseCases = {
  // Navigation
  'nav.pipelines': ['sales', 'support'],
  'nav.forms': ALL, // developers embed forms, support uses them for intake
  'nav.broadcasts': ['marketing', 'sales'],
  'nav.automations': NON_DEV,
  'nav.aiAgents': NON_DEV,

  // Dashboard widgets
  'widget.replyQueue': ['support', 'sales'],
  'widget.pipeline': ['sales', 'support'],
  'widget.campaigns': ['marketing', 'sales'],
  'kpi.dealsWon': ['sales'],
  'kpi.broadcasts': ['marketing'],

  // Buttons / actions
  'action.createDeal': ['sales'],
  'action.createTicket': ['support'],
  'action.sendTemplate': ['marketing', 'sales'],

  // Settings / onboarding
  'card.developerChecklist': ['developer'],
} as const satisfies Record<string, readonly UseCase[]>

export type FeatureId = keyof typeof featureUseCases

export function isFeatureEnabled(feature: FeatureId | undefined, useCases: readonly string[] | null | undefined): boolean {
  if (!feature) return true
  if (!useCases || useCases.length === 0) return true
  const wanted = featureUseCases[feature] as readonly string[] | undefined
  if (!wanted) return true
  return wanted.some((uc) => useCases.includes(uc))
}

/**
 * Which pipeline kinds a workspace cares about: sales-only sees deals,
 * support-only sees tickets, anything else (both, none, other use cases) sees all.
 * Returns null for "all".
 */
export function pipelineKindsFor(useCases: readonly string[] | null | undefined): ('sales' | 'support')[] | null {
  const sales = !!useCases?.includes('sales')
  const support = !!useCases?.includes('support')
  if (sales && !support) return ['sales']
  if (support && !sales) return ['support']
  return null
}
