'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, Code2, Headset, Megaphone, TrendingUp, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'

import { useAuth } from '@/hooks/use-auth'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PhoneField } from '@/components/phone-field'
import { DETAIL_MAX, HEARD_FROM, USE_CASES, WORKSPACE_NAME_MAX, type HeardFrom, type UseCase } from '@/lib/onboarding/options'
import { cn } from '@/lib/utils'

const PHONE_RE = /^\+\d{8,15}$/

export const ONBOARDED_EVENT = 'wacrm:onboarded'

const USE_CASE_ICONS: Record<UseCase, LucideIcon> = {
  developer: Code2,
  support: Headset,
  sales: TrendingUp,
  marketing: Megaphone,
}

/**
 * One-time questions for the workspace owner right after first login: what they
 * will use OgaDesk for (pick any), and where they heard about us. Mounted once in
 * the dashboard shell; renders nothing unless the server says it is needed.
 */
export function OnboardingDialog() {
  const t = useTranslations('Onboarding')
  const { accountId, accountStatus, isOwner, refreshProfile } = useAuth()
  const [needed, setNeeded] = useState(false)
  const [step, setStep] = useState<1 | 2>(1)
  const [useCases, setUseCases] = useState<UseCase[]>([])
  const [heardFrom, setHeardFrom] = useState<HeardFrom | null>(null)
  const [detail, setDetail] = useState('')
  const [optIn, setOptIn] = useState(true)
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  // Arrived through a partner link: skip the "where did you hear" step.
  const [referred, setReferred] = useState(false)
  // First card: the workspace's default name (editable, optional) and the free trial they will start, if any.
  const [workspaceName, setWorkspaceName] = useState('')
  const [trialOffer, setTrialOffer] = useState<{ planName: string; days: number } | null>(null)

  useEffect(() => {
    if (!accountId || accountStatus !== 'ready' || !isOwner) return
    let cancelled = false
    void fetch('/api/onboarding')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { needsOnboarding?: boolean; referred?: boolean; workspaceName?: string; trialOffer?: { planName: string; days: number } | null } | null) => {
        if (cancelled) return
        if (d?.referred) setReferred(true)
        if (d?.workspaceName) setWorkspaceName(d.workspaceName)
        if (d?.trialOffer) setTrialOffer(d.trialOffer)
        if (d?.needsOnboarding) setNeeded(true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [accountId, accountStatus, isOwner])

  async function submit(skipSource: boolean) {
    setSaving(true)
    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          use_cases: useCases,
          heard_from: referred ? 'partner' : skipSource ? null : heardFrom,
          heard_from_detail: skipSource ? null : detail || null,
          marketing_opt_in: optIn,
          phone: phone.trim() || null,
          workspace_name: workspaceName.trim() || null,
        }),
      })
      if (!res.ok) throw new Error('save failed')
      const saved = (await res.json().catch(() => null)) as { trial?: { planName: string; days: number } | null } | null
      if (saved?.trial) toast.success(t('trialStarted', { days: saved.trial.days, plan: saved.trial.planName }))
      setNeeded(false)
      void refreshProfile()
      window.dispatchEvent(new Event(ONBOARDED_EVENT))
    } catch {
      toast.error(t('error'))
    } finally {
      setSaving(false)
    }
  }

  function toggleUseCase(uc: UseCase) {
    setUseCases((cur) => (cur.includes(uc) ? cur.filter((x) => x !== uc) : [...cur, uc]))
  }

  if (!needed) return null

  return (
    // Not dismissible: answering (or skipping the second step) is the way out.
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        {step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('subtitle')}</DialogDescription>
            </DialogHeader>
            {trialOffer && (
              <p className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
                {t('trialBanner', { days: trialOffer.days, plan: trialOffer.planName })}
              </p>
            )}
            <div className="space-y-1.5">
              <label htmlFor="onboarding-workspace" className="text-sm font-medium">{t('workspaceLabel')}</label>
              <Input
                id="onboarding-workspace"
                value={workspaceName}
                maxLength={WORKSPACE_NAME_MAX}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder={t('workspacePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <span id="onboarding-usecases-label" className="text-sm font-medium">{t('useCasesLabel')}</span>
              <Popover>
                <PopoverTrigger
                  aria-labelledby="onboarding-usecases-label"
                  className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 text-left text-sm transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                >
                  <span className={cn('truncate', useCases.length === 0 && 'text-muted-foreground')}>
                    {useCases.length === 0
                      ? t('useCasesPlaceholder')
                      : useCases.length <= 2
                        ? useCases.map((uc) => t(`useCases.${uc}.title`)).join(', ')
                        : t('useCasesSelected', { count: useCases.length })}
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-(--anchor-width) min-w-64 gap-0 p-1">
                  {USE_CASES.map((uc) => {
                    const Icon = USE_CASE_ICONS[uc]
                    return (
                      <label key={uc} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted">
                        <Checkbox checked={useCases.includes(uc)} onCheckedChange={() => toggleUseCase(uc)} />
                        <Icon className="size-4 shrink-0 text-primary" aria-hidden />
                        <span className="min-w-0 text-sm">
                          <span className="block font-medium">{t(`useCases.${uc}.title`)}</span>
                          <span className="block text-xs text-muted-foreground">{t(`useCases.${uc}.description`)}</span>
                        </span>
                      </label>
                    )
                  })}
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="onboarding-phone" className="text-sm font-medium">{t('phoneLabel')}</label>
              <PhoneField id="onboarding-phone" value={phone} onChange={setPhone} placeholder="8012345678" />
            </div>
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <Checkbox className="mt-0.5" checked={optIn} onCheckedChange={(v) => setOptIn(Boolean(v))} />
              <span>
                {t('marketingLabel')}
                <span className="block text-xs text-muted-foreground">{t('marketingHint')}</span>
              </span>
            </label>
            <div className="flex justify-end">
              <Button disabled={useCases.length === 0 || !PHONE_RE.test(phone.replace(/[\s().-]/g, '')) || saving} onClick={() => (referred ? void submit(true) : setStep(2))}>
                {referred ? (saving ? t('saving') : t('finish')) : t('next')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('sourceTitle')}</DialogTitle>
              <DialogDescription>{t('sourceSubtitle')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('sourceTitle')}>
              {HEARD_FROM.map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={heardFrom === h}
                  onClick={() => setHeardFrom(h)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-sm transition-colors',
                    heardFrom === h ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border hover:bg-muted/40',
                  )}
                >
                  {t(`sources.${h}`)}
                </button>
              ))}
            </div>
            {heardFrom && (
              <div className="space-y-1.5">
                <label htmlFor="onboarding-detail" className="text-sm text-muted-foreground">
                  {t('detailLabel')}
                </label>
                <Input
                  id="onboarding-detail"
                  value={detail}
                  maxLength={DETAIL_MAX}
                  placeholder={t('detailPlaceholder')}
                  onChange={(e) => setDetail(e.target.value)}
                />
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)} disabled={saving}>
                {t('back')}
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void submit(true)} disabled={saving}>
                  {t('skip')}
                </Button>
                <Button onClick={() => void submit(false)} disabled={saving}>
                  {saving ? t('saving') : t('finish')}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
