'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, ListChecks, Loader2, Play, Trash2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { EvalExpected, EvalResult, EvalStatus } from '@/lib/ai/evals';

interface CheckCase {
  id: string;
  question: string;
  expected: EvalExpected;
  last_result: EvalResult | null;
  last_run_at: string | null;
}

const CONCURRENCY = 3;

/** The agent's saved questions: run them all, see which still behave the same, accept a new answer. */
export function AgentChecks({ agentId, canEdit, refreshKey }: { agentId: string; canEdit: boolean; refreshKey: number }) {
  const t = useTranslations('Agents.checks');
  const [cases, setCases] = useState<CheckCase[] | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const runningAll = running.size > 0;
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/ai/evals?agent_id=${agentId}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    setCases(res.ok ? (data.cases ?? []) : []);
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const patch = (id: string, fn: (c: CheckCase) => CheckCase) => setCases((list) => (list ?? []).map((c) => (c.id === id ? fn(c) : c)));

  const runOne = async (c: CheckCase): Promise<boolean> => {
    setRunning((s) => new Set(s).add(c.id));
    try {
      const res = await fetch('/api/ai/evals/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: c.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('runFailed'));
        // A provider or credit problem will fail every check: stop the rest.
        return false;
      }
      patch(c.id, (x) => ({ ...x, last_result: data.result, last_run_at: data.result.ran_at }));
      return true;
    } finally {
      setRunning((s) => {
        const next = new Set(s);
        next.delete(c.id);
        return next;
      });
    }
  };

  const runAll = async () => {
    const queue = [...(cases ?? [])];
    stopRef.current = false;
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next || stopRef.current) return;
        if (!(await runOne(next))) stopRef.current = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  };

  const remove = async (c: CheckCase) => {
    const res = await fetch(`/api/ai/evals/${c.id}`, { method: 'DELETE' });
    if (res.ok) setCases((list) => (list ?? []).filter((x) => x.id !== c.id));
    else toast.error(t('deleteFailed'));
  };

  const accept = async (c: CheckCase) => {
    const res = await fetch(`/api/ai/evals/${c.id}/accept`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return void toast.error(data.error ?? t('deleteFailed'));
    patch(c.id, (x) => ({ ...x, expected: data.expected, last_result: x.last_result ? { ...x.last_result, status: 'same' } : null }));
    toast.success(t('accepted'));
  };

  if (cases === null || (cases.length === 0 && !canEdit)) return null;

  const ran = cases.filter((c) => c.last_result);
  const passing = ran.filter((c) => c.last_result!.status === 'same').length;

  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ListChecks className="h-4 w-4 text-primary" /> {t('title')}
          {ran.length > 0 && <span className="text-xs font-normal text-muted-foreground">{t('passing', { ok: passing, total: ran.length })}</span>}
        </h3>
        {canEdit && cases.length > 0 && (
          <Button size="sm" onClick={runAll} disabled={runningAll}>
            {runningAll ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
            {t('runAll')}
          </Button>
        )}
      </div>

      {cases.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {cases.map((c) => {
            const r = c.last_result;
            return (
              <li key={c.id} className="px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)} className="min-w-0 flex-1 truncate text-left text-foreground hover:underline">
                    {c.question}
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {running.has(c.id) ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : r ? (
                      <StatusPill status={r.status} />
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('notRun')}</span>
                    )}
                    {canEdit && (
                      <>
                        <button type="button" onClick={() => void runOne(c)} disabled={running.has(c.id)} aria-label={t('runOne')} className="text-muted-foreground hover:text-foreground disabled:opacity-40">
                          <Play className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => void remove(c)} aria-label={t('delete')} className="text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {open === c.id && (
                  <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                    <Side label={t('before')} handoff={c.expected.handoff} sources={c.expected.source_titles} reply={c.expected.sample_reply} />
                    {r && <Side label={t('now')} handoff={r.handoff} sources={r.source_titles} reply={r.reply} />}
                    {r && r.status !== 'same' && canEdit && (
                      <div className="sm:col-span-2">
                        <Button size="sm" variant="outline" onClick={() => void accept(c)}>
                          {t('accept')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: EvalStatus }) {
  const t = useTranslations('Agents.checks');
  const ok = status === 'same';
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', ok ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400')}>
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <TriangleAlert className="h-3 w-3" />}
      {t(`status.${status}`)}
    </span>
  );
}

function Side({ label, handoff, sources, reply }: { label: string; handoff: boolean; sources: string[]; reply: string }) {
  const t = useTranslations('Agents.checks');
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2">
      <p className="font-medium text-foreground">{label}</p>
      <p className="mt-0.5 text-muted-foreground">{handoff ? t('handedOff') : reply || t('noReply')}</p>
      <p className="mt-1 text-muted-foreground">{sources.length > 0 ? t('usedSources', { titles: sources.join(', ') }) : t('noSources')}</p>
    </div>
  );
}
