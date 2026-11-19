-- Engine agent IDs prevent deleted/recreated names from inheriting a voice.
CREATE TABLE product_agent_speech (
  agent_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
