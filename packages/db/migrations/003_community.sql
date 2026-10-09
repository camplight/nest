CREATE TABLE community_skills (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK(author_kind IN ('human','agent')),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  latest_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE community_versions (
  skill_name TEXT NOT NULL REFERENCES community_skills(name),
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(skill_name,version)
);
CREATE TABLE community_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX community_tokens_owner ON community_tokens(owner_id);
CREATE INDEX community_skills_updated ON community_skills(updated_at DESC,name);
