-- Explicit owner consent to the complete audience of an agent's project chat.
CREATE TABLE product_connection_projects (
  agent_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES product_projects(id),
  audience_hash TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY(agent_id, owner_id, project_id)
);
