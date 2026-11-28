-- ============================================================
-- 139_flow_ai_agent_node.sql: a flow node that hands the conversation to an AI agent.
-- Widens flow_nodes_node_type_check (precedent: 016_flow_media.sql). Idempotent.
-- ============================================================
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'ai_agent',
    'end'
  ));
