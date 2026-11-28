/**
 * Handlers for Meta's WhatsApp Business App coexistence webhook
 * fields - only arrive on connections created via Embedded Signup's
 * existing-number flow (`whatsapp_config.signup_type = 'existing_number'`).
 *
 * Three fields, ported from the user's own working implementation of
 * this exact feature in a sister product (see the plan this was built
 * from for file references) - field names and payload shapes below
 * are carried over from that implementation, not independently
 * re-verified against Meta's live docs, so treat anything marked
 * "best-guess" as worth confirming during a real coexistence connect:
 *
 *   - smb_app_state_sync   - contact add/edit/remove made directly in
 *                            the WhatsApp Business app. Log-only for
 *                            v1; nothing meaningful to sync yet (it
 *                            does not carry WhatsApp's "Labels"
 *                            feature, only contact state).
 *   - smb_message_echoes   - a message the tenant sent FROM THE PHONE
 *                            APP itself, mirrored by Meta so the inbox
 *                            stays complete. Ingested as an outbound
 *                            message with `source = 'whatsapp_app'`
 *                            (060_whatsapp_multi_connection.sql) - and
 *                            critically must NOT trigger automations,
 *                            flows, or AI auto-reply, since it's an
 *                            already-sent business message, not
 *                            something awaiting a response.
 *   - history              - first-connect backfill of the number's
 *                            prior chat history. A pure webhook burst,
 *                            not a Graph API fetch. Must not bump
 *                            unread_count, must not trigger AI
 *                            suggestions, and must never move
 *                            last_message_at backward (a backfill
 *                            chunk arriving after live traffic has
 *                            already advanced the conversation must
 *                            not overwrite it).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { pauseAiForHumanReply } from '@/lib/ai/pause';

const COEXISTENCE_WEBHOOK_FIELDS = new Set([
  'smb_app_state_sync',
  'smb_message_echoes',
  'history',
]);

export function isCoexistenceWebhookField(field: string): boolean {
  return COEXISTENCE_WEBHOOK_FIELDS.has(field);
}

interface CoexistenceChange {
  field: string;
  value: unknown;
}

async function resolveConnectionForPhoneNumber(
  supabase: SupabaseClient,
  phoneNumberId: string | undefined
): Promise<{ accountId: string; configId: string; userId: string } | null> {
  if (!phoneNumberId) return null;
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('id, account_id, user_id')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    accountId: data.account_id,
    configId: data.id,
    userId: data.user_id,
  };
}

async function findOrCreateContactByPhone(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  phone: string,
  name: string | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const { data: existing } = await supabase
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('phone', phone)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: userId,
      phone,
      name: name || phone,
    })
    .select()
    .single();
  if (error) {
    console.error(
      '[coexistence-webhook] contact create failed:',
      error.message
    );
    return null;
  }
  return created;
}

async function findOrCreateConversationForContact(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
  configId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('channel', 'whatsapp')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      whatsapp_config_id: configId,
    })
    .select()
    .single();
  if (error) {
    console.error(
      '[coexistence-webhook] conversation create failed:',
      error.message
    );
    return null;
  }
  return created;
}

export async function handleCoexistenceWebhookChange(
  change: CoexistenceChange,
  supabase: SupabaseClient
): Promise<void> {
  if (change.field === 'smb_app_state_sync') {
    console.info(
      '[coexistence-webhook] smb_app_state_sync received (log-only):',
      JSON.stringify(change.value)
    );
    return;
  }

  if (change.field === 'smb_message_echoes') {
    await handleMessageEchoes(change.value, supabase);
    return;
  }

  if (change.field === 'history') {
    await handleHistoryBackfill(change.value, supabase);
    return;
  }
}

interface EchoValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  // Best-guess key - not confirmed against live Meta docs; `messages`
  // is tried as a fallback shape.
  message_echoes?: Array<{
    id?: string;
    to?: string;
    recipient_id?: string;
    text?: { body?: string };
    timestamp?: string;
  }>;
  messages?: Array<{
    id?: string;
    to?: string;
    recipient_id?: string;
    text?: { body?: string };
    timestamp?: string;
  }>;
}

async function handleMessageEchoes(
  rawValue: unknown,
  supabase: SupabaseClient
): Promise<void> {
  const value = rawValue as EchoValue;
  const connection = await resolveConnectionForPhoneNumber(
    supabase,
    value.metadata?.phone_number_id
  );
  if (!connection) {
    console.error(
      '[coexistence-webhook] smb_message_echoes: no connection for phone_number_id',
      value.metadata?.phone_number_id
    );
    return;
  }

  const echoes = value.message_echoes || value.messages || [];
  for (const echo of echoes) {
    const waTo = echo.to || echo.recipient_id || value.contacts?.[0]?.wa_id;
    if (!waTo || !echo.id) continue;

    const contact = await findOrCreateContactByPhone(
      supabase,
      connection.accountId,
      connection.userId,
      waTo,
      value.contacts?.find((c) => c.wa_id === waTo)?.profile?.name
    );
    if (!contact) continue;

    const conversation = await findOrCreateConversationForContact(
      supabase,
      connection.accountId,
      connection.userId,
      contact.id,
      connection.configId
    );
    if (!conversation) continue;

    const createdAt = echo.timestamp
      ? new Date(Number.parseInt(echo.timestamp, 10) * 1000).toISOString()
      : new Date().toISOString();

    // Idempotent insert - same (conversation_id, message_id) unique
    // index the standard inbound path relies on. Deliberately does
    // NOT run any of processMessage's automation/flow/AI-reply
    // dispatch - an echo is a message the business already sent from
    // their phone, not something awaiting a response.
    await supabase.from('messages').upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'agent',
        source: 'whatsapp_app',
        content_type: 'text',
        content_text: echo.text?.body ?? null,
        message_id: echo.id,
        status: 'sent',
        created_at: createdAt,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    );

    await supabase
      .from('conversations')
      .update({
        last_message_text: echo.text?.body ?? '[message]',
        last_message_at: createdAt,
      })
      .eq('id', conversation.id);

    // The business answered from their phone: a person is in this chat, so the AI steps back.
    await pauseAiForHumanReply(supabase, conversation.id);
  }
}

interface HistoryThread {
  id: string;
  messages?: Array<{
    id?: string;
    from?: string;
    to?: string;
    text?: { body?: string };
    timestamp?: string;
    history_context?: { status?: string };
  }>;
}

interface HistoryValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  history?: Array<{
    metadata?: { phase?: string; chunk_order?: number; progress?: number };
    threads?: HistoryThread[];
    errors?: unknown[];
  }>;
}

function mapHistoryStatus(status: string | undefined): string {
  // The local `messages.status` CHECK has no "read" state distinct
  // from "delivered" - collapse read/played into delivered.
  if (status === 'failed') return 'failed';
  return 'delivered';
}

async function handleHistoryBackfill(
  rawValue: unknown,
  supabase: SupabaseClient
): Promise<void> {
  const value = rawValue as HistoryValue;
  const connection = await resolveConnectionForPhoneNumber(
    supabase,
    value.metadata?.phone_number_id
  );
  if (!connection) {
    console.error(
      '[coexistence-webhook] history: no connection for phone_number_id',
      value.metadata?.phone_number_id
    );
    return;
  }

  for (const chunk of value.history || []) {
    for (const thread of chunk.threads || []) {
      const contact = await findOrCreateContactByPhone(
        supabase,
        connection.accountId,
        connection.userId,
        thread.id,
        value.contacts?.find((c) => c.wa_id === thread.id)?.profile?.name
      );
      if (!contact) continue;

      const conversation = await findOrCreateConversationForContact(
        supabase,
        connection.accountId,
        connection.userId,
        contact.id,
        connection.configId
      );
      if (!conversation) continue;

      let latestAt: string | null = null;
      for (const message of thread.messages || []) {
        if (!message.id) continue;
        // Direction is derived against the THREAD's contact id, not
        // the business's own number - avoids a formatting mismatch
        // between the two Meta sends in this payload.
        const senderType = message.from === thread.id ? 'customer' : 'agent';
        const createdAt = message.timestamp
          ? new Date(
              Number.parseInt(message.timestamp, 10) * 1000
            ).toISOString()
          : new Date().toISOString();

        await supabase.from('messages').upsert(
          {
            conversation_id: conversation.id,
            sender_type: senderType,
            source: senderType === 'agent' ? 'whatsapp_app' : 'wacrm',
            content_type: 'text',
            content_text: message.text?.body ?? null,
            message_id: message.id,
            status: mapHistoryStatus(message.history_context?.status),
            created_at: createdAt,
          },
          { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
        );

        if (!latestAt || createdAt > latestAt) latestAt = createdAt;
      }

      if (latestAt) {
        // Only ever move forward - a backfill chunk must never
        // overwrite more-recent live traffic that arrived before it
        // finished processing.
        const { data: current } = await supabase
          .from('conversations')
          .select('last_message_at')
          .eq('id', conversation.id)
          .maybeSingle();
        if (!current?.last_message_at || latestAt > current.last_message_at) {
          await supabase
            .from('conversations')
            .update({ last_message_at: latestAt })
            .eq('id', conversation.id);
        }
      }
    }
  }
}
