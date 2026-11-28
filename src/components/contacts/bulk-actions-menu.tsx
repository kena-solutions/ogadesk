'use client';

import { Ban, ChevronDown, CircleCheck, DollarSign, LifeBuoy, Send, Tag, TagsIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { isFeatureEnabled } from '@/lib/features/use-cases';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type BulkAction = 'add-tag' | 'remove-tag' | 'send-template' | 'add-deal' | 'create-ticket' | 'block' | 'unblock';

/** One "Actions" dropdown for the selection bar, so the bar stays a single quiet row. */
export function BulkActionsMenu({
  disabled,
  onAction,
}: {
  disabled?: boolean;
  onAction: (action: BulkAction) => void;
}) {
  const t = useTranslations('Contacts.page.bulk');
  const { useCases } = useAuth();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={<Button variant="outline" size="sm" className="border-border text-foreground" />}
      >
        {t('actions')}
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-popover border-border">
        <DropdownMenuItem onClick={() => onAction('add-tag')}>
          <Tag className="size-4" />
          {t('addTag')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction('remove-tag')}>
          <TagsIcon className="size-4" />
          {t('removeTag')}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-border" />
        {isFeatureEnabled('action.sendTemplate', useCases) && (
          <DropdownMenuItem onClick={() => onAction('send-template')}>
            <Send className="size-4" />
            {t('sendTemplate')}
          </DropdownMenuItem>
        )}
        {isFeatureEnabled('action.createDeal', useCases) && (
          <DropdownMenuItem onClick={() => onAction('add-deal')}>
            <DollarSign className="size-4" />
            {t('addDeal')}
          </DropdownMenuItem>
        )}
        {isFeatureEnabled('action.createTicket', useCases) && (
          <DropdownMenuItem onClick={() => onAction('create-ticket')}>
            <LifeBuoy className="size-4" />
            {t('createTicket')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator className="bg-border" />
        <DropdownMenuItem onClick={() => onAction('block')}>
          <Ban className="size-4" />
          {t('block')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction('unblock')}>
          <CircleCheck className="size-4" />
          {t('unblock')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
