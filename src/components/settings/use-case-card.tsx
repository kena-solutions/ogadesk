'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Code2, Headset, Loader2, Megaphone, TrendingUp, type LucideIcon } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { USE_CASES, type UseCase } from '@/lib/onboarding/options';
import { cn } from '@/lib/utils';

const ICONS: Record<UseCase, LucideIcon> = { developer: Code2, support: Headset, sales: TrendingUp, marketing: Megaphone };

/** Your profile > how you use OgaDesk: the onboarding multi-choice, editable later. Owner edits; others read. */
export function UseCaseCard({ className }: { className?: string }) {
  const t = useTranslations('Settings.useCases');
  const tu = useTranslations('Onboarding');
  const { isOwner, refreshProfile } = useAuth();
  const [saved, setSaved] = useState<UseCase[] | null>(null);
  const [picked, setPicked] = useState<UseCase[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/onboarding', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { answers?: { use_cases?: UseCase[] } } | null) => {
        if (cancelled || !d) return;
        const v = (d.answers?.use_cases ?? []).filter((x) => (USE_CASES as readonly string[]).includes(x));
        setSaved(v);
        setPicked(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (saved === null) return null;
  const dirty = picked.length !== saved.length || picked.some((p) => !saved.includes(p));

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/onboarding', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ use_cases: picked }) });
      if (!res.ok) throw new Error('save failed');
      setSaved(picked);
      void refreshProfile();
      toast.success(t('saved'));
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className}>
      <CardContent className="space-y-4 p-4">
        <div>
          <p className="text-foreground text-sm font-medium">{t('title')}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{isOwner ? t('hint') : t('ownerOnly')}</p>
        </div>
        <div role="group" aria-label={t('title')} className="grid gap-2 sm:grid-cols-2">
          {USE_CASES.map((uc) => {
            const Icon = ICONS[uc];
            const on = picked.includes(uc);
            return (
              <button
                key={uc}
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={!isOwner}
                onClick={() => setPicked((cur) => (cur.includes(uc) ? cur.filter((x) => x !== uc) : [...cur, uc]))}
                className={cn('relative flex flex-col gap-1 rounded-lg border bg-card p-3 text-left transition-colors disabled:cursor-default', on ? 'border-primary/60 ring-2 ring-primary/40' : 'border-border enabled:hover:bg-muted/40')}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Icon className="text-primary size-4" aria-hidden />
                  {tu(`useCases.${uc}.title`)}
                </span>
                <span className="text-muted-foreground text-xs">{tu(`useCases.${uc}.description`)}</span>
                {on ? <Check className="text-primary absolute top-2 right-2 size-4" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
        {isOwner ? (
          <div className="flex justify-end">
            <Button onClick={() => void save()} disabled={saving || !dirty || picked.length === 0}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('save')}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
