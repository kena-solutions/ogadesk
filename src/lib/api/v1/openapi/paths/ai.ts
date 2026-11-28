import type { OpenApiObject, PathItems } from '../types'

const res = (name: string) => ({ $ref: `#/components/responses/${name}` })
const json = (schema: OpenApiObject) => ({ 'application/json': { schema } })
const data = json({ type: 'object', properties: { data: {} } })
const STATUS: Record<string, string> = { BadRequest: '400', Unauthorized: '401', PlanLimit: '402', Forbidden: '403', NotFound: '404', RateLimited: '429' }
const errors = (...names: string[]) => Object.fromEntries(names.map((n) => [STATUS[n], res(n)])) as Record<string, OpenApiObject>
const id = (description: string) => ({ name: 'id', in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } })
const body = (properties: Record<string, OpenApiObject>, required: string[] = []) => ({
  required: true,
  content: json({ type: 'object', properties, ...(required.length ? { required } : {}) }),
})

function op(
  operationId: string,
  summary: string,
  scope: 'ai:read' | 'ai:write',
  description: string,
  extra: { parameters?: OpenApiObject[]; requestBody?: OpenApiObject; created?: boolean; notFound?: boolean; badRequest?: boolean } = {},
) {
  const errs = ['Unauthorized', 'PlanLimit', 'Forbidden', 'RateLimited']
  if (extra.badRequest !== false && (extra.requestBody || scope === 'ai:write')) errs.unshift('BadRequest')
  if (extra.notFound) errs.push('NotFound')
  return {
    tags: ['AI agents'],
    operationId,
    summary,
    description: `${description} Requires \`${scope}\`.`,
    ...(extra.parameters ? { parameters: extra.parameters } : {}),
    ...(extra.requestBody ? { requestBody: extra.requestBody } : {}),
    responses: { [extra.created ? '201' : '200']: { description: 'OK.', content: data }, ...errors(...errs) },
  }
}

const agentProps: Record<string, OpenApiObject> = {
  name: { type: 'string', maxLength: 80 },
  description: { type: ['string', 'null'] },
  is_active: { type: 'boolean' },
  system_prompt: { type: ['string', 'null'], maxLength: 20000 },
  model: { type: ['string', 'null'] },
  auto_reply_enabled: { type: 'boolean' },
  auto_reply_max_per_conversation: { type: 'integer' },
  handoff_agent_id: { type: ['string', 'null'], format: 'uuid' },
  channels: { type: 'array', items: { type: 'string', enum: ['whatsapp', 'web_chat'] } },
  priority: { type: 'integer' },
  knowledge_mode: { type: 'string', enum: ['all', 'selected'] },
  reply_mode: { type: 'string', enum: ['fallback', 'always'], description: "'fallback' (default): answer only if no flow or automation already replied to the message." },
  tool_integrations: { type: ['array', 'null'], items: { type: 'string', format: 'uuid' } },
}

export const aiPaths: PathItems = {
  '/ai/agent-templates': { get: op('listAiAgentTemplates', 'List agent templates', 'ai:read', 'Starting points for a new agent: support, sales, marketing and admin.') },
  '/ai/agents': {
    get: op('listAiAgents', 'List AI agents', 'ai:read', 'The workspace AI agents, default first, with their linked knowledge source counts.'),
    post: op('createAiAgent', 'Create an AI agent', 'ai:write', 'At most 20 per workspace; the first becomes the default. Provider keys are set in the app.', {
      requestBody: body(agentProps, ['name']),
      created: true,
    }),
  },
  '/ai/agents/{id}': {
    get: op('getAiAgent', 'Get an AI agent', 'ai:read', 'The agent and its linked knowledge `source_ids`.', { parameters: [id('Agent id.')], notFound: true }),
    patch: op('updateAiAgent', 'Update an AI agent', 'ai:write', 'Any subset of the fields.', { parameters: [id('Agent id.')], requestBody: body(agentProps), notFound: true }),
    delete: op('deleteAiAgent', 'Delete an AI agent', 'ai:write', 'The default agent cannot be deleted.', { parameters: [id('Agent id.')], notFound: true }),
  },
  '/ai/agents/{id}/knowledge': {
    put: op('linkAgentKnowledge', 'Set the knowledge an agent uses', 'ai:write', "Replaces the linked sources (used when `knowledge_mode` is `selected`).", {
      parameters: [id('Agent id.')],
      requestBody: body({ source_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 500 } }, ['source_ids']),
      notFound: true,
    }),
  },
  '/ai/knowledge/sources': {
    get: op('listKnowledgeSources', 'List knowledge sources', 'ai:read', 'The knowledge library with indexing status, counts and linked agent ids.'),
    post: op('createKnowledgeSource', 'Add a knowledge source', 'ai:write', 'A `text`, `qa`, `url` or `website` source, indexed right away (websites finish in the background). Files are uploaded in the app.', {
      requestBody: body(
        {
          type: { type: 'string', enum: ['text', 'qa', 'url', 'website'] },
          name: { type: 'string' },
          content: { type: 'string' },
          pairs: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } } } },
          url: { type: 'string', format: 'uri' },
          start_url: { type: 'string', format: 'uri' },
          max_pages: { type: 'integer', minimum: 1 },
          include: { type: 'array', items: { type: 'string' } },
          exclude: { type: 'array', items: { type: 'string' } },
          sync_interval: { type: 'string', enum: ['none', 'daily', 'weekly'] },
          link_agent_id: { type: 'string', format: 'uuid' },
        },
        ['type'],
      ),
      created: true,
    }),
  },
  '/ai/knowledge/sources/{id}': {
    delete: op('deleteKnowledgeSource', 'Delete a knowledge source', 'ai:write', 'Removes it and everything indexed from it, from every agent.', { parameters: [id('Source id.')], notFound: true, badRequest: false }),
  },
  '/ai/knowledge/sources/{id}/sync': {
    post: op('syncKnowledgeSource', 'Re-sync a knowledge source', 'ai:write', 'Pages are fetched again (unchanged ones skipped); text is re-embedded.', { parameters: [id('Source id.')], notFound: true, badRequest: false }),
  },
  '/ai/knowledge/search': {
    post: op('searchKnowledge', 'Search the knowledge', 'ai:read', 'What an agent would be given for a question. Retrieval only: no AI call, no credits.', {
      requestBody: body({ query: { type: 'string', maxLength: 1000 }, agent_id: { type: 'string', format: 'uuid' } }, ['query']),
      notFound: true,
    }),
  },
  '/ai/integrations': {
    get: op('listIntegrations', 'List integrations', 'ai:read', 'Connected integrations and the tools they give agents. Credentials and settings are never returned.'),
  },
  '/ai/tool-calls': {
    get: op('listAiToolCalls', 'List AI tool calls', 'ai:read', 'Actions agents asked to run, newest first. Approving or rejecting is done by a person in the app.', {
      parameters: [
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending_approval', 'proposed', 'approved', 'rejected', 'ok', 'error', 'expired'] } },
        { name: 'conversation_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      ],
      badRequest: true,
    }),
  },
  '/ai/usage': { get: op('getAiUsage', 'AI usage', 'ai:read', 'OgaDesk AI credits used this month against the plan, and token totals for the last 30 days.') },
  '/ai/conversations/{id}/agent': {
    put: op('setConversationAgent', 'Choose the agent for a conversation', 'ai:write', 'Pins which agent answers; `agent_id: null` goes back to automatic.', {
      parameters: [id('Conversation id.')],
      requestBody: body({ agent_id: { type: ['string', 'null'], format: 'uuid' } }, ['agent_id']),
      notFound: true,
    }),
  },
}
