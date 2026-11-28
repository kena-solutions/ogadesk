'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Route } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AgentDto } from '@/lib/ai/agents-client';
import type { AgentStatus } from '@/lib/ai/agents';
import type { Tag } from '@/types';

interface Result {
  agent: { id: string; name: string } | null;
  reason: string;
  matched: string[];
  considered: { id: string; status: AgentStatus }[];
}

/** "Which agent would answer this?": a dialog with the order of agents and a what-if box. */
export function RoutingTest({ agents }: { agents: AgentDto[] }) {
  const t = useTranslations('Agents.routingTest');
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<'whatsapp' | 'web_chat'>('whatsapp');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void createClient()
      .from('tags')
      .select('*')
      .order('name')
      .then(({ data }) => alive && setTags((data ?? []) as Tag[]));
    return () => {
      alive = false;
    };
  }, [open]);

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/ai/routing/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, tag_ids: tagIds, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(data.error ?? t('failed'));
      setResult(data as Result);
    } finally {
      setBusy(false);
    }
  };

  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? '';
  const ruleSummary = (a: AgentDto) => {
    const r = a.routing;
    if (!r) return t('noRules');
    const parts = [
      (r.tags?.length ?? 0) > 0 ? t('ruleTags', { count: r.tags!.length }) : null,
      (r.keywords?.length ?? 0) > 0 ? t('ruleKeywords', { words: r.keywords!.slice(0, 3).join(', ') }) : null,
      r.hours?.enabled ? t('ruleHours', { from: r.hours.from ?? '', to: r.hours.to ?? '' }) : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : t('noRules');
  };
  // The order agents are tried in: rules first (priority), then plain ones, then the default.
  const ordered = [...agents].sort((a, b) => b.priority - a.priority || Number(b.is_default) - Number(a.is_default));

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Route className="mr-1.5 h-4 w-4" /> {t('button')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
          </DialogHeader>

          <ol className="divide-y divide-border rounded-lg border border-border text-sm">
            {ordered.map((a) => {
              const status = result?.considered.find((c) => c.id === a.id)?.status;
              return (
                <li key={a.id} className={cn('flex items-center justify-between gap-3 px-3 py-2', status === 'chosen' && 'bg-primary/5')}>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{a.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.channels.map((c) => t(`channel.${c}`)).join(', ')} · {ruleSummary(a)}
                    </p>
                  </div>
                  <span className={cn('shrink-0 text-xs', status === 'chosen' ? 'font-medium text-primary' : 'text-muted-foreground')}>
                    {status ? t(`status.${status}`) : `${t('priority')} ${a.priority}`}
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('channelLabel')}</Label>
              <Select value={channel} onValueChange={(v) => v && setChannel(v as 'whatsapp' | 'web_chat')}>
                <SelectTrigger>
                  <SelectValue>{t(`channel.${channel}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="whatsapp">{t('channel.whatsapp')}</SelectItem>
                  <SelectItem value="web_chat">{t('channel.web_chat')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rt-text">{t('messageLabel')}</Label>
              <Input id="rt-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('messagePlaceholder')} />
            </div>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => {
                const on = tagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => setTagIds(on ? tagIds.filter((x) => x !== tag.id) : [...tagIds, tag.id])}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs',
                      on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm text-foreground">
              {result &&
                (result.agent
                  ? t('answers', { name: name(result.agent.id) || result.agent.name, reason: t(`reason.${result.reason}`) })
                  : t('nobody'))}
            </p>
            <Button size="sm" onClick={run} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t('run')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
