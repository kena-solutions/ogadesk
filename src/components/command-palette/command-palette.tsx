'use client';

// ============================================================
// CommandPalette - app-wide search, opened with Cmd+K (Mac) or Ctrl+K
// (Windows/Linux). Desktop only (lg and up); phones and tablets keep
// using the sidebar.
//
// Empty query: Quick actions + Jump to. With a query: ranked pages and
// settings tabs (with a "Settings / Members" breadcrumb), quick actions,
// and matching contacts and forms from this workspace.
// What it can open lives in lib/command-registry.ts + lib/nav.ts.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft, ClipboardList, CornerDownLeft, Plus, Search, User, type LucideIcon } from 'lucide-react';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { isFeatureEnabled } from '@/lib/features/use-cases';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { contactSearchFilter } from '@/lib/contacts/search-filter';
import { bottomNavItems, navItems } from '@/lib/nav';
import {
  EXTRA_PAGES,
  QUICK_ACTIONS,
  SETTINGS_KEYWORDS,
  scoreMatch,
} from '@/lib/command-registry';
import {
  SECTION_META,
  SETTINGS_SECTIONS,
} from '@/components/settings/settings-sections';

/** Header button and the keyboard shortcut both go through this event. */
export const OPEN_COMMAND_PALETTE_EVENT = 'wacrm:open-command-palette';

const DESKTOP_QUERY = '(min-width: 1024px)';
const MAX_RESULTS = 30;
const RECORD_DEBOUNCE_MS = 200;

type Group = 'actions' | 'workspaces' | 'pages' | 'records';

/** Opens the sidebar's "New workspace" dialog (the workspace switcher listens for it). */
export const NEW_WORKSPACE_EVENT = 'ogadesk:new-workspace';

interface Entry {
  id: string;
  group: Group;
  label: string;
  breadcrumb?: string;
  keywords?: string;
  icon: LucideIcon;
  href: string;
  /** Instead of navigating (switching workspace is an RPC plus a full reload). */
  run?: () => void;
}

interface RecordHit {
  id: string;
  label: string;
  breadcrumb: string;
  icon: LucideIcon;
  href: string;
}

export function CommandPalette() {
  const t = useTranslations('CommandPalette');
  const tNav = useTranslations('Sidebar');
  const tSettings = useTranslations('Settings');
  const router = useRouter();
  const { accountId, user, useCases } = useAuth();
  // The workspaces this person belongs to (their own memberships), loaded when the palette opens.
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; role: string }[]>([]);
  const canSend = useCan('send-messages');
  const canForms = useCan('manage-forms');
  const canMembers = useCan('manage-members');
  const canSettings = useCan('edit-settings');

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<RecordHit[]>([]);
  const listRef = useRef<HTMLUListElement>(null);
  const requestRef = useRef(0);

  // Cmd+K / Ctrl+K toggles; the header button dispatches an event instead.
  useEffect(() => {
    const isDesktop = () => window.matchMedia(DESKTOP_QUERY).matches;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'k') return;
      if (!isDesktop()) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    const onOpen = () => {
      if (isDesktop()) setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    };
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
      setActive(0);
      setRecords([]);
    }
  }, []);

  const can = useMemo(
    () => ({
      'send-messages': canSend,
      'manage-forms': canForms,
      'manage-members': canMembers,
      'edit-settings': canSettings,
    }) as Record<string, boolean>,
    [canSend, canForms, canMembers, canSettings],
  );

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const a of QUICK_ACTIONS) {
      if (a.can && !can[a.can]) continue;
      out.push({
        id: `action:${a.id}`,
        group: 'actions',
        label: t(`actions.${a.labelKey}`),
        keywords: a.keywords,
        icon: a.icon,
        href: a.href,
      });
    }
    for (const n of [...navItems, ...bottomNavItems].filter((i) => isFeatureEnabled(i.feature, useCases))) {
      out.push({ id: `page:${n.href}`, group: 'pages', label: tNav(n.labelKey), icon: n.icon, href: n.href });
    }
    for (const p of EXTRA_PAGES) {
      out.push({ id: `page:${p.href}`, group: 'pages', label: t(`pages.${p.labelKey}`), keywords: p.keywords, icon: p.icon, href: p.href });
    }
    for (const s of SETTINGS_SECTIONS) {
      if (s === 'overview' || s === 'integrations') continue; // Integrations has its own page now
      const meta = SECTION_META[s];
      out.push({
        id: `settings:${s}`,
        group: 'pages',
        label: tSettings(`sections.${s}`),
        breadcrumb: tNav('settings'),
        keywords: SETTINGS_KEYWORDS[s],
        icon: meta.icon,
        href: `/settings?tab=${s}`,
      });
    }
    for (const w of workspaces) {
      if (w.id === accountId) continue;
      out.push({
        id: `workspace:${w.id}`,
        group: 'workspaces',
        label: t('workspaces.switchTo', { name: w.name }),
        breadcrumb: tNav(`role${w.role.charAt(0).toUpperCase()}${w.role.slice(1)}`),
        keywords: `workspace switch ${w.name}`,
        icon: ArrowRightLeft,
        href: '/dashboard',
        run: () => {
          void createClient()
            .rpc('switch_account', { p_account: w.id })
            .then(({ error }) => {
              // Full load: auth context, RLS-scoped queries and realtime all re-read the new workspace.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a hard reload is required here
              if (!error) window.location.assign('/dashboard');
            });
        },
      });
    }
    out.push({
      id: 'workspace:new',
      group: 'workspaces',
      label: t('workspaces.new'),
      keywords: 'workspace create add new business',
      icon: Plus,
      href: '/dashboard',
      run: () => window.dispatchEvent(new Event(NEW_WORKSPACE_EVENT)),
    });
    return out;
  }, [t, tNav, tSettings, can, workspaces, accountId, useCases]);

  useEffect(() => {
    if (!open || !user?.id) return;
    let live = true;
    void createClient()
      .from('account_members')
      .select('account_id, account_role, accounts(name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!live) return;
        setWorkspaces(
          ((data ?? []) as { account_id: string; account_role: string; accounts: { name?: string } | { name?: string }[] | null }[]).map((r) => ({
            id: r.account_id,
            role: r.account_role,
            name: (Array.isArray(r.accounts) ? r.accounts[0]?.name : r.accounts?.name) ?? '',
          })),
        );
      });
    return () => {
      live = false;
    };
  }, [open, user?.id]);

  // Matching contacts and forms (RLS scopes them to this workspace).
  useEffect(() => {
    const term = query.trim();
    const mine = ++requestRef.current;
    if (!open || term.length < 2 || !accountId) {
      // Stale hits must not linger once the query is cleared.
      const clear = setTimeout(() => setRecords([]), 0);
      return () => clearTimeout(clear);
    }
    const timer = setTimeout(async () => {
      const supabase = createClient();
      const filter = contactSearchFilter(term, { includeEmail: true });
      const safe = term.replace(/[%,()*]/g, ' ').trim();
      const [contacts, forms] = await Promise.all([
        filter
          ? supabase.from('contacts').select('id, name, phone').eq('account_id', accountId).or(filter).limit(5)
          : Promise.resolve({ data: [] }),
        safe
          ? supabase.from('forms').select('id, name').eq('account_id', accountId).is('archived_at', null).ilike('name', `%${safe}%`).limit(5)
          : Promise.resolve({ data: [] }),
      ]).catch(() => [{ data: [] }, { data: [] }] as const);
      if (mine !== requestRef.current) return; // a newer keystroke superseded this one
      const hits: RecordHit[] = [];
      for (const c of (contacts.data ?? []) as { id: string; name: string | null; phone: string | null }[]) {
        hits.push({ id: `contact:${c.id}`, label: c.name || c.phone || '', breadcrumb: tNav('contacts'), icon: User, href: `/contacts?open=${c.id}` });
      }
      for (const f of (forms.data ?? []) as { id: string; name: string }[]) {
        hits.push({ id: `form:${f.id}`, label: f.name, breadcrumb: tNav('forms'), icon: ClipboardList, href: `/forms/${f.id}` });
      }
      setRecords(hits);
    }, RECORD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open, accountId, tNav]);

  const term = query.trim();
  const results = useMemo<(Entry | (RecordHit & { group: Group }))[]>(() => {
    if (!term) {
      // Landing view: actions first, then every page.
      return [
        ...entries.filter((e) => e.group === 'actions'),
        ...entries.filter((e) => e.group === 'workspaces'),
        ...entries.filter((e) => e.group === 'pages' && !e.breadcrumb),
      ];
    }
    const ranked = entries
      .map((e, i) => ({ e, i, s: scoreMatch(term, e) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.e)
      .slice(0, MAX_RESULTS);
    return [...ranked, ...records.map((r) => ({ ...r, group: 'records' as Group }))];
  }, [term, entries, records]);

  // Keep the highlighted row valid and in view.
  const activeIndex = Math.min(active, Math.max(results.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, results]);

  const go = useCallback(
    (hit: { href: string; run?: () => void }) => {
      handleOpenChange(false);
      if (hit.run) hit.run();
      else router.push(hit.href);
    },
    [handleOpenChange, router],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(results.length ? (activeIndex + 1) % results.length : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(results.length ? (activeIndex - 1 + results.length) % results.length : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[activeIndex];
      if (hit) go(hit);
    }
  }

  const sectionLabel = (g: Group) => t(g === 'actions' ? 'quickActions' : g === 'records' ? 'records' : g === 'workspaces' ? 'workspaces.title' : 'jumpTo');

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">{t('title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('description')}</DialogDescription>

        <div className="flex items-center gap-3 border-b px-4">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            role="combobox"
            aria-expanded
            aria-controls="command-palette-list"
            aria-activedescendant={results[activeIndex] ? `cp-${activeIndex}` : undefined}
            className="placeholder:text-muted-foreground h-12 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <kbd className="text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]">Esc</kbd>
        </div>

        <ul id="command-palette-list" role="listbox" ref={listRef} className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
          {results.length === 0 ? (
            <li className="text-muted-foreground px-3 py-8 text-center text-sm">{t('noResults', { query: term })}</li>
          ) : (
            results.map((r, i) => {
              const showHeader = term
                ? r.group === 'records' && results[i - 1]?.group !== 'records'
                : i === 0 || results[i - 1].group !== r.group;
              const Icon = r.icon;
              const selected = i === activeIndex;
              return (
                <li key={r.id} role="presentation">
                  {showHeader ? (
                    <div className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium">{sectionLabel(r.group)}</div>
                  ) : null}
                  <div
                    id={`cp-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => setActive(i)}
                    onClick={() => go(r)}
                    className={cn('flex cursor-pointer items-center gap-3 rounded-md px-3 py-2', selected && 'bg-muted')}
                  >
                    <Icon className="text-muted-foreground size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm">{r.label}</span>
                      {term && r.breadcrumb ? <span className="text-muted-foreground block truncate text-xs">{r.breadcrumb}</span> : null}
                    </span>
                    {selected ? <CornerDownLeft className="text-muted-foreground size-3.5 shrink-0" /> : null}
                  </div>
                </li>
              );
            })
          )}
        </ul>

        <div className="text-muted-foreground flex items-center gap-4 border-t px-4 py-2 text-[11px]">
          <span>↑↓ {t('hintNavigate')}</span>
          <span>↵ {t('hintOpen')}</span>
          <span>Esc {t('hintClose')}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
