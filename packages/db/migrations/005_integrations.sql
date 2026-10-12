CREATE TABLE product_connections (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, provider TEXT NOT NULL,
 account_id TEXT NOT NULL, subject TEXT NOT NULL, toolkit TEXT NOT NULL,
 revoked_at INTEGER, created_at INTEGER NOT NULL,
 UNIQUE(provider,account_id)
);
CREATE TABLE product_connection_grants (
 agent_id TEXT NOT NULL, owner_id TEXT NOT NULL,
 connection_id TEXT NOT NULL REFERENCES product_connections(id), tools_json TEXT NOT NULL,
 PRIMARY KEY(agent_id,connection_id)
);
CREATE TABLE product_connection_tokens (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
 agent_name TEXT NOT NULL, owner_id TEXT NOT NULL, channel_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX product_connection_tokens_agent ON product_connection_tokens(agent_id,owner_id);
