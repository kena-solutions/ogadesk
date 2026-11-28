/**
 * MCP tools for building a campaign end to end: pipelines & deals,
 * automations (sequences) and chatbot flows. Every tool is registered
 * only when the calling API key carries the matching scope.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ApiClient } from './dispatch'
import { DESTRUCTIVE, READ, WRITE, cursor, errorResult, has, hasAny, limit, run, text } from './helpers'
import { AUTOMATION_REFERENCE, FLOW_REFERENCE } from './reference'

const looseObj = z.record(z.string(), z.unknown())

const stepSchema = z.object({
  step_type: z.enum([
    'send_message',
    'send_buttons',
    'send_list',
    'send_template',
    'add_tag',
    'remove_tag',
    'assign_conversation',
    'assign_ai_agent',
    'update_contact_field',
    'create_deal',
    'wait',
    'condition',
    'send_webhook',
    'close_conversation',
    'block_contact',
    'unblock_contact',
  ]),
  step_config: looseObj.describe('Config for this step type — see get_automation_reference.'),
  branches: z
    .object({ yes: z.array(looseObj).optional(), no: z.array(looseObj).optional() })
    .optional()
    .describe('Only for "condition" steps: nested steps for the yes / no outcomes.'),
})

const triggerType = z.enum([
  'new_message_received',
  'first_inbound_message',
  'keyword_match',
  'new_contact_created',
  'conversation_assigned',
  'tag_added',
  'form_submitted',
  'time_based',
  'interactive_reply',
])

const nodeSchema = z.object({
  node_key: z.string().describe('Unique id for this node, e.g. "welcome".'),
  node_type: z.enum([
    'start',
    'send_message',
    'send_buttons',
    'send_list',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'ai_agent',
    'end',
  ]),
  config: looseObj.describe('Config for this node type — see get_flow_reference.'),
  position_x: z.number().optional(),
  position_y: z.number().optional(),
})

const flowTrigger = z.enum(['keyword', 'first_inbound_message', 'manual'])

const confirmField = z
  .boolean()
  .describe('Must be true. Confirm with the user before deleting — this cannot be undone.')

function needConfirm(what: string) {
  return errorResult(`Refusing: confirm must be true. This permanently deletes ${what}. Ask the user, then call again with confirm=true.`)
}

export function registerBuilderTools(server: McpServer, api: ApiClient, scopes: string[]) {
  // -------------------------------------------------- shared helpers
  const anyRead = hasAny(scopes, [
    'contacts:read', 'automations:read', 'flows:read', 'pipelines:read',
    'contacts:write', 'automations:write', 'flows:write',
  ])
  if (anyRead) {
    server.registerTool(
      'list_tags',
      {
        title: 'List tags',
        description: 'List the account’s tags (id, name, color). Automations and flows reference tags by id.',
        inputSchema: {},
        annotations: { ...READ, title: 'List tags' },
      },
      run(async () => api.listTags()),
    )
  }
  if (hasAny(scopes, ['contacts:write', 'automations:write', 'flows:write'])) {
    server.registerTool(
      'create_tag',
      {
        title: 'Create tag',
        description: 'Find-or-create a tag by name and return its id (use the id in automation/flow tag steps).',
        inputSchema: { name: z.string().describe('Tag name, max 50 chars.'), color: z.string().optional().describe('Hex like #3b82f6.') },
        annotations: { ...WRITE, title: 'Create tag' },
      },
      run(async (a) => api.createTag(a)),
    )
  }
  if (hasAny(scopes, ['automations:read', 'flows:read', 'pipelines:read', 'workspace:read'])) {
    server.registerTool(
      'list_team_members',
      {
        title: 'List team members',
        description: 'List account members (user_id, name, role). Use user_id for assign_conversation steps and flow handoff nodes.',
        inputSchema: {},
        annotations: { ...READ, title: 'List team members' },
      },
      run(async () => api.listTeam()),
    )
  }

  // ------------------------------------------------------ pipelines
  if (has(scopes, 'pipelines:read')) {
    server.registerTool(
      'list_pipelines',
      {
        title: 'List pipelines',
        description: 'List pipelines (kind "sales" = deals, "support" = tickets) with their ordered stages (ids included; a stage with outcome won/lost is a final stage). create_deal automation steps and create_deal need pipeline_id + stage_id from here.',
        inputSchema: {},
        annotations: { ...READ, title: 'List pipelines' },
      },
      run(async () => api.listPipelines()),
    )
    server.registerTool(
      'list_deals',
      {
        title: 'List deals',
        description: 'List deals, newest first. Filter by pipeline, stage, contact or status (open/won/lost). Paginated.',
        inputSchema: {
          pipeline_id: z.string().optional(),
          stage_id: z.string().optional(),
          contact_id: z.string().optional(),
          status: z.enum(['open', 'won', 'lost']).optional(),
          limit,
          cursor,
        },
        annotations: { ...READ, title: 'List deals' },
      },
      run(async (a) => api.listDeals(a)),
    )
  }
  if (has(scopes, 'pipelines:write')) {
    server.registerTool(
      'create_pipeline',
      {
        title: 'Create pipeline',
        description: 'Create a pipeline. kind "sales" (deals, default) or "support" (tickets; set once). Stages are ordered plain names or {name,color,outcome}; outcome "won"/"lost" marks a FINAL stage (moving a card there closes it as won/lost; for support tickets it also closes the linked chat). Any number of final stages. Omit stages for the defaults: sales New lead → Qualified → Proposal → Negotiation → Won (won) → Lost (lost); support New → In progress → Waiting on customer → Resolved (won) → Closed (lost). Max 20 stages.',
        inputSchema: {
          name: z.string(),
          kind: z.enum(['sales', 'support']).optional(),
          stages: z
            .array(
              z.union([
                z.string(),
                z.object({
                  name: z.string(),
                  color: z.string().optional(),
                  outcome: z.enum(['won', 'lost']).nullable().optional(),
                }),
              ]),
            )
            .optional(),
        },
        annotations: { ...WRITE, title: 'Create pipeline' },
      },
      run(async (a) => api.createPipeline(a)),
    )
    server.registerTool(
      'update_pipeline',
      {
        title: 'Update pipeline',
        description: 'Rename a pipeline and/or replace its stage list. Pass the FULL desired stage list in order; include an existing stage’s id to keep/rename it, omit the id to add one, leave a stage out to remove it (refused if it still holds deals).',
        inputSchema: {
          id: z.string().describe('Pipeline id.'),
          name: z.string().optional(),
          stages: z
            .array(
              z.object({
                id: z.string().optional(),
                name: z.string(),
                color: z.string().optional(),
                outcome: z.enum(['won', 'lost']).nullable().optional().describe('won/lost = final stage; null = normal'),
              }),
            )
            .optional(),
        },
        annotations: { ...WRITE, title: 'Update pipeline' },
      },
      run(async ({ id, ...body }) => api.updatePipeline(id, body)),
    )
    server.registerTool(
      'delete_pipeline',
      {
        title: 'Delete pipeline',
        description: 'Permanently delete a pipeline AND every deal in it.',
        inputSchema: { id: z.string(), confirm: confirmField },
        annotations: { ...DESTRUCTIVE, title: 'Delete pipeline' },
      },
      run(async ({ id, confirm }) => (confirm === true ? api.deletePipeline(id) : needConfirm('this pipeline and all its deals'))),
    )
    server.registerTool(
      'create_deal',
      {
        title: 'Create deal',
        description: 'Create a deal (sales pipeline) or ticket (support pipeline) for an existing contact in a pipeline stage (stage must belong to that pipeline). For tickets pass priority and, optionally, the conversation_id it is about.',
        inputSchema: {
          pipeline_id: z.string(),
          stage_id: z.string(),
          contact_id: z.string(),
          title: z.string(),
          value: z.number().min(0).optional(),
          notes: z.string().optional(),
          expected_close_date: z.string().optional().describe('YYYY-MM-DD'),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Tickets'),
          conversation_id: z.string().optional().describe('Link a ticket to its chat'),
        },
        annotations: { ...WRITE, title: 'Create deal' },
      },
      run(async (a) => api.createDeal(a)),
    )
    server.registerTool(
      'update_deal',
      {
        title: 'Update deal',
        description: 'Edit a deal or ticket, move it to another stage of its pipeline (stage_id; moving into a final stage sets its status automatically), or set status open/won/lost. Only passed fields change.',
        inputSchema: {
          id: z.string(),
          title: z.string().optional(),
          value: z.number().min(0).optional(),
          notes: z.string().optional(),
          expected_close_date: z.string().optional(),
          stage_id: z.string().optional(),
          status: z.enum(['open', 'won', 'lost']).optional(),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).nullable().optional(),
        },
        annotations: { ...WRITE, title: 'Update deal' },
      },
      run(async ({ id, ...body }) => api.updateDeal(id, body)),
    )
  }

  // ---------------------------------------------------- automations
  if (has(scopes, 'automations:read')) {
    server.registerTool(
      'get_automation_reference',
      {
        title: 'Automation authoring guide',
        description: 'READ THIS FIRST before create_automation/update_automation. Returns every trigger type and step type with its exact config shape, limits, interpolation, the recommended build order and a worked example.',
        inputSchema: {},
        annotations: { ...READ, title: 'Automation authoring guide' },
      },
      async () => text(AUTOMATION_REFERENCE),
    )
    server.registerTool(
      'list_automations',
      {
        title: 'List automations',
        description: 'List automations (name, trigger, active flag, run count). Paginated.',
        inputSchema: { limit, cursor },
        annotations: { ...READ, title: 'List automations' },
      },
      run(async (a) => api.listAutomations(a)),
    )
    server.registerTool(
      'get_automation',
      {
        title: 'Get automation',
        description: 'Read one automation with its full step tree and `activation_issues` (what still blocks it from going live).',
        inputSchema: { id: z.string() },
        annotations: { ...READ, title: 'Get automation' },
      },
      run(async ({ id }) => api.getAutomation(id)),
    )
    server.registerTool(
      'validate_automation',
      {
        title: 'Validate automation',
        description: 'Dry-run a definition WITHOUT saving it. Returns {valid, issues}. Use to iterate on steps before create_automation.',
        inputSchema: { trigger_type: triggerType, trigger_config: looseObj.optional(), steps: z.array(stepSchema).optional() },
        annotations: { ...READ, title: 'Validate automation' },
      },
      run(async (a) => api.validateAutomation(a)),
    )
  }
  if (has(scopes, 'automations:write')) {
    server.registerTool(
      'create_automation',
      {
        title: 'Create automation',
        description: 'Create an automation (trigger + ordered steps) as an INACTIVE draft. Read get_automation_reference first. The response includes `activation_issues`; fix them (update_automation) until empty, then activate with update_automation {is_active:true}. Pass is_active=true here only for a complete definition AND after the user has approved the customer-facing wording.',
        inputSchema: {
          name: z.string(),
          description: z.string().optional(),
          trigger_type: triggerType,
          trigger_config: looseObj.optional().describe('e.g. {"keywords":["price"],"match_type":"word"} or {"tag_id":"…"}'),
          steps: z.array(stepSchema).optional(),
          is_active: z.boolean().optional().describe('Default false (draft).'),
        },
        annotations: { ...WRITE, title: 'Create automation' },
      },
      run(async (a) => api.createAutomation(a)),
    )
    server.registerTool(
      'update_automation',
      {
        title: 'Update automation',
        description: 'Edit an automation. Only passed fields change; passing `steps` REPLACES the whole step list (send the complete desired list). Set is_active true/false to turn it on/off — activation is refused while activation_issues exist.',
        inputSchema: {
          id: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          trigger_type: triggerType.optional(),
          trigger_config: looseObj.optional(),
          steps: z.array(stepSchema).optional(),
          is_active: z.boolean().optional(),
        },
        annotations: { ...WRITE, title: 'Update automation' },
      },
      run(async ({ id, ...body }) => api.updateAutomation(id, body)),
    )
    server.registerTool(
      'delete_automation',
      {
        title: 'Delete automation',
        description: 'Permanently delete an automation and its steps/logs.',
        inputSchema: { id: z.string(), confirm: confirmField },
        annotations: { ...DESTRUCTIVE, title: 'Delete automation' },
      },
      run(async ({ id, confirm }) => (confirm === true ? api.deleteAutomation(id) : needConfirm('this automation'))),
    )
  }

  // ----------------------------------------------------------- flows
  if (has(scopes, 'flows:read')) {
    server.registerTool(
      'get_flow_reference',
      {
        title: 'Flow authoring guide',
        description: 'READ THIS FIRST before create_flow/update_flow. Returns every flow trigger and node type with its exact config, the graph rules (node_key / next_node_key edges), the build order and a worked example.',
        inputSchema: {},
        annotations: { ...READ, title: 'Flow authoring guide' },
      },
      async () => text(FLOW_REFERENCE),
    )
    server.registerTool(
      'list_flows',
      {
        title: 'List flows',
        description: 'List chatbot flows (name, status draft/active/archived, trigger). Paginated.',
        inputSchema: { limit, cursor },
        annotations: { ...READ, title: 'List flows' },
      },
      run(async (a) => api.listFlows(a)),
    )
    server.registerTool(
      'get_flow',
      {
        title: 'Get flow',
        description: 'Read one flow with all its nodes and validation `issues` (severity error blocks activation).',
        inputSchema: { id: z.string() },
        annotations: { ...READ, title: 'Get flow' },
      },
      run(async ({ id }) => api.getFlow(id)),
    )
    server.registerTool(
      'validate_flow',
      {
        title: 'Validate flow',
        description: 'Dry-run a flow definition WITHOUT saving. Returns {valid, issues}.',
        inputSchema: {
          name: z.string().optional(),
          trigger_type: flowTrigger,
          trigger_config: looseObj.optional(),
          entry_node_id: z.string().optional(),
          nodes: z.array(nodeSchema),
        },
        annotations: { ...READ, title: 'Validate flow' },
      },
      run(async (a) => api.validateFlow(a)),
    )
  }
  if (has(scopes, 'flows:write')) {
    server.registerTool(
      'create_flow',
      {
        title: 'Create flow',
        description: 'Create a chatbot flow as a DRAFT: trigger + a graph of nodes joined by next_node_key. Read get_flow_reference first. Set entry_node_id to the key of your "start" node. The response lists `issues`; fix errors with update_flow, then call set_flow_status "active".',
        inputSchema: {
          name: z.string(),
          description: z.string().optional(),
          trigger_type: flowTrigger,
          trigger_config: looseObj.optional().describe('keyword: {"keywords":["menu"]}'),
          entry_node_id: z.string().optional(),
          nodes: z.array(nodeSchema).optional(),
          fallback_policy: looseObj.optional(),
        },
        annotations: { ...WRITE, title: 'Create flow' },
      },
      run(async (a) => api.createFlow(a)),
    )
    server.registerTool(
      'update_flow',
      {
        title: 'Update flow',
        description: 'Edit a flow. Passing `nodes` REPLACES the entire graph (send every node). An ACTIVE flow can only be saved if it stays valid — set it to draft first for big rewrites.',
        inputSchema: {
          id: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          trigger_type: flowTrigger.optional(),
          trigger_config: looseObj.optional(),
          entry_node_id: z.string().optional(),
          nodes: z.array(nodeSchema).optional(),
          fallback_policy: looseObj.optional(),
        },
        annotations: { ...WRITE, title: 'Update flow' },
      },
      run(async ({ id, ...body }) => api.updateFlow(id, body)),
    )
    server.registerTool(
      'set_flow_status',
      {
        title: 'Set flow status',
        description: 'Activate / pause / archive a flow. "active" runs the full validator and refuses on errors; leaving "active" cancels in-progress conversations in the flow. Activating makes the flow talk to real customers — confirm wording with the user first.',
        inputSchema: { id: z.string(), status: z.enum(['draft', 'active', 'archived']) },
        annotations: { ...WRITE, title: 'Set flow status' },
      },
      run(async ({ id, status }) => api.setFlowStatus(id, status)),
    )
    server.registerTool(
      'delete_flow',
      {
        title: 'Delete flow',
        description: 'Permanently delete a flow, its nodes, runs and events.',
        inputSchema: { id: z.string(), confirm: confirmField },
        annotations: { ...DESTRUCTIVE, title: 'Delete flow' },
      },
      run(async ({ id, confirm }) => (confirm === true ? api.deleteFlow(id) : needConfirm('this flow and its run history'))),
    )
  }
}
