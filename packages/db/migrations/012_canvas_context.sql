-- Notes, files and links for canvases and areas, plus each chat's home and agent context keys.
-- Engine chats and memberships are never mirrored here; channel ids are opaque references.
CREATE TABLE product_canvas_context (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('canvas','area')),
  scope_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL REFERENCES product_canvases(id) ON DELETE CASCADE,
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_id)
);
CREATE TABLE product_canvas_context_files (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL REFERENCES product_canvases(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('canvas','area')),
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  uploaded_by TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX product_canvas_context_files_scope ON product_canvas_context_files(scope_kind, scope_id);
CREATE INDEX product_canvas_context_files_canvas ON product_canvas_context_files(canvas_id);
CREATE TABLE product_area_context_refs (
  area_id TEXT NOT NULL REFERENCES product_canvas_areas(id) ON DELETE CASCADE,
  source_area_id TEXT NOT NULL REFERENCES product_canvas_areas(id) ON DELETE CASCADE,
  linked_by TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (area_id, source_area_id)
);
CREATE INDEX product_area_context_refs_source ON product_area_context_refs(source_area_id);
CREATE TABLE product_chat_home (
  channel_id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL REFERENCES product_canvases(id) ON DELETE CASCADE,
  area_id TEXT REFERENCES product_canvas_areas(id) ON DELETE SET NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL
);
CREATE INDEX product_chat_home_canvas ON product_chat_home(canvas_id);
CREATE TABLE product_context_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  agent_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX product_context_tokens_agent ON product_context_tokens(agent_name);
CREATE TABLE product_context_agents (
  agent_name TEXT PRIMARY KEY,
  skill_enabled_at INTEGER NOT NULL
);
