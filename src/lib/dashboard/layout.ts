/**
 * Dashboard home layout (AWS-console style): the cards can be reordered
 * and hidden, and the result is remembered per user on this device
 * (see src/hooks/use-dashboard-layout.ts). Pure, unit-tested.
 */

import type { FeatureId } from '@/lib/features/use-cases'

export const WIDGET_IDS = [
  'attention',
  'kpis',
  'volume',
  'replyQueue',
  'pipeline',
  'team',
  'campaigns',
  'activity',
] as const
export type WidgetId = (typeof WIDGET_IDS)[number]

/** Use-case gate per widget (src/lib/features/use-cases.ts); unlisted = always shown. */
export const WIDGET_FEATURE: Partial<Record<WidgetId, FeatureId>> = {
  replyQueue: 'widget.replyQueue',
  pipeline: 'widget.pipeline',
  campaigns: 'widget.campaigns',
}

/** Width on the 6-column xl grid; narrower screens collapse (see WIDGET_SPAN). */
export type WidgetSize = 'full' | 'wide' | 'narrow' | 'third'

export const WIDGET_SIZE: Record<WidgetId, WidgetSize> = {
  attention: 'full',
  kpis: 'full',
  volume: 'wide',
  replyQueue: 'narrow',
  pipeline: 'third',
  team: 'third',
  campaigns: 'third',
  activity: 'full',
}

/** Tailwind span classes per size (grid: 1 col, lg 2 cols, xl 6 cols). */
export const WIDGET_SPAN: Record<WidgetSize, string> = {
  full: 'lg:col-span-2 xl:col-span-6',
  wide: 'lg:col-span-2 xl:col-span-4',
  narrow: 'lg:col-span-2 xl:col-span-2',
  third: 'lg:col-span-1 xl:col-span-2',
}

export interface DashboardLayout {
  order: WidgetId[]
  hidden: WidgetId[]
}

export const DEFAULT_LAYOUT: DashboardLayout = {
  order: [...WIDGET_IDS],
  hidden: [],
}

export function isWidgetId(v: unknown): v is WidgetId {
  return typeof v === 'string' && (WIDGET_IDS as readonly string[]).includes(v)
}

/**
 * Read a stored layout. Unknown ids and duplicates are dropped, widgets
 * added in a later release are appended, junk falls back to the default.
 */
export function parseLayout(raw: string | null | undefined): DashboardLayout {
  if (!raw) return DEFAULT_LAYOUT
  try {
    const v = JSON.parse(raw) as { order?: unknown; hidden?: unknown } | null
    if (!v || typeof v !== 'object' || !Array.isArray(v.order)) return DEFAULT_LAYOUT
    const order: WidgetId[] = []
    for (const id of v.order) if (isWidgetId(id) && !order.includes(id)) order.push(id)
    for (const id of WIDGET_IDS) if (!order.includes(id)) order.push(id)
    const hidden: WidgetId[] = []
    if (Array.isArray(v.hidden)) {
      for (const id of v.hidden) if (isWidgetId(id) && !hidden.includes(id)) hidden.push(id)
    }
    return { order, hidden }
  } catch {
    return DEFAULT_LAYOUT
  }
}

/** Move `activeId` to where `overId` is (drag and drop). */
export function moveWidget(layout: DashboardLayout, activeId: WidgetId, overId: WidgetId): DashboardLayout {
  const from = layout.order.indexOf(activeId)
  const to = layout.order.indexOf(overId)
  if (from < 0 || to < 0 || from === to) return layout
  const order = [...layout.order]
  order.splice(from, 1)
  order.splice(to, 0, activeId)
  return { ...layout, order }
}

/** Hide or show a card. Hidden cards keep their place, so showing restores it. */
export function setHidden(layout: DashboardLayout, id: WidgetId, hidden: boolean): DashboardLayout {
  const isHidden = layout.hidden.includes(id)
  if (hidden === isHidden) return layout
  return {
    ...layout,
    hidden: hidden ? [...layout.hidden, id] : layout.hidden.filter((x) => x !== id),
  }
}

export function visibleWidgets(layout: DashboardLayout): WidgetId[] {
  return layout.order.filter((id) => !layout.hidden.includes(id))
}

export function isDefaultLayout(layout: DashboardLayout): boolean {
  return (
    layout.hidden.length === 0 &&
    layout.order.length === DEFAULT_LAYOUT.order.length &&
    layout.order.every((id, i) => id === DEFAULT_LAYOUT.order[i])
  )
}
