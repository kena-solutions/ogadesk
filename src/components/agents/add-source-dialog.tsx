'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { FileText, Globe, Link2, Loader2, MessagesSquare, Plus, Trash2, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  FileRejectedError,
  KNOWLEDGE_FILE_ACCEPT,
  extractFileText,
  removeKnowledgeFile,
  uploadKnowledgeFile,
  type SourceDto,
} from '@/lib/ai/knowledge-client';
import { KNOWLEDGE_LIMITS, type SourceType, type SyncInterval } from '@/lib/ai/ingest/limits';

const TYPES: { type: SourceType; icon: typeof FileText }[] = [
  { type: 'text', icon: FileText },
  { type: 'qa', icon: MessagesSquare },
  { type: 'file', icon: Upload },
  { type: 'url', icon: Link2 },
  { type: 'website', icon: Globe },
];

interface Pair {
  question: string;
  answer: string;
}

export function AddSourceDialog({
  open,
  onOpenChange,
  onCreated,
  linkAgentId,
  initialQuestion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (source: SourceDto) => void;
  /** Link the new source to this agent (admins). */
  linkAgentId?: string;
  /** Open on a Q&A source with this question already filled in (from a knowledge gap). */
  initialQuestion?: string;
}) {
  const t = useTranslations('Agents.library');
  const { accountId } = useAuth();
  const [type, setType] = useState<SourceType>('text');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [pairs, setPairs] = useState<Pair[]>([{ question: '', answer: '' }]);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState<number>(KNOWLEDGE_LIMITS.defaultWebsitePages);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [sync, setSync] = useState<SyncInterval>('none');
  const [busy, setBusy] = useState<null | 'reading' | 'uploading' | 'indexing'>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Opening with a question (a gap from Insights) starts a Q&A source with it filled in.
  useEffect(() => {
    if (open && initialQuestion) {
      setType('qa');
      setName(initialQuestion.slice(0, 80));
      setPairs([{ question: initialQuestion, answer: '' }]);
    }
  }, [open, initialQuestion]);

  const reset = () => {
    setType('text');
    setName('');
    setContent('');
    setPairs([{ question: '', answer: '' }]);
    setFile(null);
    setUrl('');
    setMaxPages(KNOWLEDGE_LIMITS.defaultWebsitePages);
    setInclude('');
    setExclude('');
    setSync('none');
  };

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const fileError = (err: unknown) => {
    if (err instanceof FileRejectedError) {
      toast.error(
        {
          type: t('fileTypeError'),
          size: t('fileSizeError', { mb: KNOWLEDGE_LIMITS.maxFileBytes / 1024 / 1024 }),
          empty: t('fileEmptyError'),
          unreadable: t('fileUnreadableError'),
        }[err.reason],
      );
    } else {
      toast.error(t('uploadFailed'));
    }
  };

  const submit = async () => {
    const body: Record<string, unknown> = { type, name: name.trim() || undefined };
    if (linkAgentId) body.link_agent_id = linkAgentId;
    let uploadedPath: string | null = null;

    try {
      if (type === 'text') {
        if (!name.trim() || !content.trim()) return void toast.error(t('textRequired'));
        body.content = content;
      } else if (type === 'qa') {
        const filled = pairs.filter((p) => p.question.trim() && p.answer.trim());
        if (!name.trim() || filled.length === 0) return void toast.error(t('qaRequired'));
        body.pairs = filled;
      } else if (type === 'file') {
        if (!file || !accountId) return void toast.error(t('fileRequired'));
        setBusy('reading');
        let text: string;
        try {
          text = await extractFileText(file);
        } catch (err) {
          return void fileError(err);
        }
        setBusy('uploading');
        let uploaded: { path: string; mime: string };
        try {
          uploaded = await uploadKnowledgeFile(accountId, file);
        } catch (err) {
          return void fileError(err);
        }
        uploadedPath = uploaded.path;
        body.file = { name: file.name, mime: uploaded.mime, size: file.size, storage_path: uploaded.path, text };
      } else {
        if (!url.trim()) return void toast.error(t('urlRequired'));
        if (type === 'url') body.url = url.trim();
        else {
          body.start_url = url.trim();
          body.max_pages = maxPages;
          body.include = include;
          body.exclude = exclude;
        }
        body.sync_interval = sync;
      }

      setBusy('indexing');
      const res = await fetch('/api/ai/knowledge/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (uploadedPath) await removeKnowledgeFile(uploadedPath);
        return void toast.error(data.error ?? t('saveFailed'));
      }
      const source = data.source as SourceDto;
      if (source.status === 'failed') toast.error(source.error ?? t('indexFailed'));
      else if (source.status === 'ready') toast.success(t('added'));
      else toast.success(t('addedProcessing'));
      onCreated(source);
      reset();
      onOpenChange(false);
    } catch {
      if (uploadedPath) await removeKnowledgeFile(uploadedPath);
      toast.error(t('saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('addTitle')}</DialogTitle>
          <DialogDescription>{t('addDesc')}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {TYPES.map(({ type: value, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setType(value)}
              disabled={!!busy}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border p-2.5 text-xs transition-colors',
                type === value
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              <Icon className="h-4 w-4" />
              {t(`type.${value}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t(`typeHint.${type}`)}</p>

        <div className="space-y-3">
          {(type === 'text' || type === 'qa' || type === 'file') && (
            <div className="space-y-1.5">
              <Label htmlFor="ks-name">
                {t('name')}
                {type === 'file' && <span className="font-normal text-muted-foreground"> {t('optional')}</span>}
              </Label>
              <Input
                id="ks-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                maxLength={200}
              />
            </div>
          )}

          {type === 'text' && (
            <div className="space-y-1.5">
              <Label htmlFor="ks-content">{t('content')}</Label>
              <Textarea
                id="ks-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={t('contentPlaceholder')}
                rows={10}
              />
            </div>
          )}

          {type === 'qa' && (
            <QaEditor pairs={pairs} onChange={setPairs} />
          )}

          {type === 'file' && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
              onClick={() => fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground hover:bg-muted/40"
            >
              <Upload className="h-5 w-5" />
              {file ? (
                <span className="font-medium text-foreground">{file.name}</span>
              ) : (
                <span>{t('dropFile')}</span>
              )}
              <span className="text-xs">{t('fileTypes', { mb: KNOWLEDGE_LIMITS.maxFileBytes / 1024 / 1024 })}</span>
              <input
                ref={fileRef}
                type="file"
                accept={KNOWLEDGE_FILE_ACCEPT}
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
          )}

          {(type === 'url' || type === 'website') && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="ks-url">{type === 'url' ? t('pageUrl') : t('siteUrl')}</Label>
                <Input
                  id="ks-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={type === 'url' ? 'https://example.com/help/returns' : 'https://example.com'}
                />
              </div>
              {type === 'website' && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="ks-max">{t('maxPages')}</Label>
                    <Input
                      id="ks-max"
                      type="number"
                      min={1}
                      max={KNOWLEDGE_LIMITS.maxWebsitePages}
                      value={maxPages}
                      onChange={(e) =>
                        setMaxPages(
                          Math.min(KNOWLEDGE_LIMITS.maxWebsitePages, Math.max(1, Number(e.target.value) || 1)),
                        )
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ks-inc">{t('includePaths')}</Label>
                    <Input id="ks-inc" value={include} onChange={(e) => setInclude(e.target.value)} placeholder="/help, /faq" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ks-exc">{t('excludePaths')}</Label>
                    <Input id="ks-exc" value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="/blog" />
                  </div>
                </div>
              )}
              <SyncSelect value={sync} onChange={setSync} />
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={!!busy}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={!!busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {busy ? t(`busy.${busy}`) : t('add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function QaEditor({ pairs, onChange, disabled }: { pairs: Pair[]; onChange: (p: Pair[]) => void; disabled?: boolean }) {
  const t = useTranslations('Agents.library');
  const set = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-2">
      {pairs.map((p, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border border-border p-2.5">
          <div className="flex items-center gap-2">
            <Input
              value={p.question}
              onChange={(e) => set(i, { question: e.target.value })}
              placeholder={t('question')}
              disabled={disabled}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(pairs.length > 1 ? pairs.filter((_, j) => j !== i) : [{ question: '', answer: '' }])}
              disabled={disabled}
              aria-label={t('removePair')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <Textarea
            value={p.answer}
            onChange={(e) => set(i, { answer: e.target.value })}
            placeholder={t('answer')}
            rows={2}
            disabled={disabled}
          />
        </div>
      ))}
      {pairs.length < KNOWLEDGE_LIMITS.maxQaPairs && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...pairs, { question: '', answer: '' }])}
          disabled={disabled}
        >
          <Plus className="mr-1.5 h-4 w-4" /> {t('addPair')}
        </Button>
      )}
    </div>
  );
}

export function SyncSelect({
  value,
  onChange,
  disabled,
}: {
  value: SyncInterval;
  onChange: (v: SyncInterval) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Agents.library');
  return (
    <div className="space-y-1.5">
      <Label>{t('resync')}</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v as SyncInterval)} disabled={disabled}>
        <SelectTrigger className="w-48">
          <SelectValue>{t(`sync.${value}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(['none', 'daily', 'weekly'] as const).map((s) => (
            <SelectItem key={s} value={s}>
              {t(`sync.${s}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
