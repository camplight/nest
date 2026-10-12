CREATE TABLE product_personal_agents (
  owner_id TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  character TEXT NOT NULL,
  brief TEXT NOT NULL,
  model_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  agent_id TEXT,
  channel_id TEXT,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);
