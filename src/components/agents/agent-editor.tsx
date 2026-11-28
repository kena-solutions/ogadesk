'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AgentTools } from './agent-tools';
import { ArrowLeft, Blocks, BookOpen, Loader2, Plus, Search, Settings2, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AiPlayground } from './ai-playground';
import { AddSourceDialog } from './add-source-dialog';
import { SOURCE_ICON, StatusPill } from './knowledge-library';
import { memberLabel } from '@/lib/account/members';
import type { AccountMember } from '@/types';
import type { AgentDto } from '@/lib/ai/agents-client';
import type { AgentChannel, KnowledgeMode } from '@/lib/ai/agents';
import type { SourceDto } from '@/lib/ai/knowledge-client';
import type { AgentTemplate } from '@/lib/ai/agent-templates';

// Base UI Select can't use an empty value, so "shared queue" gets a sentinel.
const HANDOFF_QUEUE = '__queue__';
const CHANNELS: AgentChannel[] = ['whatsapp', 'web_chat'];

type SubTab = 'setup' | 'knowledge' | 'tools' | 'playground';

interface Form {
  name: string;
  description: string;
  is_active: boolean;
  model: string;
  system_prompt: string;
  auto_reply_enabled: boolean;
  reply_mode: 'fallback' | 'always';
  auto_reply_max_per_conversation: number;
  handoff_agent_id: string;
  channels: AgentChannel[];
  priority: number;
  persona_gender: string;
  persona_tone: string;
  persona_behaviour: string;
  persona_avoid: string;
  persona_never: string;
}

interface PersonaDefaults {
  name: string | null;
  gender: string | null;
  tone: string | null;
  behaviour: string | null;
  avoid: string | null;
  never: string | null;
}

/** A template pre-fills a NEW agent; its name/description are already translated. */
export type AgentPreset = AgentTemplate & { name: string; description: string };

function toForm(a: AgentDto | null, preset?: AgentPreset | null): Form {
  return {
    name: a?.name ?? preset?.name ?? '',
    description: a?.description ?? preset?.description ?? '',
    is_active: a?.is_active ?? true,
    model: a?.model ?? '',
    system_prompt: a?.system_prompt ?? preset?.system_prompt ?? '',
    auto_reply_enabled: a?.auto_reply_enabled ?? false,
    reply_mode: a?.reply_mode === 'always' ? 'always' : 'fallback',
    auto_reply_max_per_conversation:
      a?.auto_reply_max_per_conversation ?? preset?.auto_reply_max_per_conversation ?? 3,
    handoff_agent_id: a?.handoff_agent_id ?? '',
    channels: a?.channels ?? preset?.channels ?? ['whatsapp', 'web_chat'],
    priority: a?.priority ?? 0,
    persona_gender: a?.persona_gender ?? '',
    persona_tone: a?.persona_tone ?? '',
    persona_behaviour: a?.persona_behaviour ?? '',
    persona_avoid: a?.persona_avoid ?? '',
    persona_never: a?.persona_never ?? '',
  };
}

export function AgentEditor({
  agent,
  members,
  canEdit,
  workspaceModel,
  initialTab = 'setup',
  preset,
  onBack,
  onSaved,
  onDeleted,
}: {
  /** null = creating a new agent. */
  agent: AgentDto | null;
  members: AccountMember[];
  canEdit: boolean;
  /** The workspace model, shown as the default. */
  workspaceModel: string | null;
  initialTab?: SubTab;
  /** Template to start a new agent from. */
  preset?: AgentPreset | null;
  onBack: () => void;
  onSaved: (agent: AgentDto) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations('Agents.editor');
  const [tab, setTab] = useState<SubTab>(agent ? initialTab : 'setup');
  const [form, setForm] = useState<Form>(() => toForm(agent, agent ? null : preset));
  const [saving, setSaving] = useState(false);
  // The platform's default persona: shown as the placeholders of the optional persona fields (empty = use it).
  const [defaults, setDefaults] = useState<PersonaDefaults | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/ai/persona-defaults')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PersonaDefaults | null) => live && setDefaults(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const [deleting, setDeleting] = useState(false);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const disabled = !canEdit || saving;

  const save = async () => {
    if (!form.name.trim()) return void toast.error(t('nameRequired'));
    setSaving(true);
    try {
      const res = await fetch(agent ? `/api/ai/agents/${agent.id}` : '/api/ai/agents', {
        method: agent ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          model: form.model.trim() || null,
          handoff_agent_id: form.handoff_agent_id || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(data.error ?? t('saveFailed'));
      toast.success(agent ? t('saved') : t('created'));
      onSaved({ ...(agent ?? {}), ...data.agent, source_count: agent?.source_count ?? 0 } as AgentDto);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!agent || !window.confirm(t('confirmDelete', { name: agent.name }))) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/ai/agents/${agent.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(data.error ?? t('deleteFailed'));
      toast.success(t('deleted'));
      onDeleted(agent.id);
    } finally {
      setDeleting(false);
    }
  };

  const toggleChannel = (c: AgentChannel, on: boolean) =>
    set('channels', on ? CHANNELS.filter((x) => x === c || form.channels.includes(x)) : form.channels.filter((x) => x !== c));

  const handoffLabel = form.handoff_agent_id
    ? (members.find((m) => m.user_id === form.handoff_agent_id) ?? null)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <ArrowLeft className="mr-1.5 h-4 w-4" /> {t('allAgents')}
        </Button>
        {agent && !agent.is_default && canEdit && (
          <Button variant="ghost" size="sm" onClick={remove} disabled={deleting} className="text-destructive hover:text-destructive">
            {deleting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
            {t('delete')}
          </Button>
        )}
      </div>

      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        {agent ? agent.name : t('newAgent')}
        {agent?.is_default && (
          <span
            className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
            title={t('defaultHint')}
          >
            {t('default')}
          </span>
        )}
      </h2>

      <Tabs value={tab} onValueChange={(v) => setTab(v as SubTab)}>
        <TabsList>
          <TabsTrigger value="setup">
            <Settings2 className="mr-1.5 h-4 w-4" /> {t('tabSetup')}
          </TabsTrigger>
          <TabsTrigger value="knowledge" disabled={!agent}>
            <BookOpen className="mr-1.5 h-4 w-4" /> {t('tabKnowledge')}
          </TabsTrigger>
          <TabsTrigger value="tools" disabled={!agent}>
            <Blocks className="mr-1.5 h-4 w-4" /> {t('tabTools')}
          </TabsTrigger>
          <TabsTrigger value="playground" disabled={!agent}>
            <Sparkles className="mr-1.5 h-4 w-4" /> {t('tabPlayground')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="setup" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('identity')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ag-name">{t('name')}</Label>
                  <Input id="ag-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={defaults?.name || t('namePlaceholder')} maxLength={80} disabled={disabled} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ag-model">
                    {t('model')} <span className="font-normal text-muted-foreground">{t('optional')}</span>
                  </Label>
                  <Input
                    id="ag-model"
                    value={form.model}
                    onChange={(e) => set('model', e.target.value)}
                    placeholder={workspaceModel ? t('modelDefault', { model: workspaceModel }) : ''}
                    disabled={disabled}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ag-desc">
                  {t('description')} <span className="font-normal text-muted-foreground">{t('optional')}</span>
                </Label>
                <Input id="ag-desc" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder={t('descriptionPlaceholder')} disabled={disabled} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ag-prompt">{t('instructions')}</Label>
                <Textarea
                  id="ag-prompt"
                  value={form.system_prompt}
                  onChange={(e) => set('system_prompt', e.target.value)}
                  placeholder={t('instructionsPlaceholder')}
                  rows={7}
                  disabled={disabled}
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{t('active')}</p>
                </div>
                <Switch checked={form.is_active} onCheckedChange={(v) => set('is_active', v)} disabled={disabled} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('personaTitle')}</CardTitle>
              <p className="text-sm text-muted-foreground">{t('personaDesc')}</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ag-gender">{t('personaGender')}</Label>
                  <Input id="ag-gender" value={form.persona_gender} onChange={(e) => set('persona_gender', e.target.value)} placeholder={defaults?.gender || t('personaGenderPlaceholder')} maxLength={60} disabled={disabled} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ag-tone">{t('personaTone')}</Label>
                  <Input id="ag-tone" value={form.persona_tone} onChange={(e) => set('persona_tone', e.target.value)} placeholder={defaults?.tone || t('personaTonePlaceholder')} maxLength={400} disabled={disabled} />
                </div>
              </div>
              {([
                ['persona_behaviour', 'personaBehaviour', defaults?.behaviour, 'personaBehaviourPlaceholder'],
                ['persona_avoid', 'personaAvoid', defaults?.avoid, 'personaAvoidPlaceholder'],
                ['persona_never', 'personaNever', defaults?.never, 'personaNeverPlaceholder'],
              ] as const).map(([field, label, dflt, fallback]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`ag-${field}`}>{t(label)}</Label>
                  <Textarea id={`ag-${field}`} value={form[field]} onChange={(e) => set(field, e.target.value)} placeholder={dflt || t(fallback)} rows={3} maxLength={1500} disabled={disabled} />
                </div>
              ))}
              <p className="text-xs text-muted-foreground">{t('personaInheritHint')}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('routing')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-4">
                {CHANNELS.map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm text-foreground">
                    <Checkbox checked={form.channels.includes(c)} onCheckedChange={(v) => toggleChannel(c, v === true)} disabled={disabled} />
                    {t(`channel.${c}`)}
                  </label>
                ))}
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="ag-priority">{t('priority')}</Label>
                  <p className="text-xs text-muted-foreground">{t('priorityDesc')}</p>
                </div>
                <Input
                  id="ag-priority"
                  type="number"
                  min={-100}
                  max={100}
                  value={form.priority}
                  onChange={(e) => set('priority', Math.min(100, Math.max(-100, Number(e.target.value) || 0)))}
                  className="w-20"
                  disabled={disabled}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('autoReplyTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{t('autoReply')}</p>
                </div>
                <Switch checked={form.auto_reply_enabled} onCheckedChange={(v) => set('auto_reply_enabled', v)} disabled={disabled} />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="ag-when">{t('replyWhen')}</Label>
                <Select
                  value={form.reply_mode}
                  onValueChange={(v) => v && set('reply_mode', v as 'fallback' | 'always')}
                  disabled={disabled || !form.auto_reply_enabled}
                >
                  <SelectTrigger id="ag-when" className="min-w-56">
                    <SelectValue>{t(`replyWhenOption.${form.reply_mode}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fallback">{t('replyWhenOption.fallback')}</SelectItem>
                    <SelectItem value="always">{t('replyWhenOption.always')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="ag-max">{t('maxReplies')}</Label>
                </div>
                <Input
                  id="ag-max"
                  type="number"
                  min={1}
                  max={20}
                  value={form.auto_reply_max_per_conversation}
                  onChange={(e) => set('auto_reply_max_per_conversation', Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
                  className="w-20"
                  disabled={disabled || !form.auto_reply_enabled}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ag-handoff">{t('handoffTo')}</Label>
                <Select
                  value={form.handoff_agent_id || HANDOFF_QUEUE}
                  onValueChange={(v) => set('handoff_agent_id', !v || v === HANDOFF_QUEUE ? '' : v)}
                  disabled={disabled || !form.auto_reply_enabled}
                >
                  <SelectTrigger id="ag-handoff" className="min-w-56">
                    <SelectValue>{handoffLabel ? memberLabel(handoffLabel) : t('handoffQueue')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={HANDOFF_QUEUE}>{t('handoffQueue')}</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {memberLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {canEdit && (
            <div className="flex justify-end">
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {agent ? t('save') : t('create')}
              </Button>
            </div>
          )}
        </TabsContent>

        {agent && (
          <TabsContent value="knowledge" className="mt-4">
            <AgentKnowledge agent={agent} canEdit={canEdit} onSaved={onSaved} />
          </TabsContent>
        )}

        {agent && (
          <TabsContent value="tools" className="mt-4">
            <AgentTools agent={agent} canEdit={canEdit} onSaved={onSaved} />
          </TabsContent>
        )}

        {agent && (
          <TabsContent value="playground" className="mt-4">
            <AiPlayground agentId={agent.id} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

/** Which library sources the agent may search. */
function AgentKnowledge({
  agent,
  canEdit,
  onSaved,
}: {
  agent: AgentDto;
  canEdit: boolean;
  onSaved: (agent: AgentDto) => void;
}) {
  const t = useTranslations('Agents.editor');
  const [mode, setMode] = useState<KnowledgeMode>(agent.knowledge_mode);
  const [sources, setSources] = useState<SourceDto[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initial, setInitial] = useState<{ mode: KnowledgeMode; ids: string }>({ mode: agent.knowledge_mode, ids: '' });
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [srcRes, agentRes] = await Promise.all([
      fetch('/api/ai/knowledge/sources', { cache: 'no-store' }),
      fetch(`/api/ai/agents/${agent.id}`, { cache: 'no-store' }),
    ]);
    const srcData = await srcRes.json().catch(() => ({}));
    const agentData = await agentRes.json().catch(() => ({}));
    setSources(srcData.sources ?? []);
    const ids: string[] = agentData.agent?.source_ids ?? [];
    setSelected(new Set(ids));
    setInitial({ mode: agentData.agent?.knowledge_mode ?? agent.knowledge_mode, ids: [...ids].sort().join(',') });
    setMode(agentData.agent?.knowledge_mode ?? agent.knowledge_mode);
  }, [agent.id, agent.knowledge_mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = mode !== initial.mode || [...selected].sort().join(',') !== initial.ids;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sources ?? []).filter((s) => !q || s.name.toLowerCase().includes(q));
  }, [sources, query]);

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      const [modeRes, linkRes] = await Promise.all([
        mode !== initial.mode
          ? fetch(`/api/ai/agents/${agent.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ knowledge_mode: mode }),
            })
          : Promise.resolve(null),
        fetch(`/api/ai/agents/${agent.id}/knowledge`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_ids: [...selected] }),
        }),
      ]);
      const bad = [modeRes, linkRes].find((r) => r && !r.ok);
      if (bad) {
        const data = await bad.json().catch(() => ({}));
        return void toast.error(data.error ?? t('saveFailed'));
      }
      toast.success(t('knowledgeSaved'));
      setInitial({ mode, ids: [...selected].sort().join(',') });
      onSaved({ ...agent, knowledge_mode: mode, source_count: selected.size });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('knowledgeTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {(['all', 'selected'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => canEdit && setMode(m)}
              disabled={!canEdit}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                mode === m ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
              )}
            >
              <p className="text-sm font-medium text-foreground">{t(`mode.${m}`)}</p>
              <p className="text-xs text-muted-foreground">{t(`modeDesc.${m}`)}</p>
            </button>
          ))}
        </div>

        {mode === 'selected' && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchSources')} className="pl-8" />
              </div>
              {canEdit && (
                <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                  <Plus className="mr-1.5 h-4 w-4" /> {t('addSource')}
                </Button>
              )}
            </div>
            {sources === null ? (
              <div className="flex justify-center py-6 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : sources.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                {t('libraryEmpty')}
              </p>
            ) : (
              <ul className="max-h-[420px] divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {visible.map((s) => {
                  const Icon = SOURCE_ICON[s.type];
                  return (
                    <li key={s.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/30">
                        <Checkbox checked={selected.has(s.id)} onCheckedChange={(v) => toggle(s.id, v === true)} disabled={!canEdit} />
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{s.name}</span>
                        <StatusPill status={s.status} error={s.error} />
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{t('selectedCount', { count: selected.size })}</p>
          </div>
        )}

        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={save} disabled={!dirty || saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </div>
        )}
      </CardContent>

      <AddSourceDialog
        open={adding}
        onOpenChange={setAdding}
        linkAgentId={agent.id}
        onCreated={(s) => {
          setSources((list) => [s, ...(list ?? [])]);
          // The server linked it; reflect that without a refetch.
          setSelected((prev) => new Set(prev).add(s.id));
          setInitial((i) => ({ ...i, ids: [...new Set([...i.ids.split(',').filter(Boolean), s.id])].sort().join(',') }));
        }}
      />
    </Card>
  );
}
