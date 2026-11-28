'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, BookOpen, Bot, Globe, LifeBuoy, Loader2, Megaphone, MessageCircle, Plus, ShieldCheck, Star, TrendingUp, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { RoutingTest } from './routing-test';
import { AgentEditor, type AgentPreset } from './agent-editor';
import { AGENT_TEMPLATE_IDS, AGENT_TEMPLATES, type AgentTemplateId } from '@/lib/ai/agent-templates';
import { fetchAccountMembers } from '@/lib/account/members';
import { fetchAgents, invalidateAgents, type AgentDto } from '@/lib/ai/agents-client';
import { invalidateAiAccountStatus } from '@/lib/ai/account-status-cache';
import type { AccountMember } from '@/types';

const TEMPLATE_ICONS: Record<AgentTemplateId, typeof Bot> = {
  blank: FileText,
  support: LifeBuoy,
  sales: TrendingUp,
  marketing: Megaphone,
  admin: ShieldCheck,
};

export function AgentsPanel({ configured, workspaceModel, onGoToSettings, onDetailChange }: {
  /** The workspace has a provider key. */
  configured: boolean;
  workspaceModel: string | null;
  onGoToSettings: () => void;
  /** True while an agent or the template picker is open. */
  onDetailChange?: (open: boolean) => void;
}) {
  const t = useTranslations('Agents.list');
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const [agents, setAgents] = useState<AgentDto[] | null>(null);
  const [members, setMembers] = useState<AccountMember[]>([]);
  // undefined = list, null = new agent, string = editing that agent.
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [editorTab, setEditorTab] = useState<'setup' | 'knowledge' | 'playground'>('setup');
  // "New agent" first shows the template picker.
  const [picking, setPicking] = useState(false);
  const [preset, setPreset] = useState<AgentPreset | null>(null);
  const tt = useTranslations('Agents.templates');
  const startNew = () => setPicking(true);
  const pick = (id: AgentTemplateId) => {
    setPreset(
      id === 'blank'
        ? null
        : { ...AGENT_TEMPLATES[id], name: tt(`${id}.agentName`), description: tt(`${id}.description`) },
    );
    setPicking(false);
    setEditorTab('setup');
    setEditing(null);
  };

  const load = useCallback(async () => {
    if (!accountId) return;
    setAgents(await fetchAgents(accountId, true));
  }, [accountId]);

  useEffect(() => {
    void load();
    void fetchAccountMembers().then(setMembers);
  }, [load]);

  const detailOpen = editing !== undefined || picking;
  useEffect(() => {
    onDetailChange?.(detailOpen);
  }, [detailOpen, onDetailChange]);

  const changed = () => {
    if (accountId) invalidateAgents(accountId);
    invalidateAiAccountStatus();
  };

  if (editing !== undefined) {
    const agent = editing ? (agents ?? []).find((a) => a.id === editing) ?? null : null;
    return (
      <AgentEditor
        key={editing ?? 'new'}
        agent={agent}
        members={members}
        canEdit={canEdit}
        workspaceModel={workspaceModel}
        initialTab={editorTab}
        preset={editing ? null : preset}
        onBack={() => setEditing(undefined)}
        onSaved={(saved) => {
          changed();
          setAgents((list) => {
            const rest = (list ?? []).filter((a) => a.id !== saved.id);
            return agent ? (list ?? []).map((a) => (a.id === saved.id ? saved : a)) : [...rest, saved];
          });
          setEditing(saved.id);
        }}
        onDeleted={(id) => {
          changed();
          setAgents((list) => (list ?? []).filter((a) => a.id !== id));
          setEditing(undefined);
        }}
      />
    );
  }

  if (picking) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>
            <ArrowLeft className="mr-1 h-4 w-4" /> {tt('back')}
          </Button>
        </div>
        <h2 className="text-base font-semibold text-foreground">{tt('title')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {AGENT_TEMPLATE_IDS.map((id) => {
            const Icon = TEMPLATE_ICONS[id];
            return (
              <button
                key={id}
                type="button"
                onClick={() => pick(id)}
                className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/50"
              >
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="font-medium text-foreground">{tt(`${id}.name`)}</span>
                <span className="text-xs text-muted-foreground">{tt(`${id}.description`)}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!configured && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <span className="text-foreground">{t('notConfigured')}</span>
          <Button size="sm" variant="outline" onClick={onGoToSettings}>
            {t('goToSettings')} <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </div>
      )}

      {agents !== null && agents.length > 0 && (
        <div className="flex justify-end gap-2">
          {agents.length > 1 && <RoutingTest agents={agents} />}
          {canEdit && (
            <Button size="sm" onClick={startNew}>
              <Plus className="mr-1.5 h-4 w-4" /> {t('newAgent')}
            </Button>
          )}
        </div>
      )}

      {agents === null ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : agents.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-14 text-center">
          <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
          <p className="font-medium text-foreground">{t('emptyTitle')}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{configured ? t('emptyDesc') : t('emptyDescSetup')}</p>
          {canEdit && configured && (
            <Button className="mt-4" size="sm" onClick={startNew}>
              <Plus className="mr-1.5 h-4 w-4" /> {t('newAgent')}
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => (
            <div
              key={a.id}
              className={cn(
                'flex flex-col rounded-xl border bg-card p-4 transition-colors',
                a.is_active ? 'border-border' : 'border-dashed border-border opacity-75',
              )}
            >
              <button type="button" onClick={() => { setEditorTab('setup'); setEditing(a.id); }} className="text-left">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-foreground hover:underline">{a.name}</span>
                  {a.is_default && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      <Star className="h-2.5 w-2.5" /> {t('default')}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 min-h-[2rem] text-xs text-muted-foreground">
                  {a.description || t('noDescription')}
                </p>
              </button>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                <Chip on={a.is_active}>{a.is_active ? t('active') : t('inactive')}</Chip>
                <Chip on={a.auto_reply_enabled}>{a.auto_reply_enabled ? t('autoReplyOn') : t('draftsOnly')}</Chip>
                {a.channels.includes('whatsapp') && (
                  <Chip on><MessageCircle className="mr-0.5 h-3 w-3" />{t('whatsapp')}</Chip>
                )}
                {a.channels.includes('web_chat') && (
                  <Chip on><Globe className="mr-0.5 h-3 w-3" />{t('webChat')}</Chip>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs">
                <button
                  type="button"
                  onClick={() => { setEditorTab('knowledge'); setEditing(a.id); }}
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  {a.knowledge_mode === 'all' ? t('wholeLibrary') : t('sources', { count: a.source_count })}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditorTab('playground'); setEditing(a.id); }}
                  className="text-primary hover:underline"
                >
                  {t('test')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5',
        on ? 'bg-muted text-foreground' : 'bg-muted/50 text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}
