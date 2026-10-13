CREATE TABLE product_agent_offers (
  agent_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE product_agent_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','dispatching','working','completed','declined','cancelled')),
  version INTEGER NOT NULL DEFAULT 0,
  channel_id TEXT,
  event_id TEXT UNIQUE,
  dispatched_at INTEGER,
  response_event_id TEXT,
  reply TEXT NOT NULL DEFAULT '',
  feedback TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX product_agent_requests_owner ON product_agent_requests(owner_id, updated_at DESC);
CREATE INDEX product_agent_requests_requester ON product_agent_requests(requester_id, updated_at DESC);
