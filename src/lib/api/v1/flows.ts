import { validateFlowForActivation } from '@/lib/flows/validate'
import { MAX_FLOW_TIMEOUT_HOURS } from '@/lib/flows/types'

export const FLOW_SELECT =
  'id, name, description, status, trigger_type, trigger_config, entry_node_id, fallback_policy, execution_count, last_executed_at, created_at, updated_at'

export const FLOW_TRIGGERS = ['keyword', 'first_inbound_message', 'manual'] as const
export const FLOW_NODE_TYPES = [
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
] as const

export interface FlowNodeInput {
  node_key: string
  node_type: string
  config: Record<string, unknown>
  position_x?: number
  position_y?: number
}

const MAX_NODES = 120

/** Hard problems (can't even save a draft). Returns an error string or null. */
export function flowStructuralError(b: {
  trigger_type?: unknown
  trigger_config?: unknown
  nodes?: unknown
  fallback_policy?: unknown
}): string | null {
  if (b.trigger_type !== undefined && !(FLOW_TRIGGERS as readonly string[]).includes(String(b.trigger_type))) {
    return `'trigger_type' must be one of: ${FLOW_TRIGGERS.join(', ')}`
  }
  if (
    b.trigger_config !== undefined &&
    (typeof b.trigger_config !== 'object' || b.trigger_config === null || Array.isArray(b.trigger_config))
  ) {
    return "'trigger_config' must be an object"
  }
  if (b.nodes !== undefined) {
    if (!Array.isArray(b.nodes)) return "'nodes' must be an array"
    if (b.nodes.length > MAX_NODES) return `'nodes' allows at most ${MAX_NODES} nodes`
    for (const n of b.nodes as FlowNodeInput[]) {
      if (!n || typeof n.node_key !== 'string' || !n.node_key.trim()) return "every node needs a 'node_key' string"
      if (!(FLOW_NODE_TYPES as readonly string[]).includes(n.node_type)) {
        return `node '${n.node_key}': 'node_type' must be one of: ${FLOW_NODE_TYPES.join(', ')}`
      }
      if (!n.config || typeof n.config !== 'object' || Array.isArray(n.config)) {
        return `node '${n.node_key}': 'config' must be an object`
      }
    }
  }
  if (b.fallback_policy !== undefined) {
    const p = b.fallback_policy as { on_timeout_hours?: unknown } | null
    if (!p || typeof p !== 'object' || Array.isArray(p)) return "'fallback_policy' must be an object"
    const h = p.on_timeout_hours
    if (h !== undefined && !(typeof h === 'number' && Number.isFinite(h) && h > 0 && h <= MAX_FLOW_TIMEOUT_HOURS)) {
      return `fallback_policy.on_timeout_hours must be a number in (0, ${MAX_FLOW_TIMEOUT_HOURS}]`
    }
  }
  return null
}

export function flowIssues(
  flow: {
    name: string
    trigger_type: string
    trigger_config: Record<string, unknown>
    entry_node_id: string | null
  },
  nodes: Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>,
) {
  return validateFlowForActivation(
    flow as Parameters<typeof validateFlowForActivation>[0],
    nodes,
  )
}

export const hasErrors = (issues: ReturnType<typeof flowIssues>) => issues.some((i) => i.severity === 'error')
