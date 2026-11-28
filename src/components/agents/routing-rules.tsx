'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { AgentRouting } from '@/lib/ai/agents';
import type { Tag } from '@/types';

const DAYS = [1, 2, 3, 4, 5, 6, 0];

/** "Use this agent when…": optional contact tags, keywords and business hours. */
export function RoutingRules({
  value,
  onChange,
  disabled,
}: {
  value: AgentRouting;
  onChange: (next: AgentRouting) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Agents.rules');
  const [tags, setTags] = useState<Tag[]>([]);
  // Keywords are typed freely and only split on save, so commas can be typed.
  const [keywordText, setKeywordText] = useState((value.keywords ?? []).join(', '));

  useEffect(() => {
    let alive = true;
    void createClient()
      .from('tags')
      .select('*')
      .order('name')
      .then(({ data }) => alive && setTags((data ?? []) as Tag[]));
    return () => {
      alive = false;
    };
  }, []);

  const selected = value.tags ?? [];
  const hours = value.hours ?? { enabled: false, days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' };
  const setHours = (patch: Partial<typeof hours>) => onChange({ ...value, hours: { ...hours, ...patch } });
  const weekday = (d: number) => new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'short' });

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t('tags')}</Label>
        {tags.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noTags')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const on = selected.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ ...value, tags: on ? selected.filter((x) => x !== tag.id) : [...selected, tag.id] })}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50',
                    on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rr-keywords">{t('keywords')}</Label>
        <Input
          id="rr-keywords"
          value={keywordText}
          onChange={(e) => {
            setKeywordText(e.target.value);
            onChange({ ...value, keywords: e.target.value.split(/[\n,]/).map((k) => k.trim()).filter(Boolean) });
          }}
          placeholder={t('keywordsPlaceholder')}
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label>{t('hours')}</Label>
          <Switch checked={hours.enabled === true} onCheckedChange={(v) => setHours({ enabled: v })} disabled={disabled} />
        </div>
        {hours.enabled && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1">
              {DAYS.map((d) => {
                const on = (hours.days ?? []).includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={disabled}
                    onClick={() => setHours({ days: on ? (hours.days ?? []).filter((x) => x !== d) : [...(hours.days ?? []), d] })}
                    className={cn(
                      'h-7 rounded-md border px-2 text-xs disabled:opacity-50',
                      on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {weekday(d)}
                  </button>
                );
              })}
            </div>
            <Input type="time" value={hours.from ?? '09:00'} onChange={(e) => setHours({ from: e.target.value })} className="w-28" disabled={disabled} />
            <span className="text-xs text-muted-foreground">{t('to')}</span>
            <Input type="time" value={hours.to ?? '17:00'} onChange={(e) => setHours({ to: e.target.value })} className="w-28" disabled={disabled} />
          </div>
        )}
      </div>
    </div>
  );
}
