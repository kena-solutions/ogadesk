'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, BookOpen, Settings2, BarChart3, Lightbulb } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AgentsPanel } from '@/components/agents/agents-panel';
import { KnowledgeLibrary } from '@/components/agents/knowledge-library';
import { AiInsights } from '@/components/agents/ai-insights';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

type Tab = 'agents' | 'knowledge' | 'insights' | 'settings' | 'usage';

export default function AgentsPage() {
  const t = useTranslations('Agents');
  const { accountRole } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const [tab, setTab] = useState<Tab>('agents');
  const [decided, setDecided] = useState(false);
  // An agent (or the new-agent picker) is open: show only its own header.
  const [detailOpen, setDetailOpen] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [workspaceModel, setWorkspaceModel] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/config', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      setConfigured(Boolean(data?.configured));
      setWorkspaceModel(typeof data?.model === 'string' ? data.model : null);
      return Boolean(data?.configured);
    } catch {
      return false;
    }
  }, []);

  // First-time users land on Settings (provider key), returning users on Agents.
  useEffect(() => {
    let cancelled = false;
    void loadConfig().then((ok) => {
      if (cancelled) return;
      setTab(ok ? 'agents' : 'settings');
      setDecided(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadConfig]);

  return (
    <div>
      {decided && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          {!(tab === 'agents' && detailOpen) && (
          <TabsList>
            <TabsTrigger value="agents">
              <Bot className="mr-1.5 h-4 w-4" /> {t('tabAgents')}
            </TabsTrigger>
            <TabsTrigger value="knowledge">
              <BookOpen className="mr-1.5 h-4 w-4" /> {t('tabKnowledge')}
            </TabsTrigger>
            {canViewUsage && (
              <TabsTrigger value="insights">
                <Lightbulb className="mr-1.5 h-4 w-4" /> {t('tabInsights')}
              </TabsTrigger>
            )}
            <TabsTrigger value="settings">
              <Settings2 className="mr-1.5 h-4 w-4" /> {t('tabSettings')}
            </TabsTrigger>
            {canViewUsage && (
              <TabsTrigger value="usage">
                <BarChart3 className="mr-1.5 h-4 w-4" /> {t('tabUsage')}
              </TabsTrigger>
            )}
          </TabsList>
          )}

          <TabsContent value="agents" className={detailOpen ? '' : 'mt-4'}>
            <AgentsPanel
              configured={configured}
              workspaceModel={workspaceModel}
              onGoToSettings={() => setTab('settings')}
              onDetailChange={setDetailOpen}
            />
          </TabsContent>

          <TabsContent value="knowledge" className="mt-4">
            <KnowledgeLibrary />
          </TabsContent>

          {canViewUsage && (
            <TabsContent value="insights" className="mt-4">
              <AiInsights />
            </TabsContent>
          )}

          <TabsContent value="settings" className="mt-4">
            <AiConfig onSaved={() => void loadConfig()} />
          </TabsContent>

          {canViewUsage && (
            <TabsContent value="usage" className="mt-4">
              <AiUsageCard />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
