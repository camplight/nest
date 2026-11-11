-- Links, their deliveries and forks. Product-owned; ids only.
-- Engine chats, events and subscriptions are never mirrored here.
CREATE TABLE product_links (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('link','fork')),
  from_channel TEXT NOT NULL,
  to_channel TEXT NOT NULL,
  what TEXT NOT NULL CHECK (what IN ('results','summary','all')),
  when_mode TEXT NOT NULL CHECK (when_mode IN ('done','approve','manual')),
  who_agent TEXT,
  label TEXT NOT NULL,
  on_flag INTEGER NOT NULL DEFAULT 1,
  paused_reason TEXT,
  scanned_to INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, from_channel, to_channel)
);
CREATE INDEX product_links_from ON product_links(from_channel);
CREATE INDEX product_links_to ON product_links(to_channel);
CREATE TABLE product_link_deliveries (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES product_links(id) ON DELETE CASCADE,
  source_turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed','awaiting','delivered','declined','failed')),
  target_event_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (link_id, source_turn_id)
);
CREATE TABLE product_forks (
  child_channel TEXT PRIMARY KEY,
  parent_channel TEXT NOT NULL,
  parent_event_id TEXT NOT NULL,
  link_id TEXT REFERENCES product_links(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX product_forks_parent ON product_forks(parent_channel);
CREATE TABLE product_flow_leases (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  until INTEGER NOT NULL
);
