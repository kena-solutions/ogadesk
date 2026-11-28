/**
 * Authoring references served by the MCP `get_automation_reference` and
 * `get_flow_reference` tools. These are what let an AI assistant build
 * valid automations / flows without guessing shapes: every trigger,
 * step and node type, its exact config, limits, and a worked example.
 *
 * Keep in sync with src/lib/automations/validate.ts, src/types/index.ts
 * (automation configs) and src/lib/flows/{types,validate}.ts.
 */

export const AUTOMATION_REFERENCE = {
  overview:
    'An automation = ONE trigger + an ordered list of steps that run top to bottom. Create it with create_automation (saved as an inactive DRAFT), check `activation_issues` in the response (must be empty before it can go live), then call update_automation with is_active=true. Use validate_automation to dry-run a definition without saving.',
  build_order: [
    '1. Gather ids first: list_tags / create_tag (tag steps & triggers), list_pipelines (create_deal needs pipeline_id AND stage_id), list_team_members (assign_conversation), list_templates (send_template must name an APPROVED template).',
    '2. create_automation as a draft. 3. Fix everything in activation_issues. 4. update_automation {is_active:true}.',
  ],
  triggers: {
    new_message_received: { config: {}, when: 'Every inbound message from a contact.' },
    first_inbound_message: { config: {}, when: "A contact's very first inbound message (best for welcome messages)." },
    keyword_match: {
      config: { keywords: ['price', 'pricing'], match_type: 'contains | exact | word (default contains)', case_sensitive: 'optional boolean' },
      when: 'Inbound text matches any keyword. Prefer match_type "word" for short keywords (contains matches inside longer words).',
    },
    new_contact_created: { config: {}, when: 'A new contact is created.' },
    conversation_assigned: { config: {}, when: 'A conversation is assigned to an agent.' },
    tag_added: { config: { tag_id: 'uuid' }, when: 'That tag is added to a contact. Great for drip sequences: tag → welcome → wait → follow-up.' },
    form_submitted: { config: { form_id: 'optional uuid; empty = any form' }, when: 'A lead submits a form. Answers are available as {{vars.<field>}} (name, email, company, message, phone, custom field keys, hidden params) plus {{vars.score}} and {{vars.qualified}}.' },
    time_based: { config: { schedule: 'cron expression or "HH:mm"', timezone: 'IANA tz, optional' }, when: 'On a schedule.' },
    interactive_reply: {
      config: { reply_ids: ['btn_yes'] },
      when: 'Customer taps a reply button / list row whose id matches. Chain multi-step menus across automations.',
    },
  },
  steps: {
    send_message: { config: { text: 'Hi {{vars.name}}!' }, note: 'Free-form text. WhatsApp only allows this within 24h of the customer\'s last message — use send_template outside that window.' },
    send_buttons: {
      config: { kind: 'buttons', body: 'Choose one', header: 'optional ≤60', footer: 'optional ≤60', buttons: [{ id: 'btn_yes', title: 'Yes (≤20 chars)' }], wait_for_reply: 'optional boolean — pause until the customer answers' },
      limits: '1–3 buttons, unique ids, body ≤1024. Use an interactive_reply trigger on the button id to branch into another automation.',
    },
    send_list: {
      config: { kind: 'list', body: 'Pick a topic', button_label: 'Open menu (≤20)', sections: [{ title: 'optional', rows: [{ id: 'row_1', title: '≤24 chars', description: 'optional ≤72' }] }], wait_for_reply: 'optional boolean' },
      limits: '1–10 rows total, unique ids.',
    },
    send_template: { config: { template_name: 'order_update', language: 'en_US', variables: { '1': 'value for {{1}}' } }, note: 'Must be an APPROVED template (list_templates). Required to message outside the 24h window.' },
    add_tag: { config: { tag_id: 'uuid' } },
    remove_tag: { config: { tag_id: 'uuid' } },
    assign_ai_agent: { config: { agent_id: 'id from list_ai_agents' }, note: 'Hands the chat to an AI agent: pins it and turns the AI on for the chat.' },
    assign_conversation: { config: { mode: 'specific | round_robin', agent_id: 'user_id from list_team_members (required when specific)' } },
    update_contact_field: { config: { field: 'name | email | company | custom:<custom_field_id>', value: 'text, may use {{message.text}} / {{vars.x}}' } },
    create_deal: { config: { pipeline_id: 'uuid', stage_id: 'uuid in that pipeline', title: 'Deal for {{vars.name}}', value: 0 } },
    wait: { config: { amount: 2, unit: 'minutes | hours | days' }, note: 'Pauses the run, then continues with the next step. This is how you build follow-up sequences.' },
    condition: {
      config: {
        subject: 'contact_field | tag_presence | message_content | time_of_day | in_segment | reply_id',
        operand: 'reply_id: the button / list-row id the contact tapped · contact_field: field name · tag_presence: tag id · time_of_day: "HH:mm-HH:mm" · (not needed for message_content)',
        value: 'contact_field / message_content: the text to compare',
        timezone: 'time_of_day only, optional',
      },
      branches: '{ "yes": [ ...steps ], "no": [ ...steps ] } — nest steps here. Only condition steps have branches.',
    },
    send_webhook: { config: { url: 'https://…', headers: {}, body_template: 'optional' }, note: 'http(s) only.' },
    close_conversation: { config: {} },
    block_contact: { config: {}, note: 'Blocks the contact: no message of any kind is sent to them afterwards. Put the confirmation message BEFORE this step.' },
    unblock_contact: { config: {}, note: 'Lifts a block.' },
  },
  interpolation: 'Where supported, {{message.text}} inserts the inbound message and {{vars.key}} a stored variable. Unknown keys render empty.',
  example: {
    name: 'Webinar lead nurture',
    description: 'Tag → welcome → wait a day → follow up',
    trigger_type: 'tag_added',
    trigger_config: { tag_id: '<tag uuid>' },
    steps: [
      { step_type: 'send_template', step_config: { template_name: 'webinar_welcome', language: 'en_US' } },
      { step_type: 'wait', step_config: { amount: 1, unit: 'days' } },
      {
        step_type: 'condition',
        step_config: { subject: 'tag_presence', operand: '<replied tag uuid>' },
        branches: {
          yes: [{ step_type: 'close_conversation', step_config: {} }],
          no: [{ step_type: 'send_template', step_config: { template_name: 'webinar_followup', language: 'en_US' } }],
        },
      },
    ],
  },
  tips: [
    'Always read back activation_issues; a draft can be incomplete, a live automation cannot.',
    'Several automations can match one message — keep triggers specific to avoid double replies.',
    'Never activate something that messages real customers without the user confirming the wording.',
  ],
}

export const FLOW_REFERENCE = {
  overview:
    'A flow is a conversational graph: nodes connected by `next_node_key` references (edges live inside each node config). A customer enters via the trigger, then moves node to node — menus wait for a button/list tap, collect_input waits for free text. Create with create_flow (DRAFT), inspect `issues` (severity error blocks activation; warning is advisory), then set_flow_status "active". Use validate_flow to dry-run.',
  build_order: [
    '1. Gather ids: list_tags (set_tag / condition), list_team_members (handoff assign_to).',
    '2. Design nodes with unique node_key strings (e.g. "welcome", "menu", "ask_name"). 3. create_flow with entry_node_id = the key of your `start` node. 4. Fix every error in `issues`. 5. set_flow_status active.',
  ],
  triggers: {
    keyword: { config: { keywords: ['menu', 'start'], match_type: 'contains | exact (default contains)', case_sensitive: 'optional' }, when: 'Inbound text (or tapped button title/id) matches.' },
    first_inbound_message: { config: {}, when: "A contact's first-ever inbound message." },
    manual: { config: {}, when: 'Started by an agent from the inbox.' },
  },
  nodes: {
    start: { config: { next_node_key: 'welcome' }, note: 'Entry node. entry_node_id on the flow must equal its node_key.' },
    send_message: { config: { text: 'Hi {{vars.name}}', next_node_key: '…' }, note: 'Auto-advances after sending.' },
    send_buttons: {
      config: { text: 'How can we help?', header_text: 'optional', footer_text: 'optional', buttons: [{ reply_id: 'sales', title: 'Sales (≤20)', next_node_key: 'sales_intro' }] },
      limits: '1–3 buttons, unique reply_id, every button needs next_node_key. WAITS for the tap.',
    },
    send_list: {
      config: { text: 'Pick a topic', button_label: 'Topics (≤20)', sections: [{ title: 'optional', rows: [{ reply_id: 'billing', title: '≤24', description: 'optional ≤72', next_node_key: 'billing_help' }] }] },
      limits: '1–10 rows total across sections, unique reply_id, each row needs next_node_key. WAITS for the selection.',
    },
    send_media: { config: { media_type: 'image | video | document', media_url: 'public https URL', caption: 'optional ≤1024', filename: 'documents only', next_node_key: '…' } },
    collect_input: {
      config: { prompt_text: 'What is your name?', var_key: 'name', validation: 'any (others reserved)', next_node_key: '…' },
      note: 'Sends the prompt, waits for free text, stores it in vars[var_key] (usable as {{vars.name}} later).',
    },
    condition: {
      config: { subject: 'var | tag | contact_field', subject_key: 'var: key in vars · tag: tag uuid · contact_field: name|email|phone|company', operator: 'equals | contains | present | absent', value: 'for equals/contains', true_next: 'node_key', false_next: 'node_key' },
      note: 'Routes instantly, no message sent.',
    },
    set_tag: { config: { mode: 'add | remove', tag_id: 'uuid', next_node_key: '…' } },
    ai_agent: { config: { agent_id: 'id from list_ai_agents', note: 'optional internal note' }, note: 'Hands the chat to an AI agent: pins it, turns the AI on, ends the flow. The agent answers the customer\'s next message. Terminal.' },
    handoff: { config: { note: 'optional internal note', assign_to: 'optional user_id from list_team_members' }, note: 'Hands the chat to a human. Terminal.' },
    end: { config: {}, note: 'Terminal — stops the run.' },
  },
  rules: [
    'node_key values are unique strings; every next_node_key / true_next / false_next must point at an existing node.',
    'Auto-advancing nodes (send_message, send_media, set_tag, condition, collect_input after capture) must not form a loop with no waiting node in it.',
    'Unreachable nodes are warnings. A flow needs a name, a trigger, an entry_node_id and at least one node to activate.',
    'reply_id is the routing key — keep it stable, short and unique across the flow.',
  ],
  fallback_policy: {
    note: 'Optional. What to do when a customer replies off-menu or goes quiet.',
    default: { on_unknown_reply: 'reprompt', max_reprompts: 2, on_timeout_hours: 24, on_exhaust: 'handoff' },
  },
  example: {
    name: 'Support menu',
    trigger_type: 'keyword',
    trigger_config: { keywords: ['help', 'support'] },
    entry_node_id: 'start',
    nodes: [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'ask_name' } },
      { node_key: 'ask_name', node_type: 'collect_input', config: { prompt_text: 'Hi! What should we call you?', var_key: 'name', next_node_key: 'menu' } },
      {
        node_key: 'menu',
        node_type: 'send_buttons',
        config: {
          text: 'Thanks {{vars.name}}! What do you need?',
          buttons: [
            { reply_id: 'orders', title: 'My order', next_node_key: 'human' },
            { reply_id: 'other', title: 'Something else', next_node_key: 'human' },
          ],
        },
      },
      { node_key: 'human', node_type: 'handoff', config: { note: 'Customer asked for help from the menu' } },
    ],
  },
}

/**
 * Plain-text reference for the custom-data MCP tools. Kept as one string so
 * it can be returned verbatim by get_custom_data_reference.
 */
export const CUSTOM_DATA_REFERENCE = `
CUSTOM FIELD TYPES (create_custom_field)
  text        free text (max 2000 chars)
  number      options: format plain|currency|percent, currency (ISO), min, max
  bool        yes / no
  date        options: include_time (default false = a calendar day)
  enum        one of options.options
  multi_enum  several of options.options
  url         a web link (https://...)
  phone       international number with + (stored as +digits)
  email       an email address (lower-cased)
  datetime    a moment in time (ISO with Z or an offset); shown in the account time zone
  reference   points at a row of a custom table: options.table_key
  media       one uploaded file (photo, PDF...): options.accept any|image|document|video|audio.
              Files are uploaded by people in the app; via API/MCP you can only keep or clear an
              existing value ({url,path,name,mime,size} of a file already in this account's storage).

VALUE FORMATS (contact custom_fields: { field_key: value }, table rows: { column_key: value })
  url "https://acme.com"  email "ada@acme.com"  phone "+2348012345678"  datetime "2026-11-02T15:30:00Z"
  text "Gold"      number 15000 or "15,000"      bool true/false/"yes"
  date "2026-11-02" or an ISO datetime            enum "Gold"
  multi_enum ["Yoga","Boxing"]                    reference <row id>
  media {url,path,name,mime,size} (read back as {url,name,mime,size}); null clears
  null or "" clears a value. Invalid values are rejected with a reason.

FILTER (segments, filter_contacts)
  { "version": 1, "op": "and" | "or", "rules": [ { "field", "operator", "value" }, ... ] }
  field: name | phone | email | company | created_at | tags | cf:<custom field id>
  text, url, email, phone and the built-ins name / phone / email / company:
      contains, not_contains, equals, not_equals, is_empty, is_set        value: string
  number, date and datetime custom fields:
      eq, neq, gt, gte, lt, lte, between, is_empty, is_set
      value: a number or date; between takes [low, high]
      dates accept "YYYY-MM-DD" or relative tokens: today, yesterday, tomorrow, "-7d", "+30d", "-1m", "+1y"
  bool custom field:   is_true, is_false, is_empty, is_set
  enum custom field:   is, is_not (value: string), is_any_of (value: [strings]), is_empty, is_set
  multi_enum:          has_any, has_all, has_none (value: [strings]), is_empty, is_set
  reference:           is, is_not (value: row id), is_empty, is_set
  media:               is_empty, is_set
  tags:                has_any, has_all, has_none (value: [tag ids])
  created_at:          eq, neq, gt, gte, lt, lte, between (same date values)
  Rules that point at a deleted field are ignored. Relative dates resolve in the account's time zone (Settings, Account, Time zone; default UTC).

EXAMPLE (gym members on a Gold plan who started in the last 30 days and auto-renew)
  { "version": 1, "op": "and", "rules": [
    { "field": "cf:<plan field id>", "operator": "is", "value": "Gold" },
    { "field": "cf:<started field id>", "operator": "gte", "value": "-30d" },
    { "field": "cf:<auto-renew field id>", "operator": "is_true" } ] }

SEGMENTS ARE DYNAMIC: they are re-evaluated whenever used, never a frozen list.
BROADCASTS: a broadcast audience can be a segment (audience.type "segment").
AUTOMATIONS: a condition step with subject "in_segment" and operand = segment id.
`.trim()
