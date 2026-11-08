-- Layout only. Engine channels and memberships are never mirrored here.
CREATE TABLE product_canvases (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX product_canvases_owner ON product_canvases(owner_id);
CREATE TABLE product_canvas_members (
  canvas_id TEXT NOT NULL REFERENCES product_canvases(id) ON DELETE CASCADE,
  human_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('edit','view')),
  PRIMARY KEY (canvas_id, human_id)
);
CREATE INDEX product_canvas_members_human ON product_canvas_members(human_id);
CREATE TABLE product_canvas_areas (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL REFERENCES product_canvases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  h REAL NOT NULL,
  tint TEXT NOT NULL DEFAULT 'moss',
  version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX product_canvas_areas_canvas ON product_canvas_areas(canvas_id);
CREATE TABLE product_canvas_cards (
  canvas_id TEXT NOT NULL REFERENCES product_canvases(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  project_id TEXT,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  placed_by TEXT NOT NULL,
  placed_at INTEGER NOT NULL,
  owner_label TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (canvas_id, channel_id)
);
CREATE TABLE product_loose_hidden (
  human_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  hidden_at INTEGER NOT NULL,
  PRIMARY KEY (human_id, channel_id)
);
