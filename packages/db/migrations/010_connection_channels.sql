-- Explicit owner consent for public channels, separate from private projects.
CREATE TABLE product_connection_channels (
  agent_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  audience_hash TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY(agent_id, owner_id, channel_id)
);
