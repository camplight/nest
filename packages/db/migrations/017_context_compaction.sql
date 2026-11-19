CREATE TABLE product_agent_memory (
  agent_name TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  auto_compact INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE product_context_compactions (
  agent_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  trigger_event_id TEXT,
  history_max_chars INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  cutoff_event_id TEXT,
  compacted_at INTEGER,
  PRIMARY KEY (agent_name, channel_id)
);
CREATE INDEX product_context_compactions_due ON product_context_compactions(status,next_at);
