'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { LayoutGrid } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useRealtime } from '@/hooks/use-realtime'
import { Button } from '@/components/ui/button'
import { loadActivity } from '@/lib/dashboard/queries'
import type { ActivityItem } from '@/lib/dashboard/types'
import {
  browserTimeZone,
  loadOverview,
  needsSetup,
  parseOverviewRange,
  type DashboardOverview,
  type OverviewRange,
} from '@/lib/dashboard/overview'
import { derivePresence } from '@/lib/presence'
import { isWidgetId, visibleWidgets, WIDGET_FEATURE, WIDGET_IDS, type WidgetId } from '@/lib/dashboard/layout'
import { isFeatureEnabled } from '@/lib/features/use-cases'
import { useDashboardLayout } from '@/hooks/use-dashboard-layout'
import { WidgetFrame } from '@/components/dashboard/widget-frame'

import { ActivityFeed } from '@/components/dashboard/activity-feed'
import { AttentionRow } from '@/components/dashboard/attention-row'
import { CampaignsCard } from '@/components/dashboard/campaigns-card'
import { KpiRow } from '@/components/dashboard/kpi-row'
import { MessageVolumeCard } from '@/components/dashboard/message-volume-card'
import { OverviewHeader } from '@/components/dashboard/overview-header'
import { PipelineCard } from '@/components/dashboard/pipeline-card'
import { ReplyQueueCard } from '@/components/dashboard/reply-queue-card'
import { SetupChecklist } from '@/components/dashboard/setup-checklist'
import { DeveloperChecklist } from '@/components/onboarding/developer-checklist'
import { TeamCard } from '@/components/dashboard/team-card'

const POLL_MS = 60_000
const REALTIME_DEBOUNCE_MS = 2_000

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardPageInner />
    </Suspense>
  )
}

function DashboardPageInner() {
  const t = useTranslations('Dashboard.overview')
  const router = useRouter()
  const searchParams = useSearchParams()
  const range = parseOverviewRange(searchParams.get('range'))
  const tl = useTranslations('Dashboard.overview.layout')
  const { defaultCurrency, profile, user, useCases } = useAuth()
  const { layout, move, hide, show, reset } = useDashboardLayout(user?.id)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return
      if (isWidgetId(active.id) && isWidgetId(over.id)) move(active.id, over.id)
    },
    [move],
  )

  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [failed, setFailed] = useState(false)
  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const requestRef = useRef(0)
  const debounceRef = useRef<number | null>(null)

  const refresh = useCallback((days: OverviewRange) => {
    const request = ++requestRef.current
    loadOverview(createClient(), days, browserTimeZone())
      .then((data) => {
        if (request !== requestRef.current) return
        setOverview(data)
        setFailed(false)
        setNow(Date.now())
      })
      .catch((err) => {
        if (request !== requestRef.current) return
        console.error('[dashboard] overview failed:', err)
        setFailed(true)
      })
  }, [])

  useEffect(() => {
    refresh(range)
  }, [range, refresh])

  useEffect(() => {
    loadActivity(createClient(), 50)
      .then(setActivity)
      .catch((err) => console.error('[dashboard] activity failed:', err))
      .finally(() => setActivityLoading(false))
  }, [])

  useEffect(() => {
    const tick = window.setInterval(() => {
      setNow(Date.now())
      if (document.visibilityState === 'visible') refresh(range)
    }, POLL_MS)
    return () => window.clearInterval(tick)
  }, [range, refresh])

  useEffect(
    () => () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    },
    [],
  )

  const scheduleRefresh = useCallback(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => refresh(range), REALTIME_DEBOUNCE_MS)
  }, [range, refresh])

  useRealtime({
    channelName: 'dashboard-overview',
    onMessageEvent: scheduleRefresh,
    onConversationEvent: scheduleRefresh,
  })

  const handleRangeChange = useCallback(
    (next: OverviewRange) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('range', String(next))
      setFailed(false)
      router.replace(`/dashboard?${params.toString()}`, { scroll: false })
    },
    [router, searchParams],
  )

  const data = overview?.days === range ? overview : null

  const onlineCount = useMemo(
    () =>
      (overview?.replies.team ?? []).filter(
        (m) => derivePresence(m.presence ?? undefined, m.lastSeenAt, now) === 'online',
      ).length,
    [overview, now],
  )

  const showLayout = !(data && needsSetup(data.setup))
  const enabled = (id: WidgetId) => isFeatureEnabled(WIDGET_FEATURE[id], useCases)
  const visible = visibleWidgets(layout).filter(enabled)
  const widgets: Record<WidgetId, () => ReactNode> = {
    attention: () => <AttentionRow data={data} now={now} onlineCount={onlineCount} />,
    kpis: () => <KpiRow data={data} currency={defaultCurrency} />,
    volume: () => <MessageVolumeCard data={data} />,
    replyQueue: () => <ReplyQueueCard data={data} now={now} />,
    pipeline: () => <PipelineCard data={data} currency={defaultCurrency} />,
    team: () => <TeamCard data={data} now={now} />,
    campaigns: () => <CampaignsCard data={data} />,
    activity: () => <ActivityFeed items={activity} loading={activityLoading} />,
  }

  if (failed && !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
        <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => refresh(range)}>
          {t('retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <OverviewHeader
        data={data}
        now={now}
        name={profile?.full_name ?? null}
        range={range}
        onRangeChange={handleRangeChange}
        {...(showLayout
          ? {
              layout,
              availableWidgets: WIDGET_IDS.filter(enabled),
              onToggleWidget: (id: WidgetId, on: boolean) => (on ? show(id) : hide(id)),
              onResetLayout: reset,
            }
          : {})}
      />

      {/* Only renders for workspaces that picked "Developer API". */}
      <DeveloperChecklist />

      {!showLayout && data ? (
        <SetupChecklist setup={data.setup} />
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <LayoutGrid className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">{tl('allHidden')}</p>
          <Button variant="outline" size="sm" onClick={reset}>
            {tl('reset')}
          </Button>
        </div>
      ) : (
        // Cards can be dragged (handle on each card's top edge) and hidden;
        // the arrangement is remembered per user on this device.
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={visible} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-6">
              {visible.map((id) => (
                <WidgetFrame key={id} id={id} onHide={hide}>
                  {widgets[id]()}
                </WidgetFrame>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}
