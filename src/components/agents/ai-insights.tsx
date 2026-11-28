'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen, Loader2, Plus, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AddSourceDialog } from './add-source-dialog';
import { fetchAgents, type AgentDto } from '@/lib/ai/agents-client';

interface Insights {
  days: number;
  agents: { agent_id: string | null; replied: number; handoff: number; skipped: number; error: number; avg_sources: number | null }[];
  gaps: { question: string; count: number; agent_id: string | null }[];
  sources: { title: string; count: number }[];
  feedback?: {
    agents: { agent_id: string | null; up: number; down: number }[];
    down: FeedbackItem[];
    up: FeedbackItem[];
  };
}

interface FeedbackItem {
  id: string;
  reason: string | null;
  agent_id: string | null;
  conversation_id: string;
  question: string | null;
  reply: string | null;
  sources: string[] | null;
  created_at: string;
}

const RANGES = [7, 30, 90];

/** How the agents are doing, and what customers asked that no knowledge answered. */
export function AiInsights() {
  const t = useTranslations('Agents.insights');
  const { accountId } = useAuth();
  const router = useRouter();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Insights | null>(null);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [question, setQuestion] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    try {
      const res = await fetch(`/api/ai/insights?days=${days}`, { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('loadFailed'));
        setData({ days, agents: [], gaps: [], sources: [] });
        return;
      }
      setData(json as Insights);
    } catch {
      setData({ days, agents: [], gaps: [], sources: [] });
    }
  }, [days, t]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (accountId) void fetchAgents(accountId).then(setAgents);
  }, [accountId]);

  const agentName = (id: string | null) => agents.find((a) => a.id === id)?.name ?? t('deletedAgent');

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Select value={String(days)} onValueChange={(v) => v && setDays(Number(v))}>
          <SelectTrigger className="w-40">
            <SelectValue>{t('lastDays', { days })}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {t('lastDays', { days: d })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {data === null ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : data.agents.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-6 py-14 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.agents.map((a) => {
              const answered = a.replied + a.handoff;
              const rate = answered > 0 ? Math.round((a.handoff / answered) * 100) : 0;
              return (
                <div key={a.agent_id ?? 'none'} className="rounded-xl border border-border bg-card p-4">
                  <p className="truncate font-medium text-foreground">{agentName(a.agent_id)}</p>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <Stat label={t('replied')} value={a.replied} />
                    <Stat label={t('handedOff')} value={a.handoff} />
                    <Stat label={t('handoffRate')} value={`${rate}%`} />
                  </div>
                  {(() => {
                    const f = data.feedback?.agents.find((x) => x.agent_id === a.agent_id);
                    return f && f.up + f.down > 0 ? (
                      <p className="mt-2 flex items-center justify-center gap-3 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><ThumbsUp className="h-3 w-3" /> {f.up}</span>
                        <span className="inline-flex items-center gap-1"><ThumbsDown className="h-3 w-3" /> {f.down}</span>
                      </p>
                    ) : null;
                  })()}
                  <p className="mt-3 text-xs text-muted-foreground">
                    {t('avgSources', { avg: (a.avg_sources ?? 0).toFixed(1) })}
                    {a.skipped > 0 && ` · ${t('skipped', { count: a.skipped })}`}
                  </p>
                </div>
              );
            })}
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">{t('gapsTitle')}</h3>
            {data.gaps.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noGaps')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {data.gaps.map((g) => (
                  <li key={g.question} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-foreground">{g.question}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('askedTimes', { count: g.count })} · {agentName(g.agent_id)}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setQuestion(g.question)}>
                      <Plus className="mr-1.5 h-4 w-4" /> {t('addAnswer')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(data.feedback?.down.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">{t('needsFixing')}</h3>
              <ul className="divide-y divide-border rounded-xl border border-border">
                {data.feedback!.down.map((f) => (
                  <li key={f.id} className="space-y-1 px-3 py-2.5 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-foreground">{f.question || t('noQuestion')}</p>
                        <p className="line-clamp-2 text-xs text-muted-foreground">{f.reply}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {f.reason ? `${t(`reason.${f.reason}`)} · ` : ''}
                          {agentName(f.agent_id)}
                          {f.sources && f.sources.length > 0 && ` · ${f.sources.slice(0, 2).join(', ')}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => router.push(`/inbox?c=${f.conversation_id}`)}>
                          {t('openChat')}
                        </Button>
                        {f.question && (
                          <Button size="sm" variant="outline" onClick={() => setQuestion(f.question)}>
                            <Plus className="mr-1.5 h-4 w-4" /> {t('addAnswer')}
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.sources.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">{t('topSources')}</h3>
              <ul className="divide-y divide-border rounded-xl border border-border">
                {data.sources.map((s) => (
                  <li key={s.title} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-foreground">{s.title}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t('usedTimes', { count: s.count })}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <AddSourceDialog
        open={question !== null}
        onOpenChange={(o) => !o && setQuestion(null)}
        initialQuestion={question ?? undefined}
        onCreated={() => {
          setQuestion(null);
          void load();
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <p className="text-lg font-semibold text-foreground">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
