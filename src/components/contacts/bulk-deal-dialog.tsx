'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { CURRENCIES } from '@/lib/currency';
import { buildDealRows, chunk, type BulkOutcome, type BulkProgress } from '@/lib/contacts/bulk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Pipeline, PipelineStage } from '@/types';
import { BulkProgressBar, BulkResultBlock } from './bulk-result';

interface Props {
  contacts: { id: string; name?: string | null; phone: string }[];
  onClose: () => void;
  onDone: () => void;
  /** 'support' = create tickets (support pipelines only); 'sales' = deals. Omitted = every pipeline. */
  kind?: 'sales' | 'support';
}

/**
 * Create one open deal per selected contact in a chosen pipeline stage.
 * Also used by the contact detail "Add deal" button with a single contact.
 */
export function BulkDealDialog({ contacts, onClose, onDone, kind }: Props) {
  const t = useTranslations('Contacts.page.bulk');
  const supabase = createClient();
  const { accountId, user, defaultCurrency } = useAuth();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');
  const [title, setTitle] = useState('{name}');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);

  const single = contacts.length === 1;
  const ticket = kind === 'support';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let q = supabase.from('pipelines').select('*');
      if (kind) q = q.eq('kind', kind);
      const { data } = await q.order('created_at');
      if (cancelled) return;
      const list = (data as Pipeline[] | null) ?? [];
      setPipelines(list);
      if (list[0]) setPipelineId(list[0].id);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, kind]);

  useEffect(() => {
    if (!pipelineId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.from('pipeline_stages').select('*').eq('pipeline_id', pipelineId).order('position');
      if (cancelled) return;
      const list = (data as PipelineStage[] | null) ?? [];
      setStages(list);
      setStageId(list[0]?.id ?? '');
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, pipelineId]);

  async function run() {
    if (!accountId || !user || !pipelineId || !stageId) return;
    setRunning(true);
    const rows = buildDealRows({
      contacts,
      titleTemplate: title,
      pipelineId,
      stageId,
      value: Number(value) || 0,
      currency,
      userId: user.id,
      accountId,
    });
    const result: BulkOutcome = { ok: 0, skipped: 0, failed: 0, errors: [] };
    let done = 0;
    setProgress({ done: 0, total: rows.length });
    for (const part of chunk(rows, 200)) {
      const { error } = await supabase.from('deals').insert(part);
      if (error) {
        result.failed += part.length;
        if (result.errors.length < 20) result.errors.push({ id: part[0].contact_id, reason: error.message });
      } else {
        result.ok += part.length;
      }
      done += part.length;
      setProgress({ done, total: rows.length });
    }
    setOutcome(result);
    setRunning(false);
    onDone();
  }

  const pipelineName = pipelines.find((p) => p.id === pipelineId)?.name ?? '';
  const stage = stages.find((s) => s.id === stageId);

  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ticket ? t('addTicketTitle') : t('addDealTitle')}</DialogTitle>
          <DialogDescription>{single ? t('forOneContact') : t('forContacts', { count: contacts.length })}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : pipelines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noPipelines')}</p>
        ) : outcome ? (
          <BulkResultBlock
            outcome={outcome}
            okLabel={ticket ? t('ticketsCreated', { count: outcome.ok }) : t('dealsCreated', { count: outcome.ok })}
            nameById={Object.fromEntries(contacts.map((c) => [c.id, c.name || c.phone]))}
          />
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('pipeline')}</Label>
                <Select value={pipelineId} onValueChange={(v) => v && setPipelineId(v)} disabled={running}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue>{pipelineName}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {pipelines.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('stage')}</Label>
                <Select value={stageId} onValueChange={(v) => v && setStageId(v)} disabled={running}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue>{stage?.name ?? ''}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{ticket ? t('ticketTitle') : t('dealTitle')}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={running} className="bg-muted" />
              {!single && <p className="text-[11px] text-muted-foreground">{t('dealTitleHint')}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('dealValue')}</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  disabled={running}
                  className="bg-muted"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('currency')}</Label>
                <Select value={currency} onValueChange={(v) => v && setCurrency(v)} disabled={running}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue>{currency}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <BulkProgressBar progress={running ? progress : null} />
          </div>
        )}

        <DialogFooter>
          {outcome ? (
            <Button onClick={onClose}>{t('close')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={running}>
                {t('cancel')}
              </Button>
              <Button onClick={run} disabled={running || loading || !pipelineId || !stageId || pipelines.length === 0}>
                {running && <Loader2 className="size-4 animate-spin" />}
                {ticket ? t('addTicketRun', { count: contacts.length }) : t('addDealRun', { count: contacts.length })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
