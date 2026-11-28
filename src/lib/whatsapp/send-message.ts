// ============================================================
// Outbound message send - the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route -
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import { isBlocked } from '@/lib/contacts/block-guard';
import { AccountSuspendedError, assertAccountNotSuspended } from '@/lib/auth/suspension';
import { channelOf } from '@/lib/channels/registry';
import { ChannelSendError, sendWebChatMessage } from '@/lib/channels/dispatch';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import {
  AmbiguousConnectionError,
  resolveWhatsAppConfig,
  resolveWhatsAppCredentialsAsync,
} from '@/lib/whatsapp/resolve-config';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { pauseAiForHumanReply } from '@/lib/ai/pause';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { applyPendingMessageStatuses } from '@/lib/whatsapp/message-status-sync';
import type { MessageTemplate } from '@/types';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
  templateHeaderMediaUrl,
} from '@/lib/whatsapp/template-body';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
  senderId?: string | null;
  /**
   * Send through this specific connection (a `whatsapp_config.id`) instead of
   * the conversation's own. Required on accounts with several numbers when the
   * conversation isn't already tied to one.
   */
  whatsappConfigId?: string | null;
  /**
   * OTP mode: the verification code is never persisted (the stored body shows
   * ••••••), `contacts.phone` is not auto-corrected from a retry variant, and
   * active flow runs are left alone.
   */
  otp?: boolean;
  /**
   * A person in the dashboard is replying: also pause the AI for this chat (its "Resume AI" banner turns it back
   * on). Off for API integrations, broadcasts and system sends.
   */
  pauseAi?: boolean;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message ('' on channels without one). */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) - every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation - otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const {
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  } = params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  // Interactive: validate the full structured payload against Meta's
  // limits up front so a bad payload 400s before we touch Meta.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  try {
    await assertAccountNotSuspended(db, accountId);
  } catch (e) {
    if (e instanceof AccountSuspendedError) throw new SendMessageError('account_suspended', e.message, 403);
    throw e;
  }
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    senderId,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
    whatsappConfigId,
    otp,
    pauseAi,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;

  // Blocked contacts never receive a message, whatever the entry point
  // (inbox, API, MCP, OTP).
  if (isBlocked(contact)) {
    throw new SendMessageError(
      'contact_blocked',
      'This contact is blocked. Unblock them to send messages.',
      403
    );
  }

  // This path talks to Meta. Other channels have their own sender
  // (src/lib/channels/dispatch.ts); never fall through to the contact's phone.
  const channel = channelOf(conversation);
  if (channel === 'web_chat') {
    try {
      const sent = await sendWebChatMessage(db, accountId, conversationId, {
        messageType,
        contentText,
        mediaUrl,
        interactivePayload,
        senderId,
      });
      return { messageId: sent.messageId, whatsappMessageId: '' };
    } catch (err) {
      if (err instanceof ChannelSendError) {
        throw new SendMessageError(err.code, err.message, err.status);
      }
      throw err;
    }
  }
  if (channel !== 'whatsapp') {
    throw new SendMessageError(
      'channel_not_supported',
      'Sending is not available on this conversation\'s channel yet.',
      400
    );
  }

  // A contact is addressable by phone number OR by business-scoped user
  // ID. Meta withholds the phone number for a customer who has adopted
  // a WhatsApp username, so those contacts carry only a BSUID and are
  // reached through Meta's `recipient` field instead of `to` (issue
  // #519). Phone stays preferred when we have one: only it supports the
  // trunk-prefix variant retry below.
  const resolvedTarget = resolveContactSendTarget(contact);
  if (!resolvedTarget) {
    throw new SendMessageError(
      'bad_request',
      contact?.phone
        ? 'Invalid phone number format'
        : 'Contact has no phone number or WhatsApp user ID',
      400
    );
  }
  const sendTarget = resolvedTarget.target;
  const hasValidPhone = resolvedTarget.isPhone;
  const sanitizedPhone = hasValidPhone ? sendTarget : '';

  // WhatsApp connection - prefer the one this conversation is already
  // tied to (so a reply goes out from the same number the customer
  // messaged), falling back to the resolver (the account's sole
  // connection, or a clear error if there isn't exactly one) for
  // conversations that predate multi-connection support.
  let config;
  try {
    const pinnedConfigId = whatsappConfigId || conversation.whatsapp_config_id;
    config = pinnedConfigId
      ? await resolveWhatsAppConfig(db, accountId, pinnedConfigId)
      : await resolveWhatsAppConfig(db, accountId);
  } catch (err) {
    if (err instanceof AmbiguousConnectionError) {
      throw new SendMessageError('ambiguous_connection', err.message, 400);
    }
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  // Self-heal conversations that predate whatsapp_config_id (or were
  // somehow left null) so the next reply doesn't need to fall back to
  // the resolver again. Fire-and-forget; idempotent.
  if (!conversation.whatsapp_config_id) {
    void db
      .from('conversations')
      .update({ whatsapp_config_id: config.id })
      .eq('id', conversationId);
  }

  const accessToken = (await resolveWhatsAppCredentialsAsync(config)).accessToken;

  // Self-heal legacy CBC ciphertexts (custom connections only - shared
  // connections store no token). Fire-and-forget; idempotent.
  if (
    config.mode === 'custom' &&
    config.access_token &&
    isLegacyFormat(config.access_token)
  ) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation - otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // Template row - needed for the send-builder's header + button
  // components AND for the body we persist. The lookup tolerates the
  // en / en_US split so a caller that omits the language still resolves
  // a row (see resolveTemplateRow).
  let templateRow: MessageTemplate | null = null;
  let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      templateName,
      templateLanguage
    );
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally, run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = resolved.row;
    sendLanguage = resolved.language;
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  // Send via Meta - retry across phone-number variants if Meta rejects
  // with "recipient not in allowed list"; persist a working variant
  // back to the contact so the next send goes straight through.
  let waMessageId = '';
  let workingPhone = sendTarget;
  try {
    // Variants only make sense for a phone number - a BSUID is opaque
    // and has exactly one correct form, so it gets a single attempt.
    const variants = hasValidPhone
      ? phoneVariants(sanitizedPhone)
      : [sendTarget];
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(
          `[send-message] variant "${variant}" rejected by Meta, trying next…`
        );
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[send-message] Meta send failed for all variants:', message);
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  if (!otp && hasValidPhone && workingPhone !== sanitizedPhone) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
    );
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  //
  // Templates persist the *substituted* body. The composer pre-renders
  // and posts it as contentText; every other caller (the public API,
  // most importantly) sends none, and storing null there left the
  // Inbox rendering an empty bubble - issue #483.
  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            // OTP codes are never stored: mask every body value.
            otp
              ? templateBodyParams(templateParams, templateMessageParams).map(
                  () => '••••••'
                )
              : templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      sender_id: senderId ?? null,
      content_type: messageType,
      content_text: persistedText,
      media_url:
        messageType === 'template'
          ? templateHeaderMediaUrl(templateRow, templateMessageParams)
          : mediaUrl || null,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  await applyPendingMessageStatuses(supabaseAdmin(), accountId, waMessageId);

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  if (pauseAi) await pauseAiForHumanReply(supabaseAdmin(), conversationId);

  // Pause any active Flow run for this contact - the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort. An OTP is
  // automated, not a human stepping in, so it leaves flows alone.
  try {
    if (otp) return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
