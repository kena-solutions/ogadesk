'use client';

import { Archive, ArchiveRestore, Bell, Bot, ClipboardList, Hourglass, UserPlus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { getDateLocale } from '@/i18n/date-locale';
import { notificationText } from '@/lib/notifications/notification-text';
import type { Notification } from '@/types';

// Icon per notification type. Only one type exists today
// (conversation_assigned) but this keeps future types a one-line add.
const TYPE_ICON: Record<Notification['type'], typeof Bell> = {
  conversation_assigned: UserPlus,
  form_submission: ClipboardList,
  trial_ending: Hourglass,
  trial_ended: Hourglass,
  plan_archived: Archive,
  plan_restored: ArchiveRestore,
  ai_handoff: Bot,
};

interface Props {
  notification: Notification;
  actorName?: string;
  contactName?: string;
  /** Tighter layout for the header popover. */
  compact?: boolean;
  onClick: (n: Notification) => void;
}

/** One notification row, used by the Notifications page and the header bell. */
export function NotificationItem({ notification: n, actorName, contactName, compact, onClick }: Props) {
  const t = useTranslations('Notifications');
  const dateLocale = getDateLocale(useLocale());
  const Icon = TYPE_ICON[n.type] ?? Bell;
  const isUnread = !n.read_at;
  const copy = notificationText(n, { actor: actorName, contact: contactName }, t);

  return (
    <button
      type="button"
      onClick={() => onClick(n)}
      className={cn(
        'flex w-full items-start gap-3 text-left transition-colors',
        compact
          ? cn('px-3 py-2.5 hover:bg-muted', isUnread && 'bg-primary/5')
          : cn(
              'rounded-xl border p-4',
              isUnread
                ? 'border-primary/30 bg-primary/5 hover:border-primary/50'
                : 'border-border bg-card hover:border-border/70'
            )
      )}
    >
      <div
        className={cn(
          'flex flex-shrink-0 items-center justify-center rounded-lg',
          compact ? 'h-8 w-8' : 'h-10 w-10',
          isUnread ? 'bg-primary/15' : 'bg-muted'
        )}
        aria-hidden
      >
        <Icon className={cn(compact ? 'h-4 w-4' : 'h-5 w-5', isUnread ? 'text-primary' : 'text-muted-foreground')} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-sm font-semibold', isUnread ? 'text-foreground' : 'text-muted-foreground')}>
            {copy.title}
          </span>
          {isUnread && <span aria-label={t('unread')} className="h-2 w-2 flex-shrink-0 rounded-full bg-primary" />}
        </div>
        {copy.body && n.type === 'form_submission' ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {copy.body.split('\n').map((line, i) =>
              i === 0 && line.startsWith('\u201C') ? (
                <p key={i} className="line-clamp-2 italic text-foreground/80">{line}</p>
              ) : (
                <p key={i} className="truncate">{line}</p>
              )
            )}
          </div>
        ) : copy.body ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{copy.body}</p>
        ) : null}
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          {formatDistanceToNow(new Date(n.created_at), { locale: dateLocale, addSuffix: true })}
        </p>
      </div>
    </button>
  );
}
