'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Bot, RotateCcw, Send, Loader2, UserCircle2, ArrowRight, BookOpen, Wrench, ListChecks, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** assistant-only: the agent signalled a human handoff on this turn. */
  handoff?: boolean;
  /** assistant-only: the knowledge excerpts the reply was grounded in. */
  sources?: PlaygroundSource[];
  /** assistant-only: tools the AI called for this reply (read tools ran; actions were only described). */
  toolCalls?: PlaygroundToolCall[];
  /** assistant-only: saved as a check. */
  savedAsCheck?: boolean;
}

interface PlaygroundToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
}

interface PlaygroundSource {
  title: string | null;
  snippet: string;
  score: number;
  matchedBy: 'semantic' | 'keyword' | 'both';
}

export function AiPlayground({
  onGoToSetup,
  agentId,
  onCheckSaved,
}: {
  onGoToSetup?: () => void;
  /** Test this agent; omitted = the default agent. */
  agentId?: string;
  /** Admins: show "Save as check" on replies; called after one is saved. */
  onCheckSaved?: () => void;
}) {
  const t = useTranslations('Agents.playground');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Remember this question and what the agent did as the result to keep an eye on.
  const saveCheck = async (index: number) => {
    const turn = turns[index];
    const question = [...turns.slice(0, index)].reverse().find((x) => x.role === 'user')?.content;
    if (!agentId || !question || turn.role !== 'assistant') return;
    const res = await fetch('/api/ai/evals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        question,
        origin: 'playground',
        expected: {
          handoff: Boolean(turn.handoff),
          source_titles: (turn.sources ?? []).map((s) => s.title ?? '').filter(Boolean),
          sample_reply: turn.content,
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return void toast.error(data.error ?? t('checkFailed'));
    setTurns((list) => list.map((x, i) => (i === index ? { ...x, savedAsCheck: true } : x)));
    toast.success(t('checkSaved'));
    onCheckSaved?.();
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setInput('');
    setSending(true);
    try {
      const res = await fetch('/api/ai/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send only role+content - the server ignores anything else.
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
          ...(agentId ? { agent_id: agentId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'ai_not_configured') {
          toast.error(t('notConfigured'));
        } else {
          toast.error(data.error ?? t('noReply'));
        }
        // Roll the unsent user turn back so the transcript stays clean.
        setTurns(turns);
        setInput(text);
        return;
      }
      setTurns([
        ...next,
        {
          role: 'assistant',
          content:
            typeof data.reply === 'string' && data.reply.trim()
              ? data.reply
              : '',
          handoff: Boolean(data.handoff),
          sources: Array.isArray(data.sources) ? data.sources : [],
          toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls : [],
        },
      ]);
    } catch {
      toast.error(t('unreachable'));
      setTurns(turns);
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-[60vh] min-h-[420px] flex-col rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">{t('title')}</span>
          <span className="text-xs text-muted-foreground">
            {t('subtitle')}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTurns([])}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> {t('reset')}
        </Button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
            <p>{t('emptyTitle')}</p>
            <p className="mt-1 text-xs">
              {t('emptyDesc')}
            </p>
            {onGoToSetup && (
              <Button
                variant="link"
                size="sm"
                onClick={onGoToSetup}
                className="mt-1 h-auto p-0 text-xs"
              >
                {t('goToSetup')} <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {turns.map((turn, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-2',
              turn.role === 'user' ? 'justify-end' : 'justify-start',
            )}
          >
            {turn.role === 'assistant' && (
              <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
            )}
            <div
              className={cn(
                'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm',
                turn.role === 'user'
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm bg-muted text-foreground',
              )}
            >
              {turn.content && <p className="whitespace-pre-wrap">{turn.content}</p>}
              {turn.role === 'assistant' && turn.handoff && (
                <p
                  className={cn(
                    'flex items-center gap-1 text-xs text-amber-500',
                    turn.content && 'mt-1.5 border-t border-border/50 pt-1.5',
                  )}
                >
                  <UserCircle2 className="h-3.5 w-3.5" />
                  {t('handoff')}
                </p>
              )}
              {turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0 && (
                <ToolsUsed calls={turn.toolCalls} />
              )}
              {turn.role === 'assistant' && turn.sources && (
                <SourcesUsed sources={turn.sources} />
              )}
              {turn.role === 'assistant' && onCheckSaved && agentId && (
                <button
                  type="button"
                  onClick={() => void saveCheck(i)}
                  disabled={turn.savedAsCheck}
                  className="mt-1.5 flex items-center gap-1 border-t border-border/50 pt-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default disabled:text-primary"
                >
                  {turn.savedAsCheck ? <Check className="h-3.5 w-3.5" /> : <ListChecks className="h-3.5 w-3.5" />}
                  {turn.savedAsCheck ? t('checkSavedShort') : t('saveAsCheck')}
                </button>
              )}
            </div>
            {turn.role === 'user' && (
              <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            )}
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-5 w-5 text-primary" />
            <Loader2 className="h-4 w-4 animate-spin" /> {t('thinking')}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex items-end gap-2 border-t border-border p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('placeholder')}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <Button
          size="sm"
          onClick={send}
          disabled={!input.trim() || sending}
          className="h-9 w-9 shrink-0 p-0"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

/** Collapsible list of the knowledge excerpts behind one reply. */
function SourcesUsed({ sources }: { sources: PlaygroundSource[] }) {
  const t = useTranslations('Agents.playground');
  if (sources.length === 0) {
    return (
      <p className="mt-1.5 border-t border-border/50 pt-1.5 text-xs text-muted-foreground">
        {t('noSources')}
      </p>
    );
  }
  return (
    <details className="mt-1.5 border-t border-border/50 pt-1.5 text-xs">
      <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
        <BookOpen className="h-3.5 w-3.5" />
        {t('sourcesUsed', { count: sources.length })}
      </summary>
      <ol className="mt-1.5 space-y-1.5">
        {sources.map((s, i) => (
          <li key={i} className="rounded-md bg-background/60 p-2">
            <p className="flex items-center justify-between gap-2 font-medium text-foreground">
              <span className="truncate">{s.title || t('untitled')}</span>
              <span className="shrink-0 font-normal text-muted-foreground">
                {matchLabel(s.matchedBy, t)} · {s.score.toFixed(2)}
              </span>
            </p>
            <p className="mt-0.5 line-clamp-3 text-muted-foreground">{s.snippet}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function matchLabel(matchedBy: 'semantic' | 'keyword' | 'both', t: (key: string) => string): string {
  return matchedBy === 'both' ? t('matchBoth') : matchedBy === 'semantic' ? t('matchSemantic') : t('matchKeyword');
}

/** Collapsible list of the tools the AI called for one reply. */
function ToolsUsed({ calls }: { calls: PlaygroundToolCall[] }) {
  const t = useTranslations('Agents.playground');
  return (
    <details className="mt-1.5 border-t border-border/50 pt-1.5 text-xs">
      <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
        <Wrench className="h-3.5 w-3.5" />
        {t('toolsUsed', { count: calls.length })}
      </summary>
      <ol className="mt-1.5 space-y-1.5">
        {calls.map((c, i) => (
          <li key={i} className="rounded-md bg-background/60 p-2">
            <p className={cn('font-mono font-medium', c.isError ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>{c.name}</p>
            <pre className="mt-0.5 overflow-auto whitespace-pre-wrap text-muted-foreground">{JSON.stringify(c.arguments)}</pre>
            <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-muted-foreground">{c.result}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
