'use client';

import { LimitNudge } from '@/components/billing/limit-nudge';
import { useUrlAction } from '@/hooks/use-url-action';
import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag, CustomField } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { TagPickerList, useCreateTag } from '@/components/tags/tag-picker';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Search,
  Plus,
  Upload,
  Ban,
  Archive,
  PhoneOff,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Filter,
  Tag as TagIcon,
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { useLocale, useTranslations } from 'next-intl';
import {
  contactSearchFilter,
  contactSearchPattern,
} from '@/lib/contacts/search-filter';
import { pageAfterRangeError, pageAfterShrink } from '@/lib/contacts/page-bounds';

import { formatFieldValue } from '@/lib/custom-fields/format';
import { buildContactsCsv } from '@/lib/contacts/export-csv';
import { MediaCell } from '@/components/custom-fields/media-cell';
import { LinkCell, isLinkType } from '@/components/custom-fields/link-cell';
import { ExpandableText } from '@/components/ui/expandable-text';
import { DeleteTagDialog } from '@/components/contacts/delete-tag-dialog';
import { fetchTagUsage, clearTagUsageCache } from '@/lib/contacts/tag-usage';
import {
  clearTableMetaCache,
  fetchColumnValues,
  loadTableMeta,
  parseColumnPrefs,
  peekTableMeta,
  readCached,
  splitSubColumnId,
  subColumnId,
  valueCache,
  type TableColumnMeta,
  type TableMetaByKey,
  type ValuesByContact,
} from '@/lib/contacts/column-cache';
import type { FieldDef } from '@/lib/custom-fields/types';
import { useAuth } from '@/hooks/use-auth';
import { ArrowDown, ArrowUp, ChevronDown, Columns3, Download, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { BulkActionsMenu, type BulkAction } from '@/components/contacts/bulk-actions-menu';
import { BulkTagDialog } from '@/components/contacts/bulk-tag-dialog';
import { BulkBlockDialog } from '@/components/contacts/bulk-block-dialog';
import { BulkDealDialog } from '@/components/contacts/bulk-deal-dialog';
import { BROADCAST_CONTACTS_KEY } from '@/lib/contacts/bulk';
import { FilterBuilder, customKindMap } from '@/components/segments/filter-builder';
import { countRules, normalizeFilter } from '@/lib/segments/validate';
import { EMPTY_FILTER, isGroup, type FilterGroup, type FilterRule, type Segment } from '@/lib/segments/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_KEY = 'wacrm:contacts-page-size';
/** Custom columns shown by default (fields flagged show_in_table), so the table stays scroll-free. */
const DEFAULT_CUSTOM_COLUMNS = 3;
type BuiltinColumn = 'email' | 'company' | 'tags' | 'created';
const BUILTIN_COLUMNS: BuiltinColumn[] = ['email', 'company', 'tags', 'created'];
interface ColumnPrefs {
  hidden: BuiltinColumn[];
  /** Custom field ids the user picked; null = use the defaults. */
  custom: string[] | null;
  /** "<fieldId>:<columnKey>" sub-columns of custom-table reference fields. */
  refCols?: string[];
  showBlocked?: boolean;
  showSource?: boolean;
}

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

function SortButton({
  active,
  onClick,
  children,
}: {
  active: 'asc' | 'desc' | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className="inline-flex max-w-full items-center gap-1 hover:text-foreground">
      <span className="truncate">{children}</span>
      {active === 'asc' && <ArrowUp className="size-3 shrink-0" />}
      {active === 'desc' && <ArrowDown className="size-3 shrink-0" />}
    </button>
  );
}

// `useSearchParams` needs a Suspense boundary (see settings/page.tsx).
export default function ContactsPage() {
  return (
    <Suspense fallback={null}>
      <ContactsPageInner />
    </Suspense>
  );
}

function ContactsPageInner() {
  const searchParams = useSearchParams();
  const t = useTranslations('Contacts.page');
  const locale = useLocale();
  const tGate = useTranslations('GatedButton');
  const supabase = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // Tag filter - contacts shown must have ANY of these tags (OR).
  // Filter rules (tags are just another rule) and the optional saved segment.
  const [filterDraft, setFilterDraft] = useState<FilterGroup>(EMPTY_FILTER);
  const [filter, setFilter] = useState<FilterGroup>(EMPTY_FILTER);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [segmentName, setSegmentName] = useState('');
  const [savingSegment, setSavingSegment] = useState(false);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped - only the loaded rows are selectable)
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [fieldsRefreshKey, setFieldsRefreshKey] = useState(0);
  // One contact's Block / Unblock from the row menu (reuses the bulk dialog).
  const [singleBlock, setSingleBlock] = useState<{ contact: ContactWithTags; mode: 'block' | 'unblock' } | null>(null);
  const [bulkAction, setBulkAction] = useState<'add-tag' | 'remove-tag' | 'add-deal' | 'create-ticket' | 'block' | 'unblock' | null>(null);
  // After a refresh or a bulk action the selection should survive: when this
  // timestamp is in the future the next fetches keep (and prune) the selection.
  const keepSelectionUntil = useRef(0);
  const tableMetaForce = useRef(false);
  const [tagToDelete, setTagToDelete] = useState<Tag | null>(null);
  const [deletingTag, setDeletingTag] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // All tags for display
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});

  // Custom-field columns. Which ones show is a per-browser preference
  // (localStorage); a field's "Show as column" flag provides the default.
  const { accountId, defaultCurrency, accountTimezone } = useAuth();
  const [fieldDefs, setFieldDefs] = useState<CustomField[]>([]);
  const [colPrefs, setColPrefs] = useState<ColumnPrefs>({ hidden: [], custom: null, refCols: [] });
  const [valuesByContact, setValuesByContact] = useState<ValuesByContact>({});
  const [tableMeta, setTableMeta] = useState<TableMetaByKey>({});
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const prefsKey = accountId ? `wacrm:contact-columns:${accountId}` : null;

  // Guards against out-of-order fetch responses: each fetchContacts run
  // claims a sequence number and only the latest is allowed to commit its
  // results. Without this, rapidly toggling tag filters could let a slower
  // earlier request resolve last and render stale rows.
  const fetchSeq = useRef(0);

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap((prev) => (JSON.stringify(prev) === JSON.stringify(map) ? prev : map));
    }
  }, [supabase]);

  // Rules that are finished and point at live fields; unfinished rows in
  // the editor never reach the query.
  const effectiveFilter = useMemo(
    () => normalizeFilter(filter, customKindMap(fieldDefs)),
    [filter, fieldDefs]
  );

  const fetchContacts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // The visible rows are about to change - drop any selection that
    // referred to the old page/search results so the bulk bar can't
    // act on rows the user can no longer see.
    if (Date.now() >= keepSelectionUntil.current) setSelected(new Set());

    const from = page * pageSize;
    const to = from + pageSize - 1;
    const term = search.trim();

    let contactRows: Contact[];
    let count: number;
    let countIsExact = true;

    if (countRules(effectiveFilter) > 0 || sort) {
      // Rules or a custom sort are resolved server-side (typed filters,
      // windowed total count, pagination) so big result sets can't be
      // truncated or overflow an IN clause. See migration 067.
      const { data, error } = await supabase.rpc('filter_contacts', {
        p_filter: effectiveFilter,
        p_search: contactSearchPattern(term),
        p_limit: pageSize,
        p_offset: from,
        p_sort_field: sort?.field ?? null,
        p_sort_dir: sort?.dir ?? 'desc',
      });
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as { contact: Contact; total_count: number }[];
      contactRows = rows.map((r) => r.contact);
      count = rows.length > 0 ? Number(rows[0].total_count) : 0;
      countIsExact = rows.length > 0;
    } else {
      let query = supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      const searchFilter = contactSearchFilter(term, { includeEmail: true });
      if (searchFilter) query = query.or(searchFilter);

      const { data, count: exactCount, error } = await query;
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      const pageInRange = error
        ? pageAfterRangeError(page, pageSize, error)
        : null;
      if (pageInRange !== null && pageInRange !== page) {
        setPage(pageInRange);
        return;
      }
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      contactRows = data ?? [];
      count = exactCount ?? 0;
    }

    setTotalCount(count);

    const boundedPage = pageAfterShrink(page, count, pageSize, countIsExact);
    if (contactRows.length === 0 && boundedPage !== page) {
      setPage(boundedPage);
      return;
    }

    // Keep only selected ids that are still on this page.
    const idsOnPage = new Set(contactRows.map((c) => c.id));
    setSelected((prev) =>
      prev.size === 0 || [...prev].every((id) => idsOnPage.has(id))
        ? prev
        : new Set([...prev].filter((id) => idsOnPage.has(id)))
    );

    if (contactRows.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Fetch tags for these contacts
    const contactIds = contactRows.map((c) => c.id);
    const { data: contactTags } = await supabase
      .from('contact_tags')
      .select('contact_id, tag_id')
      .in('contact_id', contactIds);
    if (seq !== fetchSeq.current) return; // superseded by a newer fetch

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    const enriched: ContactWithTags[] = contactRows.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? [])
        .map((tid) => tagsMap[tid])
        .filter(Boolean),
    }));

    setContacts(enriched);
    setLoading(false);
  }, [supabase, page, pageSize, search, effectiveFilter, sort, tagsMap, t]);

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  // Apply the filter editor's draft to the query after a short pause so
  // typing a value doesn't fire a request per keystroke.
  useEffect(() => {
    if (JSON.stringify(filterDraft) === JSON.stringify(filter)) return;
    const handle = setTimeout(() => setFilter(filterDraft), 350);
    return () => clearTimeout(handle);
  }, [filterDraft, filter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSegments();
    // The default segments are created in the background on first load;
    // pick them up as soon as they exist instead of needing a refresh.
    const onSeeded = () => void loadSegments();
    window.addEventListener('wacrm:defaults-seeded', onSeeded);
    return () => window.removeEventListener('wacrm:defaults-seeded', onSeeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Field definitions for the Columns picker + custom cells.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('custom_fields')
        .select('*')
        .is('table_id', null)
        .is('archived_at', null)
        .order('sort_order')
        .order('field_name');
      if (!cancelled) setFieldDefs((data as CustomField[] | null) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, customFieldsOpen, fieldsRefreshKey]);

  // Load the saved column preference for this account.
  useEffect(() => {
    if (!prefsKey) return;
    try {
      const raw = window.localStorage.getItem(prefsKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setColPrefs(parseColumnPrefs(raw) as ColumnPrefs);
    } catch {
      /* storage unavailable or corrupt: keep defaults */
    }
  }, [prefsKey]);

  const updatePrefs = (next: ColumnPrefs) => {
    setColPrefs(next);
    try {
      if (prefsKey) window.localStorage.setItem(prefsKey, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const visibleCustom = useMemo(() => {
    const live = new Set(fieldDefs.map((f) => f.id));
    if (colPrefs.custom) return fieldDefs.filter((f) => colPrefs.custom!.includes(f.id));
    return fieldDefs.filter((f) => f.show_in_table && live.has(f.id)).slice(0, DEFAULT_CUSTOM_COLUMNS);
  }, [fieldDefs, colPrefs.custom]);

  // Pre-load the columns of every custom table a field points at, as soon as the
  // field definitions are known, so the Columns accordion never waits on a click.
  useEffect(() => {
    if (!accountId) return;
    const keys = fieldDefs
      .filter((f) => f.field_type === 'reference')
      .map((f) => (f.field_options as { table_key?: string } | undefined)?.table_key)
      .filter((k): k is string => !!k);
    if (keys.length === 0) return;
    const instant = peekTableMeta(accountId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (instant) setTableMeta(instant);
    let cancelled = false;
    void loadTableMeta(supabase, accountId, keys, tableMetaForce.current)
      .then((m) => {
        tableMetaForce.current = false;
        if (!cancelled) setTableMeta(m);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [supabase, accountId, fieldDefs]);

  /** Sub-columns picked in the accordion, resolved against live fields and table metadata. */
  const visibleSubCols = useMemo(() => {
    const out: { id: string; field: CustomField; column: TableColumnMeta }[] = [];
    for (const id of colPrefs.refCols ?? []) {
      const parts = splitSubColumnId(id);
      if (!parts) continue;
      const field = fieldDefs.find((f) => f.id === parts.fieldId);
      const meta = field ? tableMeta[(field.field_options as { table_key?: string } | undefined)?.table_key ?? ''] : undefined;
      const column = meta?.columns.find((c) => c.key === parts.columnKey);
      if (field && column) out.push({ id, field, column });
    }
    return out;
  }, [colPrefs.refCols, fieldDefs, tableMeta]);

  /** One ordered list of custom columns: a field, then its picked sub-columns. */
  const customColumns = useMemo(() => {
    const cols: (
      | { id: string; kind: 'field'; field: CustomField }
      | { id: string; kind: 'sub'; field: CustomField; column: TableColumnMeta }
    )[] = [];
    for (const f of fieldDefs) {
      if (visibleCustom.some((v) => v.id === f.id)) cols.push({ id: f.id, kind: 'field', field: f });
      for (const sc of visibleSubCols) {
        if (sc.field.id === f.id) cols.push({ id: sc.id, kind: 'sub', field: f, column: sc.column });
      }
    }
    return cols;
  }, [fieldDefs, visibleCustom, visibleSubCols]);

  // Field ids whose values the table needs (the main columns and every field with a sub-column).
  const neededFieldIds = useMemo(
    () => [...new Set(customColumns.map((c) => c.field.id))],
    [customColumns]
  );
  const neededKey = neededFieldIds.join(',');

  // Custom values for the current page: paint from the cache instantly, then
  // revalidate with ONE round trip (values + referenced row label/data together).
  useEffect(() => {
    if (neededFieldIds.length === 0 || contacts.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValuesByContact({});
      return;
    }
    const ids = contacts.map((c) => c.id);
    setValuesByContact(readCached(valueCache, ids, neededFieldIds));
    let cancelled = false;
    void fetchColumnValues(supabase, ids, neededFieldIds)
      .then((fresh) => {
        if (!cancelled) setValuesByContact(fresh);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, contacts, neededKey]);

  const isShown = (c: BuiltinColumn) => !colPrefs.hidden.includes(c);
  const customCount = customColumns.length;
  // checkbox + name + phone + actions, plus the optional columns
  const colCount = 4 + BUILTIN_COLUMNS.filter(isShown).length + customCount + (colPrefs.showBlocked ? 1 : 0) + (colPrefs.showSource ? 1 : 0);

  // Dashboard "New contact" links here with ?new=1: open the add form once,
  // then drop the param so a refresh doesn't reopen it.
  const wantsNew = searchParams.get('new') === '1';
  useEffect(() => {
    if (!wantsNew || !canEdit) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    openAddForm();
    router.replace('/contacts');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsNew, canEdit]);

  // Command palette "Import contacts" links here with ?import=1.
  useUrlAction('import', () => setImportOpen(true), canEdit);

  // Notifications link here with ?open=<contact id>: show that contact once.
  const openId = searchParams.get('open');
  useEffect(() => {
    if (!openId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    openDetail(openId);
    router.replace('/contacts');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id);

    if (error) {
      toast.error(t('toastFailedDelete'));
    } else {
      toast.success(t('toastDeleted'));
      fetchContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const someOnPageSelected = contacts.some((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);

    const { error } = await supabase.from('contacts').delete().in('id', ids);

    if (error) {
      toast.error(t('toastBulkFailedDelete'));
    } else {
      toast.success(t('toastBulkDeleted', { count: ids.length }));
      setSelected(new Set());
      fetchContacts();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  const totalPages = Math.ceil(totalCount / pageSize);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  // Tag filter helpers. Every change resets to page 0 - the result set
  // shrinks/grows so page N may no longer be valid (mirrors the search box).
  const allTags = Object.values(tagsMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const ruleCount = countRules(effectiveFilter);
  const hasActiveFilters = search.trim().length > 0 || ruleCount > 0;
  const activeSegment = segments.find((sg) => sg.id === activeSegmentId) ?? null;
  const segmentDirty =
    !!activeSegment &&
    JSON.stringify(normalizeFilter(activeSegment.filter, customKindMap(fieldDefs))) !==
      JSON.stringify(effectiveFilter);

  function applyFilter(next: FilterGroup) {
    setFilterDraft(next);
    setPage(0);
  }

  /** Tags ticked in the quick Tags filter = the values of the top-level "tags has any of" rule. */
  const tagFilterIds: string[] = (() => {
    const rule = filterDraft.rules.find(
      (r): r is FilterRule => !isGroup(r) && r.field === 'tags' && r.operator === 'has_any'
    );
    return Array.isArray(rule?.value) ? (rule.value as string[]) : [];
  })();

  function toggleTagFilter(tagId: string) {
    const index = filterDraft.rules.findIndex((r) => !isGroup(r) && r.field === 'tags' && r.operator === 'has_any');
    const current = tagFilterIds.includes(tagId)
      ? tagFilterIds.filter((id) => id !== tagId)
      : [...tagFilterIds, tagId];
    let rules = [...filterDraft.rules];
    if (current.length === 0) {
      rules = rules.filter((_, i) => i !== index);
    } else if (index >= 0) {
      rules[index] = { field: 'tags', operator: 'has_any', value: current };
    } else {
      rules.push({ field: 'tags', operator: 'has_any', value: current });
    }
    applyFilter({ ...filterDraft, rules });
  }

  /** Create a tag from the Tags filter (colour picked from the same palette as Settings). */
  const { create: createTagInline, creating: creatingTag } = useCreateTag(allTags, (tag) =>
    setTagsMap((prev) => ({ ...prev, [tag.id]: tag })),
  );

  async function deleteTagConfirmed() {
    if (!tagToDelete) return;
    setDeletingTag(true);
    const { error } = await supabase.from('tags').delete().eq('id', tagToDelete.id);
    setDeletingTag(false);
    if (error) {
      toast.error(t('tagManage.deleteFailed'));
      return;
    }
    const gone = tagToDelete;
    setTagsMap((prev) => {
      const next = { ...prev };
      delete next[gone.id];
      return next;
    });
    setContacts((prev) => prev.map((c) => ({ ...c, tags: (c.tags ?? []).filter((tg) => tg.id !== gone.id) })));
    // A deleted tag can't stay in the active filter.
    if (tagFilterIds.includes(gone.id)) toggleTagFilter(gone.id);
    clearTagUsageCache();
    toast.success(t('tagManage.deleted', { name: gone.name }));
    setTagToDelete(null);
  }

  function clearTagFilter() {
    applyFilter({
      ...filterDraft,
      rules: filterDraft.rules.filter((r) => isGroup(r) || r.field !== 'tags' || r.operator !== 'has_any'),
    });
  }

  function clearFilters() {
    setFilterDraft(EMPTY_FILTER);
    setFilter(EMPTY_FILTER);
    setActiveSegmentId(null);
    setPage(0);
  }

  function chooseSegment(id: string | null) {
    setActiveSegmentId(id);
    const next = id ? (segments.find((sg) => sg.id === id)?.filter ?? EMPTY_FILTER) : EMPTY_FILTER;
    setFilterDraft(next);
    setFilter(next);
    setPage(0);
  }

  function toggleSort(field: string) {
    setPage(0);
    setSort((prev) => {
      if (!prev || prev.field !== field) return { field, dir: 'asc' };
      if (prev.dir === 'asc') return { field, dir: 'desc' };
      return null;
    });
  }

  /** Download every contact matching the current search + filters, with all custom fields. */
  async function exportCsv() {
    setExporting(true);
    try {
      const PAGE = 1000;
      const all: Contact[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase.rpc('filter_contacts', {
          p_filter: effectiveFilter,
          p_search: contactSearchPattern(search.trim()),
          p_limit: PAGE,
          p_offset: offset,
          p_sort_field: sort?.field ?? null,
          p_sort_dir: sort?.dir ?? 'desc',
        });
        if (error) throw error;
        const rows = (data ?? []) as { contact: Contact }[];
        all.push(...rows.map((r) => r.contact));
        if (rows.length < PAGE) break;
      }

      const tagNamesByContact: Record<string, string[]> = {};
      const valuesByContact: Record<string, Record<string, string>> = {};
      const refLabels: Record<string, string> = {};
      const fieldIdList = fieldDefs.map((f) => f.id);
      const toText = (raw: unknown): string =>
        raw === null || raw === undefined ? '' : Array.isArray(raw) ? (raw.length ? JSON.stringify(raw) : '') : String(raw);
      for (let i = 0; i < all.length; i += 100) {
        const ids = all.slice(i, i + 100).map((c) => c.id);
        const [{ data: ct }, cells] = await Promise.all([
          supabase.from('contact_tags').select('contact_id, tag_id').in('contact_id', ids),
          // one round trip: values plus referenced row label/data
          fetchColumnValues(supabase, ids, fieldIdList),
        ]);
        for (const row of ct ?? []) {
          const name = tagsMap[row.tag_id]?.name;
          if (name) (tagNamesByContact[row.contact_id] ??= []).push(name);
        }
        for (const [contactId, byField] of Object.entries(cells)) {
          for (const [fieldId, cell] of Object.entries(byField)) {
            (valuesByContact[contactId] ??= {})[fieldId] = cell.value;
            if (cell.refLabel !== null) refLabels[cell.value] = cell.refLabel;
          }
          for (const sc of visibleSubCols) {
            const cell = byField[sc.field.id];
            if (cell?.refData) (valuesByContact[contactId] ??= {})[sc.id] = toText(cell.refData[sc.column.key]);
          }
        }
      }

      const csv = buildContactsCsv({
        contacts: all,
        fields: [
          ...fieldDefs.map((f) => ({ id: f.id, field_name: f.field_name, field_type: f.field_type as FieldDef['field_type'] })),
          ...visibleSubCols.map((sc) => ({
            id: sc.id,
            field_name: `${sc.field.field_name}.${sc.column.key}`,
            field_type: sc.column.type as FieldDef['field_type'],
          })),
        ],
        tagNamesByContact,
        valuesByContact,
        referenceLabel: (id) => refLabels[id],
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t('columns.exported', { count: all.length }));
    } catch {
      toast.error(t('columns.exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  // Remembered rows-per-page (per browser).
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if ((PAGE_SIZES as readonly number[]).includes(saved)) setPageSize(saved);
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);

  function changePageSize(next: number) {
    setPageSize(next);
    setPage(0);
    try {
      window.localStorage.setItem(PAGE_SIZE_KEY, String(next));
    } catch {
      /* ignore */
    }
  }

  /** Reload rows, tags, segments and field definitions, keeping the selection. */
  function refresh() {
    keepSelectionUntil.current = Date.now() + 4000;
    if (accountId) clearTableMetaCache(accountId);
    tableMetaForce.current = true;
    setFieldsRefreshKey((k) => k + 1);
    void fetchTags();
    void loadSegments();
    void fetchContacts();
  }

  const selectedContacts = contacts.filter((c) => selected.has(c.id));

  function handleBulkAction(action: BulkAction) {
    if (action === 'send-template') {
      try {
        window.sessionStorage.setItem(BROADCAST_CONTACTS_KEY, JSON.stringify([...selected]));
      } catch {
        toast.error(t('bulk.sendTemplateFailed'));
        return;
      }
      router.push('/broadcasts/new?audience=contacts');
      return;
    }
    setBulkAction(action);
  }

  async function loadSegments() {
    const { data } = await supabase.from('segments').select('*').order('name');
    setSegments((data as Segment[] | null) ?? []);
  }

  async function saveSegment() {
    const name = segmentName.trim();
    if (!name || !accountId) return;
    setSavingSegment(true);
    const { data, error } = await supabase
      .from('segments')
      .insert({ account_id: accountId, name, filter: effectiveFilter })
      .select()
      .single();
    setSavingSegment(false);
    if (error || !data) {
      toast.error(error?.code === '23505' ? t('segments.duplicate', { name }) : t('segments.saveFailed'));
      return;
    }
    toast.success(t('segments.saved', { name }));
    setSegmentName('');
    await loadSegments();
    setActiveSegmentId((data as Segment).id);
  }

  async function updateSegment() {
    if (!activeSegment) return;
    setSavingSegment(true);
    const { error } = await supabase
      .from('segments')
      .update({ filter: effectiveFilter, updated_at: new Date().toISOString() })
      .eq('id', activeSegment.id);
    setSavingSegment(false);
    if (error) {
      toast.error(t('segments.saveFailed'));
      return;
    }
    toast.success(t('segments.updated', { name: activeSegment.name }));
    await loadSegments();
  }

  async function deleteSegment() {
    if (!activeSegment || !window.confirm(t('segments.deleteConfirm', { name: activeSegment.name }))) return;
    const { error } = await supabase.from('segments').delete().eq('id', activeSegment.id);
    if (error) {
      toast.error(t('segments.saveFailed'));
      return;
    }
    toast.success(t('segments.deleted', { name: activeSegment.name }));
    clearFilters();
    await loadSegments();
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            {totalCount > 0 ? t('subtitle', { count: totalCount }) : t('subtitleZero')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEditSettings && (
            <Button
              variant="outline"
              onClick={() => setCustomFieldsOpen(true)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <SlidersHorizontal className="size-4" />
              {t('customFieldsBtn')}
            </Button>
          )}
          <GatedButton
            variant="outline"
            canAct={canEdit}
            gateReason={tGate('reasons.addOrImportContacts')}
            onClick={() => setImportOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <Upload className="size-4" />
            {t('importBtn')}
          </GatedButton>
          <LimitNudge limitKey="contacts" />
          <GatedButton
            canAct={canEdit}
            gateReason={tGate('reasons.addOrImportContacts')}
            onClick={openAddForm}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            {t('addContactBtn')}
          </GatedButton>
        </div>
      </div>

      {/* Search + tag filter */}
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row gap-2">
          {segments.length > 0 && (
            <Select
              value={activeSegmentId ?? '__all__'}
              onValueChange={(v) => chooseSegment(!v || v === '__all__' ? null : v)}
            >
              <SelectTrigger className="h-9 w-full shrink-0 sm:w-44" aria-label={t('segments.label')}>
                <SelectValue>{activeSegment?.name ?? t('segments.all')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t('segments.all')}</SelectItem>
                {segments.map((sg) => (
                  <SelectItem key={sg.id} value={sg.id}>
                    {sg.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                // Reset pagination when the query changes - the result
                // set shrinks/grows, page N may no longer be valid.
                setPage(0);
              }}
              placeholder={t('searchPlaceholder')}
              className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted shrink-0"
                />
              }
            >
              <TagIcon className="size-4" />
              {t('tagsButton')}
              {tagFilterIds.length > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {tagFilterIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-sm font-medium text-popover-foreground">{t('filterByTags')}</span>
                {tagFilterIds.length > 0 && (
                  <button onClick={clearTagFilter} className="text-xs text-muted-foreground hover:text-foreground">
                    {t('clearAll')}
                  </button>
                )}
              </div>
              <TagPickerList
                tags={allTags}
                selectedIds={tagFilterIds}
                onToggle={(tag) => toggleTagFilter(tag.id)}
                onCreate={createTagInline}
                creating={creatingTag}
                canCreate={canEditSettings}
                onDelete={setTagToDelete}
                // Warm the "what uses this tag" answer so the confirmation opens ready.
                onWarmDelete={(tag) => void fetchTagUsage(tag.id).catch(() => undefined)}
              />
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted shrink-0"
                />
              }
            >
              <Filter className="size-4" />
              {t('filter.button')}
              {ruleCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {ruleCount}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(34rem,92vw)] p-3">
              <FilterBuilder
                value={filterDraft}
                onChange={applyFilter}
                customFields={fieldDefs}
                tags={allTags}
              />
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <span className="mr-auto text-xs text-muted-foreground">
                  {t('filter.matches', { count: totalCount })}
                </span>
                {ruleCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 text-xs">
                    {t('filter.clear')}
                  </Button>
                )}
                {activeSegment ? (
                  segmentDirty && (
                    <Button size="sm" onClick={updateSegment} disabled={savingSegment} className="h-7 text-xs">
                      {t('segments.update')}
                    </Button>
                  )
                ) : (
                  ruleCount > 0 && (
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={segmentName}
                        onChange={(e) => setSegmentName(e.target.value)}
                        placeholder={t('segments.namePlaceholder')}
                        className="h-7 w-36 bg-muted text-xs"
                      />
                      <Button
                        size="sm"
                        onClick={saveSegment}
                        disabled={savingSegment || !segmentName.trim() || !canEdit}
                        className="h-7 text-xs"
                      >
                        {t('segments.save')}
                      </Button>
                    </div>
                  )
                )}
              </div>
            </PopoverContent>
          </Popover>

          {/* Columns: icon-only, so the toolbar stays a single quiet row */}
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className="border-border text-muted-foreground hover:bg-muted shrink-0"
                  aria-label={t('columns.title')}
                  title={t('columns.title')}
                />
              }
            >
              <Columns3 className="size-4" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-0">
              <div className="border-b border-border px-3 py-2 text-sm font-medium text-popover-foreground">
                {t('columns.title')}
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {BUILTIN_COLUMNS.map((c) => (
                  <label key={c} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted">
                    <Checkbox
                      checked={isShown(c)}
                      onCheckedChange={(on) =>
                        updatePrefs({
                          ...colPrefs,
                          hidden: on ? colPrefs.hidden.filter((h) => h !== c) : [...colPrefs.hidden, c],
                        })
                      }
                    />
                    {t(`tableColumns.${c === 'created' ? 'createdAt' : c}`)}
                  </label>
                ))}
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted">
                  <Checkbox
                    checked={Boolean(colPrefs.showBlocked)}
                    onCheckedChange={(on) => updatePrefs({ ...colPrefs, showBlocked: Boolean(on) })}
                  />
                  {t('tableColumns.blocked')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted">
                  <Checkbox
                    checked={Boolean(colPrefs.showSource)}
                    onCheckedChange={(on) => updatePrefs({ ...colPrefs, showSource: Boolean(on) })}
                  />
                  {t('tableColumns.source')}
                </label>
                {fieldDefs.length > 0 && (
                  <div className="mt-1 border-t border-border px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('columns.customFields')}
                  </div>
                )}
                {fieldDefs.map((f) => {
                  const on = visibleCustom.some((v) => v.id === f.id);
                  const tableKey = f.field_type === 'reference' ? (f.field_options as { table_key?: string } | undefined)?.table_key : undefined;
                  const meta = tableKey ? tableMeta[tableKey] : undefined;
                  const open = expandedFields.has(f.id);
                  const pickedHere = (colPrefs.refCols ?? []).filter((id) => id.startsWith(`${f.id}:`)).length;
                  return (
                    <div key={f.id}>
                      <div className="flex items-center hover:bg-muted">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1.5 text-sm">
                          <Checkbox
                            checked={on}
                            onCheckedChange={(checked) => {
                              const current = visibleCustom.map((v) => v.id);
                              updatePrefs({
                                ...colPrefs,
                                custom: checked ? [...current, f.id] : current.filter((id) => id !== f.id),
                              });
                            }}
                          />
                          <span className="truncate">{f.field_name}</span>
                          {tableKey && (
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {t('columns.tableBadge')}
                            </span>
                          )}
                        </label>
                        {tableKey && (
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-label={t('columns.expandTable', { name: f.field_name })}
                            onClick={() =>
                              setExpandedFields((prev) => {
                                const next = new Set(prev);
                                if (next.has(f.id)) next.delete(f.id);
                                else next.add(f.id);
                                return next;
                              })
                            }
                            className="mr-1 flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:text-foreground"
                          >
                            {pickedHere > 0 && (
                              <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                                {pickedHere}
                              </span>
                            )}
                            <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
                          </button>
                        )}
                      </div>
                      {tableKey && open && (
                        <div className="border-l border-border bg-muted/30 py-1 pl-6">
                          {!meta ? (
                            <p className="px-3 py-1.5 text-xs text-muted-foreground">{t('columns.loadingTable')}</p>
                          ) : (
                            meta.columns
                              .filter((c) => c.type !== 'reference')
                              .map((c) => {
                                const id = subColumnId(f.id, c.key);
                                const picked = (colPrefs.refCols ?? []).includes(id);
                                return (
                                  <label key={c.key} className="flex cursor-pointer items-center gap-2 px-3 py-1 text-sm hover:bg-muted">
                                    <Checkbox
                                      checked={picked}
                                      onCheckedChange={(checked) => {
                                        const current = colPrefs.refCols ?? [];
                                        updatePrefs({
                                          ...colPrefs,
                                          refCols: checked ? [...current, id] : current.filter((x) => x !== id),
                                        });
                                      }}
                                    />
                                    <span className="truncate">{c.name}</span>
                                    {c.key === meta.labelKey && (
                                      <span className="shrink-0 text-[10px] text-muted-foreground">{t('columns.labelColumn')}</span>
                                    )}
                                  </label>
                                );
                              })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-border p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={exportCsv}
                  disabled={exporting || totalCount === 0}
                  className="h-8 w-full justify-start gap-2 text-xs"
                >
                  {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  {t('columns.export')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <Button
            variant="outline"
            size="icon"
            onClick={refresh}
            disabled={loading}
            className="border-border text-muted-foreground hover:bg-muted shrink-0"
            aria-label={t('refresh')}
            title={t('refresh')}
          >
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {activeSegment && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t('segments.viewing', { name: activeSegment.name })}</span>
            {!activeSegment.locked && (
              <button onClick={deleteSegment} className="hover:text-red-400">
                {t('segments.delete')}
              </button>
            )}
            <button onClick={clearFilters} className="hover:text-foreground">
              {t('filter.clear')}
            </button>
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-2">
          <p className="text-sm text-foreground">
            {t('selectedCount', { count: selected.size })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('clearSelection')}
            </Button>
            {canEdit && <BulkActionsMenu onAction={handleBulkAction} />}
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canEdit}
              gateReason={tGate('reasons.deleteContacts')}
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              {t('deleteSelected')}
            </GatedButton>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={contacts.length === 0}
                  aria-label={t('selectAllOnPage')}
                />
              </TableHead>
              <TableHead className="text-muted-foreground">
                <SortButton active={sort?.field === 'name' ? sort.dir : null} onClick={() => toggleSort('name')}>
                  {t('tableColumns.name')}
                </SortButton>
              </TableHead>
              <TableHead className="text-muted-foreground">{t('tableColumns.phone')}</TableHead>
              {isShown('email') && <TableHead className="text-muted-foreground hidden md:table-cell">{t('tableColumns.email')}</TableHead>}
              {isShown('company') && <TableHead className={`text-muted-foreground hidden ${customCount > 0 ? 'xl:table-cell' : 'lg:table-cell'}`}>{t('tableColumns.company')}</TableHead>}
              {isShown('tags') && <TableHead className="text-muted-foreground hidden md:table-cell">{t('tableColumns.tags')}</TableHead>}
              {customColumns.map((col) =>
                col.kind === 'field' ? (
                  <TableHead key={col.id} title={col.field.field_name} className="text-muted-foreground max-w-[130px] truncate px-2">
                    <SortButton active={sort?.field === `cf:${col.field.id}` ? sort.dir : null} onClick={() => toggleSort(`cf:${col.field.id}`)}>
                      {col.field.field_name}
                    </SortButton>
                  </TableHead>
                ) : (
                  <TableHead
                    key={col.id}
                    title={`${col.field.field_name} › ${col.column.name}`}
                    className="text-muted-foreground max-w-[130px] truncate px-2"
                  >
                    {col.field.field_name} <span className="text-muted-foreground/70">› {col.column.name}</span>
                  </TableHead>
                )
              )}
              {colPrefs.showSource && <TableHead className="text-muted-foreground">{t('tableColumns.source')}</TableHead>}
              {colPrefs.showBlocked && <TableHead className="text-muted-foreground">{t('tableColumns.blocked')}</TableHead>}
              {isShown('created') && <TableHead className={`text-muted-foreground hidden ${customCount > 0 ? 'xl:table-cell' : 'lg:table-cell'}`}>{t('tableColumns.createdAt')}</TableHead>}
              <TableHead className="text-muted-foreground w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={colCount} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={colCount} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters
                        ? t('noContactsMatch')
                        : t('noContactsYet')}
                    </p>
                    {!hasActiveFilters && (
                      <GatedButton
                        canAct={canEdit}
                        gateReason={tGate('reasons.addOrImportContacts')}
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t('addFirstContact')}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="border-border hover:bg-muted/50 cursor-pointer"
                  onClick={() => openDetail(contact.id)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                      aria-label={t('selectContact', { name: contact.name || contact.phone })}
                    />
                  </TableCell>
                  <TableCell className="text-foreground font-medium">
                    <div className="flex items-center gap-1.5">
                      {contact.name ? (
                        <ExpandableText text={contact.name} className="min-w-0 max-w-[160px]" />
                      ) : (
                        <span className="text-muted-foreground italic">{t('unnamed')}</span>
                      )}
                      {contact.blocked_at && (
                        <Ban className="size-3.5 shrink-0 text-destructive" aria-label={t('blockedBadge')} />
                      )}
                      {contact.plan_archived_at && (
                        <Archive className="text-muted-foreground size-3.5 shrink-0" aria-label={t('planArchivedBadge')}>
                          <title>{t('planArchivedHint')}</title>
                        </Archive>
                      )}
                      {contact.wa_status === 'unreachable' && (
                        <PhoneOff className="size-3.5 shrink-0 text-amber-600" aria-label={t('unreachableBadge')}>
                          <title>{t('unreachableHint')}</title>
                        </PhoneOff>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    <ExpandableText text={contact.phone} className="max-w-[150px]" />
                  </TableCell>
                  {isShown('email') && (
                    <TableCell className="text-muted-foreground hidden md:table-cell text-sm">
                      {contact.email ? (
                        <ExpandableText text={contact.email} className="max-w-[180px]" />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  )}
                  {isShown('company') && (
                    <TableCell className={`text-muted-foreground hidden text-sm ${customCount > 0 ? 'xl:table-cell' : 'lg:table-cell'}`}>
                      {contact.company ? (
                        <ExpandableText text={contact.company} className="max-w-[140px]" />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  )}
                  {isShown('tags') && (
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {contact.tags && contact.tags.length > 0 ? (
                        contact.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{ backgroundColor: tag.color + '20', color: tag.color }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-xs">-</span>
                      )}
                      {contact.tags && contact.tags.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">+{contact.tags.length - 3}</span>
                      )}
                    </div>
                  </TableCell>
                  )}
                  {customColumns.map((col) => {
                    const cell = valuesByContact[contact.id]?.[col.field.id];
                    // A field shows its own value; a sub-column reads the referenced row's data.
                    const subRaw =
                      col.kind === 'sub' ? cell?.refData?.[col.column.key] : undefined;
                    const raw =
                      col.kind === 'field'
                        ? (cell?.value ?? '')
                        : subRaw === null || subRaw === undefined
                          ? ''
                          : Array.isArray(subRaw)
                            ? subRaw.length
                              ? JSON.stringify(subRaw)
                              : ''
                            : String(subRaw);
                    const type = col.kind === 'field' ? col.field.field_type : col.column.type;
                    const def =
                      col.kind === 'field'
                        ? (col.field as FieldDef)
                        : ({
                            id: col.id,
                            key: col.column.key,
                            field_name: col.column.name,
                            field_type: col.column.type,
                            field_options: col.column.options,
                          } as FieldDef);
                    const text = formatFieldValue(def, raw, {
                      defaultCurrency,
                      timeZone: accountTimezone,
                      resolveReference: () => cell?.refLabel ?? undefined,
                      yes: t('yes'),
                      no: t('no'),
                    });
                    return (
                      <TableCell
                        key={col.id}
                        className="text-muted-foreground px-2 text-sm"
                      >
                        {type === 'media' ? (
                          <MediaCell value={raw} />
                        ) : isLinkType(type) ? (
                          <LinkCell type={type} value={raw} />
                        ) : (
                          text ? <ExpandableText text={text} className="max-w-[130px]" /> : <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    );
                  })}
                  {colPrefs.showSource && (
                    <TableCell className="text-muted-foreground text-sm">
                      {contact.lead_source ? (
                        <ExpandableText text={contact.lead_source} className="max-w-[140px]" />
                      ) : (
                        <span>-</span>
                      )}
                    </TableCell>
                  )}
                  {colPrefs.showBlocked && (
                    <TableCell className="text-sm">
                      {contact.blocked_at ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive" title={contact.blocked_reason ? t(`blockedReason.${contact.blocked_reason}`) : undefined}>
                          <Ban className="size-3" />
                          {t('blockedBadge')}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  )}
                  {isShown('created') && (
                  <TableCell className={`text-muted-foreground text-xs hidden ${customCount > 0 ? 'xl:table-cell' : 'lg:table-cell'}`}>
                    {new Date(contact.created_at).toLocaleDateString(locale, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </TableCell>
                  )}
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="bg-popover border-border"
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <Pencil className="size-4" />
                          {t('editAction')}
                        </DropdownMenuItem>
                        {canEdit && (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setSingleBlock({ contact, mode: contact.blocked_at ? 'unblock' : 'block' });
                            }}
                            className="text-popover-foreground focus:bg-muted focus:text-foreground"
                          >
                            <Ban className="size-4" />
                            {contact.blocked_at ? t('bulk.unblock') : t('bulk.block')}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          {t('deleteAction')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination + rows per page */}
      {totalCount > PAGE_SIZES[0] && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-muted-foreground">
              {t('showingPagination', {
                start: page * pageSize + 1,
                end: Math.min((page + 1) * pageSize, totalCount),
                total: totalCount
              })}
            </p>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t('rowsPerPage')}
              <select
                value={pageSize}
                onChange={(e) => changePageSize(Number(e.target.value))}
                className="h-7 rounded-md border border-border bg-card px-1.5 text-xs text-foreground outline-none focus:border-primary"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                disabled={!hasPrev}
                onClick={() => setPage((p) => p - 1)}
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-xs text-muted-foreground px-2">
                {t('pageCount', { page: page + 1, total: totalPages })}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={!hasNext}
                onClick={() => setPage((p) => p + 1)}
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {tagToDelete && (
        <DeleteTagDialog
          tag={tagToDelete}
          busy={deletingTag}
          onCancel={() => setTagToDelete(null)}
          onConfirm={() => void deleteTagConfirmed()}
        />
      )}

      {/* Bulk dialogs */}
      {(bulkAction === 'add-tag' || bulkAction === 'remove-tag') && (
        <BulkTagDialog
          mode={bulkAction === 'add-tag' ? 'add' : 'remove'}
          contacts={selectedContacts}
          tags={allTags}
          onClose={() => setBulkAction(null)}
          onDone={() => {
            keepSelectionUntil.current = Date.now() + 4000;
            void fetchContacts();
          }}
        />
      )}
      {(bulkAction === 'block' || bulkAction === 'unblock') && (
        <BulkBlockDialog
          mode={bulkAction}
          contacts={selectedContacts}
          onClose={() => setBulkAction(null)}
          onDone={() => {
            keepSelectionUntil.current = Date.now() + 4000;
            void fetchContacts();
          }}
        />
      )}
      {singleBlock && (
        <BulkBlockDialog
          mode={singleBlock.mode}
          contacts={[singleBlock.contact]}
          onClose={() => setSingleBlock(null)}
          onDone={() => {
            keepSelectionUntil.current = Date.now() + 4000;
            void fetchContacts();
          }}
        />
      )}
      {bulkAction === 'add-deal' && (
        <BulkDealDialog kind="sales" contacts={selectedContacts} onClose={() => setBulkAction(null)} onDone={() => undefined} />
      )}
      {bulkAction === 'create-ticket' && (
        <BulkDealDialog kind="support" contacts={selectedContacts} onClose={() => setBulkAction(null)} onDone={() => undefined} />
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchContacts}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={setCustomFieldsOpen}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteContactTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteContactDesc', { name: deleteTarget?.name || deleteTarget?.phone || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteBulkTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteBulkDesc', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
