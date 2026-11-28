import type { Notification } from '@/types';
import type { Translate } from '@/lib/i18n/translate';

/** Notifications about the plan: clicking one opens Billing. */
export function isBillingNotification(type: Notification['type']): boolean {
  return type === 'trial_ending' || type === 'trial_ended' || type === 'plan_archived' || type === 'plan_restored';
}

/** Localize system notifications without rewriting stored text or personal names. */
export function notificationText(
  notification: Pick<Notification, 'type' | 'title' | 'body'>,
  names: { actor?: string | null; contact?: string | null },
  t: Translate
): { title: string; body: string | undefined } {
  // Written by the database in English; shown in the reader's language.
  if (notification.type === 'plan_archived') return { title: t('planArchivedTitle'), body: t('planArchivedBody') };
  if (notification.type === 'plan_restored') return { title: t('planRestoredTitle'), body: t('planRestoredBody') };
  if (notification.type === 'ai_handoff') {
    return { title: t('aiHandoffTitle'), body: notification.body || t('aiHandoffBody', { contact: names.contact || t('unknownContact') }) };
  }
  if (notification.type !== 'conversation_assigned') {
    return { title: notification.title, body: notification.body };
  }
  return {
    title: t('assignedTitle'),
    body: t('assignedBody', {
      actor: names.actor || t('unknownActor'),
      contact: names.contact || t('unknownContact'),
    }),
  };
}
