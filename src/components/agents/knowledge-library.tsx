'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Eye,
  FileText,
  Globe,
  Link2,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import { getDateLocale } from '@/i18n/date-locale';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AddSourceDialog, QaEditor, SyncSelect } from './add-source-dialog';
import { KnowledgeTestSearch } from './knowledge-test-search';
import type { SourceDetailDto, SourceDocumentDto, SourceDto, SourceStatus } from '@/lib/ai/knowledge-client';
import { KNOWLEDGE_LIMITS, type SourceType, type SyncInterval } from '@/lib/ai/ingest/limits';

export const SOURCE_ICON: Record<SourceType, typeof FileText> = {
  text: FileText,
  qa: MessagesSquare,
  file: Upload,
  url: Link2,
  website: Globe,
};

const POLL_MS = 4000;

export function isWorking(status: SourceStatus): boolean {
  return status === 'queued' || status === 'processing';
}

export function StatusPill({ status, error }: { status: SourceStatus; error?: string | null }) {
  const t = useTranslations('Agents.library');
  const tone = {
    queued: 'bg-muted text-muted-foreground',
    processing: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    ready: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    partial: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    failed: 'bg-destructive/10 text-destructive',
  }[status];
  const Icon = isWorking(status) ? Loader2 : status === 'ready' ? CheckCircle2 : status === 'queued' ? Loader2 : AlertCircle;
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tone)}
      title={error ?? undefined}
    >
      <Icon className={cn('h-3 w-3', isWorking(status) && 'animate-spin')} />
      {t(`status.${status}`)}
    </span>
  );
}

/** Subtitle for a source: its URL, file name or counts. */
function sourceDetail(s: SourceDto): string | null {
  const c = s.config ?? {};
  if (s.type === 'url' && typeof c.url === 'string') return c.url;
  if (s.type === 'website' && typeof c.startUrl === 'string') return c.startUrl;
  if (s.type === 'file' && typeof c.fileName === 'string') return c.fileName;
  return null;
}

export function KnowledgeLibrary() {
  const t = useTranslations('Agents.library');
  const locale = getDateLocale(useLocale());
  const { accountId, accountRole, user } = useAuth();
  const canAdd = accountRole ? hasMinRole(accountRole, 'agent') : false;
  const isAdmin = accountRole ? hasMinRole(accountRole, 'admin') : false;

  const [sources, setSources] = useState<SourceDto[] | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<SourceType | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/knowledge/sources', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        setSources((s) => s ?? []);
        return;
      }
      setSources(data.sources ?? []);
    } catch {
      setSources((s) => s ?? []);
    }
  }, [t]);

  useEffect(() => {
    if (accountId) void load();
  }, [accountId, load]);

  // Poll while anything is still indexing.
  const working = (sources ?? []).some((s) => isWorking(s.status));
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [working, load]);

  const canEdit = (s: SourceDto) => isAdmin || (canAdd && s.created_by === user?.id);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sources ?? []).filter(
      (s) =>
        (typeFilter === 'all' || s.type === typeFilter) &&
        (!q || s.name.toLowerCase().includes(q) || (sourceDetail(s) ?? '').toLowerCase().includes(q)),
    );
  }, [sources, query, typeFilter]);

  const resync = async (s: SourceDto) => {
    setBusyId(s.id);
    try {
      const res = await fetch(`/api/ai/knowledge/sources/${s.id}/sync`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(data.error ?? t('syncFailed'));
      else toast.success(t('syncStarted'));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (s: SourceDto) => {
    const used = (s.agents ?? []).length;
    if (!window.confirm(used > 0 ? t('confirmDeleteUsed', { name: s.name, count: used }) : t('confirmDelete', { name: s.name }))) return;
    setBusyId(s.id);
    try {
      const res = await fetch(`/api/ai/knowledge/sources/${s.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(data.error ?? t('deleteFailed'));
      toast.success(t('deleted'));
      setSources((list) => (list ?? []).filter((x) => x.id !== s.id));
      if (openId === s.id) setOpenId(null);
    } finally {
      setBusyId(null);
    }
  };

  const reindexAll = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) toast.error(data.error ?? t('reindexFailed'));
      else if (data.remaining > 0) toast.success(t('reindexContinuing', { done: data.indexed, total: data.total }));
      else toast.success(t('reindexDone', { count: data.indexed }));
      await load();
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex gap-2">
          {isAdmin && (sources ?? []).length > 0 && (
            <Button variant="outline" size="sm" onClick={reindexAll} disabled={reindexing}>
              {reindexing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
              {t('reindexAll')}
            </Button>
          )}
          {canAdd && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> {t('addSource')}
            </Button>
          )}
        </div>
      </div>

      {(sources ?? []).length > 0 && <KnowledgeTestSearch />}

      {(sources ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search')} className="pl-8" />
          </div>
          <Select value={typeFilter} onValueChange={(v) => v && setTypeFilter(v as SourceType | 'all')}>
            <SelectTrigger className="w-40">
              <SelectValue>{typeFilter === 'all' ? t('allTypes') : t(`type.${typeFilter}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('allTypes')}</SelectItem>
              {(Object.keys(SOURCE_ICON) as SourceType[]).map((ty) => (
                <SelectItem key={ty} value={ty}>
                  {t(`type.${ty}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {sources === null ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : sources.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-14 text-center">
          <BookOpen className="mb-2 h-8 w-8 text-muted-foreground/60" />
          <p className="font-medium text-foreground">{t('emptyTitle')}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('emptyDesc')}</p>
          {canAdd && (
            <Button className="mt-4" size="sm" onClick={() => setAdding(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> {t('addSource')}
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('colSource')}</th>
                <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-3 py-2 font-medium">{t('colSize')}</th>
                <th className="px-3 py-2 font-medium">{t('colUsedBy')}</th>
                <th className="px-3 py-2 font-medium">{t('colSynced')}</th>
                <th className="w-10 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const Icon = SOURCE_ICON[s.type];
                const detail = sourceDetail(s);
                const linked = s.agents ?? [];
                const viaAll = (s.all_agents ?? []).filter((a) => !linked.some((l) => l.id === a.id));
                const users = [...linked, ...viaAll];
                return (
                  <tr key={s.id} className="border-t border-border hover:bg-muted/20">
                    <td className="max-w-[280px] px-3 py-2.5">
                      <button type="button" onClick={() => setOpenId(s.id)} className="flex min-w-0 items-start gap-2 text-left">
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-foreground hover:underline">{s.name}</span>
                          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusPill status={s.status} error={s.error} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
                      {s.type === 'website' || s.doc_count > 1
                        ? t('pagesChunks', { pages: s.doc_count, chunks: s.chunk_count })
                        : t('chunks', { count: s.chunk_count })}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground" title={users.map((u) => u.name).join(', ')}>
                      {users.length === 0 ? t('unused') : t('usedBy', { count: users.length })}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
                      {s.last_synced_at
                        ? formatDistanceToNow(new Date(s.last_synced_at), { addSuffix: true, locale })
                        : '-'}
                    </td>
                    <td className="px-3 py-2.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                          aria-label={t('actions')}
                          disabled={busyId === s.id}
                        >
                          {busyId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="border-border bg-popover">
                          <DropdownMenuItem onClick={() => setOpenId(s.id)}>
                            <Eye className="mr-2 h-4 w-4" /> {t('open')}
                          </DropdownMenuItem>
                          {canEdit(s) && (
                            <>
                              <DropdownMenuItem onClick={() => resync(s)} disabled={isWorking(s.status)}>
                                <RefreshCw className="mr-2 h-4 w-4" /> {s.type === 'url' || s.type === 'website' ? t('resyncNow') : t('reindex')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator className="bg-border" />
                              <DropdownMenuItem onClick={() => remove(s)} className="text-destructive">
                                <Trash2 className="mr-2 h-4 w-4" /> {t('delete')}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {t('noMatches')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <AddSourceDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(s) => setSources((list) => [s, ...(list ?? []).filter((x) => x.id !== s.id)])}
      />

      <SourceSheet
        sourceId={openId}
        onClose={() => setOpenId(null)}
        onChanged={load}
        onDelete={(s) => remove(s)}
      />
    </div>
  );
}

/** Detail drawer: settings, editable content, and the pages/documents. */
function SourceSheet({
  sourceId,
  onClose,
  onChanged,
  onDelete,
}: {
  sourceId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onDelete: (s: SourceDto) => void;
}) {
  const t = useTranslations('Agents.library');
  const [source, setSource] = useState<SourceDetailDto | null>(null);
  const [docs, setDocs] = useState<SourceDocumentDto[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [pairs, setPairs] = useState<{ question: string; answer: string }[]>([]);
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState<number>(KNOWLEDGE_LIMITS.defaultWebsitePages);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [sync, setSync] = useState<SyncInterval>('none');
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);

  const fetchDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/ai/knowledge/sources/${id}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? t('loadFailed'));
      return null;
    }
    return data as { source: SourceDetailDto; documents: SourceDocumentDto[] };
  }, [t]);

  const hydrate = useCallback((data: { source: SourceDetailDto; documents: SourceDocumentDto[] }) => {
    const s = data.source;
    const c = s.config ?? {};
    setSource(s);
    setDocs(data.documents);
    setName(s.name);
    setContent(s.content ?? '');
    setPairs(s.pairs && s.pairs.length > 0 ? s.pairs : [{ question: '', answer: '' }]);
    setUrl(typeof c.url === 'string' ? c.url : typeof c.startUrl === 'string' ? c.startUrl : '');
    setMaxPages(typeof c.maxPages === 'number' ? c.maxPages : KNOWLEDGE_LIMITS.defaultWebsitePages);
    setInclude(Array.isArray(c.include) ? (c.include as string[]).join(', ') : '');
    setExclude(Array.isArray(c.exclude) ? (c.exclude as string[]).join(', ') : '');
    setSync(s.sync_interval);
  }, []);

  useEffect(() => {
    setSource(null);
    setDocs([]);
    setPreview(null);
    if (!sourceId) return;
    let alive = true;
    void fetchDetail(sourceId).then((d) => alive && d && hydrate(d));
    return () => {
      alive = false;
    };
  }, [sourceId, fetchDetail, hydrate]);

  // Keep the page list fresh while it indexes.
  const working = source ? isWorking(source.status) : false;
  useEffect(() => {
    if (!working || !sourceId) return;
    const id = setInterval(async () => {
      const d = await fetchDetail(sourceId);
      if (d) {
        setSource((prev) => (prev ? { ...prev, ...d.source } : d.source));
        setDocs(d.documents);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [working, sourceId, fetchDetail]);

  const save = async () => {
    if (!source) return;
    const body: Record<string, unknown> = {};
    if (name.trim() !== source.name) body.name = name.trim();
    if (source.type === 'text' && content !== (source.content ?? '')) body.content = content;
    if (source.type === 'qa') body.pairs = pairs.filter((p) => p.question.trim() && p.answer.trim());
    if (source.type === 'url' && url.trim() !== source.config?.url) body.url = url.trim();
    if (source.type === 'website') {
      const c = source.config ?? {};
      if (url.trim() !== c.startUrl) body.start_url = url.trim();
      if (maxPages !== c.maxPages) body.max_pages = maxPages;
      if (include !== (Array.isArray(c.include) ? (c.include as string[]).join(', ') : '')) body.include = include;
      if (exclude !== (Array.isArray(c.exclude) ? (c.exclude as string[]).join(', ') : '')) body.exclude = exclude;
    }
    if ((source.type === 'url' || source.type === 'website') && sync !== source.sync_interval) body.sync_interval = sync;
    if (Object.keys(body).length === 0) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/ai/knowledge/sources/${source.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(data.error ?? t('saveFailed'));
      toast.success(t('saved'));
      const d = await fetchDetail(source.id);
      if (d) hydrate(d);
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const showPreview = async (docId: string) => {
    if (!source) return;
    if (preview?.id === docId) return setPreview(null);
    const res = await fetch(`/api/ai/knowledge/sources/${source.id}?document=${docId}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) setPreview({ id: docId, text: data.document?.content || t('noText') });
  };

  const editable = source?.can_edit ?? false;

  return (
    <Sheet open={!!sourceId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {!source ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {(() => {
                  const Icon = SOURCE_ICON[source.type];
                  return <Icon className="h-4 w-4 text-muted-foreground" />;
                })()}
                <span className="truncate">{source.name}</span>
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StatusPill status={source.status} error={source.error} />
                <span>{t(`type.${source.type}`)}</span>
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-8">
              {source.error && source.status !== 'ready' && (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {source.error}
                </p>
              )}

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sd-name">{t('name')}</Label>
                  <Input id="sd-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} />
                </div>

                {source.type === 'text' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="sd-content">{t('content')}</Label>
                    <Textarea id="sd-content" value={content} onChange={(e) => setContent(e.target.value)} rows={12} disabled={!editable} />
                  </div>
                )}
                {source.type === 'qa' && <QaEditor pairs={pairs} onChange={setPairs} disabled={!editable} />}
                {(source.type === 'url' || source.type === 'website') && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="sd-url">{source.type === 'url' ? t('pageUrl') : t('siteUrl')}</Label>
                      <Input id="sd-url" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!editable} />
                    </div>
                    {source.type === 'website' && (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="sd-max">{t('maxPages')}</Label>
                          <Input
                            id="sd-max"
                            type="number"
                            min={1}
                            max={KNOWLEDGE_LIMITS.maxWebsitePages}
                            value={maxPages}
                            onChange={(e) =>
                              setMaxPages(Math.min(KNOWLEDGE_LIMITS.maxWebsitePages, Math.max(1, Number(e.target.value) || 1)))
                            }
                            disabled={!editable}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="sd-inc">{t('includePaths')}</Label>
                          <Input id="sd-inc" value={include} onChange={(e) => setInclude(e.target.value)} disabled={!editable} />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="sd-exc">{t('excludePaths')}</Label>
                          <Input id="sd-exc" value={exclude} onChange={(e) => setExclude(e.target.value)} disabled={!editable} />
                        </div>
                      </div>
                    )}
                    <SyncSelect value={sync} onChange={setSync} disabled={!editable} />
                  </>
                )}

                {editable && (
                  <div className="flex items-center justify-between">
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => onDelete(source)}>
                      <Trash2 className="mr-1.5 h-4 w-4" /> {t('delete')}
                    </Button>
                    <Button size="sm" onClick={save} disabled={saving}>
                      {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                      {t('saveChanges')}
                    </Button>
                  </div>
                )}
              </div>

              {(source.type === 'url' || source.type === 'website' || source.type === 'file') && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">
                    {source.type === 'website' ? t('pages', { count: docs.length }) : t('extractedText')}
                  </h3>
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {docs.map((d) => (
                      <li key={d.id} className="px-3 py-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-medium text-foreground">{d.title}</p>
                            {d.url && d.url !== d.title && <p className="truncate text-muted-foreground">{d.url}</p>}
                            {d.error && <p className="text-destructive">{d.error}</p>}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <StatusPill status={d.status} />
                            {d.status === 'ready' && (
                              <button type="button" onClick={() => showPreview(d.id)} className="text-primary hover:underline">
                                {preview?.id === d.id ? t('hide') : t('preview')}
                              </button>
                            )}
                          </div>
                        </div>
                        {preview?.id === d.id && (
                          <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-sans text-xs text-foreground">
                            {preview.text}
                          </pre>
                        )}
                      </li>
                    ))}
                    {docs.length === 0 && <li className="px-3 py-3 text-xs text-muted-foreground">{t('noPagesYet')}</li>}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
