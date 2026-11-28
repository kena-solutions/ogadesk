/**
 * MCP tools for AI agents and their knowledge (ai:read / ai:write). Provider keys and integration credentials are
 * never readable; integrations are connected and tool calls approved by people in the app.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { ApiClient } from './dispatch'
import { DESTRUCTIVE, READ, WRITE, errorResult, has, run } from './helpers'

const confirmField = z.boolean().describe('Must be true. Confirm with the user before deleting; this cannot be undone.')
const refuse = (what: string) => errorResult(`Refusing: confirm must be true. This permanently deletes ${what}. Ask the user, then call again with confirm=true.`)

const agentFields = {
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  is_active: z.boolean().optional(),
  system_prompt: z.string().max(20000).nullable().optional().describe('What the agent does and how; start from a template (list_ai_agent_templates).'),
  model: z.string().nullable().optional().describe('Override the workspace model; null = workspace default.'),
  auto_reply_enabled: z.boolean().optional().describe('Answer customers automatically. Keep false until the user has tested the agent.'),
  auto_reply_max_per_conversation: z.number().int().min(1).max(50).optional(),
  handoff_agent_id: z.string().nullable().optional().describe('Teammate (user_id from list_team_members) who gets the chat on handoff; null = shared queue.'),
  channels: z.array(z.enum(['whatsapp', 'web_chat'])).optional(),
  priority: z.number().int().optional().describe('Higher wins when several agents match a conversation.'),
  knowledge_mode: z.enum(['all', 'selected']).optional().describe("'all' = every library source; 'selected' = only linked ones (link_agent_knowledge)."),
  routing: z.object({
    tags: z.array(z.string()).optional().describe('Tag ids; the contact must have at least one.'),
    keywords: z.array(z.string()).optional().describe('Words; the conversation must mention at least one.'),
    hours: z.object({ enabled: z.boolean(), days: z.array(z.number().int().min(0).max(6)).optional(), from: z.string().optional(), to: z.string().optional() }).optional().describe('Only inside these hours (workspace time zone); days 0=Sunday.'),
  }).nullable().optional().describe('When to use this agent. Every part given must match; null clears the rules.'),
  reply_mode: z.enum(['fallback', 'always']).optional().describe("'fallback' (default) = answer only when no flow or automation already replied to the customer's message; 'always' = answer regardless (risks double replies)."),
  persona_tone: z.string().max(400).nullable().optional(),
  persona_behaviour: z.string().max(1500).nullable().optional(),
  persona_avoid: z.string().max(1500).nullable().optional(),
  persona_never: z.string().max(1500).nullable().optional(),
  tool_integrations: z.array(z.string()).nullable().optional().describe('Integration ids whose tools it may use; null = all connected.'),
}

export function registerAiTools(server: McpServer, api: ApiClient, scopes: string[]) {
  if (has(scopes, 'ai:read')) {
    server.registerTool(
      'list_ai_agent_templates',
      { title: 'AI agent templates', description: 'Starting points for an agent (support, sales, marketing, admin): system prompt, channels, reply cap.', inputSchema: {}, annotations: { ...READ, title: 'AI agent templates' } },
      run(async () => api.aiAgentTemplates()),
    )
    server.registerTool(
      'list_ai_agents',
      { title: 'List AI agents', description: 'The workspace AI agents (default first) with channels, knowledge mode, auto-reply and linked source counts.', inputSchema: {}, annotations: { ...READ, title: 'List AI agents' } },
      run(async () => api.listAiAgents()),
    )
    server.registerTool(
      'get_ai_agent',
      { title: 'Get AI agent', description: 'One agent with its full settings and linked knowledge source_ids.', inputSchema: { id: z.string() }, annotations: { ...READ, title: 'Get AI agent' } },
      run(async ({ id }) => api.getAiAgent(id)),
    )
    server.registerTool(
      'list_knowledge_sources',
      { title: 'List knowledge sources', description: 'The knowledge library: text, Q&A, web pages, websites and files with indexing status and linked agent_ids.', inputSchema: {}, annotations: { ...READ, title: 'List knowledge sources' } },
      run(async () => api.listKnowledgeSources()),
    )
    server.registerTool(
      'search_knowledge',
      {
        title: 'Search knowledge',
        description: 'What an agent would be given for a question (retrieval only, no AI call, no credits). Use to check the library answers common questions before switching auto-reply on.',
        inputSchema: { query: z.string().min(1).max(1000), agent_id: z.string().optional().describe('Limit to that agent’s knowledge.') },
        annotations: { ...READ, title: 'Search knowledge' },
      },
      run(async (a) => api.searchKnowledge(a)),
    )
    server.registerTool(
      'list_integrations',
      {
        title: 'List integrations',
        description: 'Connected integrations (MCP servers, HTTP tools, Google Calendar, Paystack) and the tools each gives agents. Credentials are never shown; integrations are connected in the app.',
        inputSchema: {},
        annotations: { ...READ, title: 'List integrations' },
      },
      run(async () => api.listIntegrations()),
    )
    server.registerTool(
      'list_ai_tool_calls',
      {
        title: 'List AI tool calls',
        description: 'Recent actions agents asked to run, newest first. status=pending_approval lists what waits for a teammate; approving or rejecting is done by a person in the app.',
        inputSchema: {
          status: z.enum(['pending_approval', 'proposed', 'approved', 'rejected', 'ok', 'error', 'expired']).optional(),
          conversation_id: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        annotations: { ...READ, title: 'List AI tool calls' },
      },
      run(async (q) => api.listAiToolCalls(q)),
    )
    server.registerTool(
      'get_ai_usage',
      { title: 'AI usage', description: 'OgaDesk AI credits used this month against the plan, and token totals for the last 30 days.', inputSchema: {}, annotations: { ...READ, title: 'AI usage' } },
      run(async () => api.getAiUsage()),
    )
  }

  if (has(scopes, 'ai:write')) {
    server.registerTool(
      'create_ai_agent',
      {
        title: 'Create AI agent',
        description: 'Create an agent (max 20; the first becomes the default). Build it with auto_reply_enabled false, test with search_knowledge, show the user, then turn auto-reply on with update_ai_agent after a yes.',
        inputSchema: { ...agentFields, name: z.string().min(1).max(80) },
        annotations: { ...WRITE, title: 'Create AI agent' },
      },
      run(async (a) => api.createAiAgent(a)),
    )
    server.registerTool(
      'update_ai_agent',
      { title: 'Update AI agent', description: 'Change any agent settings. Turning auto_reply_enabled on makes it answer customers: get the user’s yes first.', inputSchema: { id: z.string(), ...agentFields }, annotations: { ...WRITE, title: 'Update AI agent' } },
      run(async ({ id, ...rest }) => api.updateAiAgent(id, rest)),
    )
    server.registerTool(
      'delete_ai_agent',
      { title: 'Delete AI agent', description: 'Delete an agent (never the default one).', inputSchema: { id: z.string(), confirm: confirmField }, annotations: { ...DESTRUCTIVE, title: 'Delete AI agent' } },
      run(async ({ id, confirm }) => (confirm === true ? api.deleteAiAgent(id) : refuse('this AI agent'))),
    )
    server.registerTool(
      'link_agent_knowledge',
      {
        title: 'Link knowledge to agent',
        description: "Replace the sources an agent uses (applies when its knowledge_mode is 'selected'). Pass every source id it should keep.",
        inputSchema: { id: z.string().describe('Agent id.'), source_ids: z.array(z.string()).max(500) },
        annotations: { ...WRITE, title: 'Link knowledge to agent' },
      },
      run(async ({ id, source_ids }) => api.linkAgentKnowledge(id, { source_ids })),
    )
    server.registerTool(
      'create_knowledge_source',
      {
        title: 'Add knowledge source',
        description:
          'Add to the library and index it now (websites finish in the background). type text: { name, content } · qa: { name, pairs: [{question, answer}] } · url: { url } · website: { start_url, max_pages?, include?, exclude? }. Optional sync_interval for url/website and link_agent_id. Files are uploaded in the app.',
        inputSchema: {
          type: z.enum(['text', 'qa', 'url', 'website']),
          name: z.string().max(200).optional(),
          content: z.string().optional(),
          pairs: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
          url: z.string().optional(),
          start_url: z.string().optional(),
          max_pages: z.number().int().min(1).optional(),
          include: z.array(z.string()).optional().describe('Path prefixes to crawl, e.g. ["/help"].'),
          exclude: z.array(z.string()).optional(),
          sync_interval: z.enum(['none', 'daily', 'weekly']).optional(),
          link_agent_id: z.string().optional(),
        },
        annotations: { ...WRITE, title: 'Add knowledge source' },
      },
      run(async (a) => api.createKnowledgeSource(a)),
    )
    server.registerTool(
      'sync_knowledge_source',
      { title: 'Re-sync knowledge source', description: 'Fetch pages again (unchanged ones are skipped) or re-embed text.', inputSchema: { id: z.string() }, annotations: { ...WRITE, title: 'Re-sync knowledge source' } },
      run(async ({ id }) => api.syncKnowledgeSource(id)),
    )
    server.registerTool(
      'delete_knowledge_source',
      { title: 'Delete knowledge source', description: 'Remove a source and everything indexed from it, from every agent.', inputSchema: { id: z.string(), confirm: confirmField }, annotations: { ...DESTRUCTIVE, title: 'Delete knowledge source' } },
      run(async ({ id, confirm }) => (confirm === true ? api.deleteKnowledgeSource(id) : refuse('this knowledge source'))),
    )
    server.registerTool(
      'set_conversation_agent',
      {
        title: 'Choose the agent for a conversation',
        description: 'Pin which AI agent answers a conversation; agent_id null goes back to automatic (channel, then default).',
        inputSchema: { conversation_id: z.string(), agent_id: z.string().nullable() },
        annotations: { ...WRITE, title: 'Choose the agent for a conversation' },
      },
      run(async ({ conversation_id, agent_id }) => api.setConversationAgent(conversation_id, { agent_id })),
    )
  }
}
