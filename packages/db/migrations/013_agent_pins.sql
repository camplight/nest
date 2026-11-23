-- The agents a person pinned to their canvas tray, in order. Keyed by the engine human id;
-- agent names are opaque references to engine agents and are never mirrored here.
-- No row means the person has never saved pins (the tray shows a computed default).
CREATE TABLE product_agent_pins (
  human_id TEXT PRIMARY KEY,
  agent_names_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
