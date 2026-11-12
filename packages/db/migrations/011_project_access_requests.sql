CREATE TABLE product_project_access_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES product_projects(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL,
  requester_username TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approving','approved','denied')),
  created_at INTEGER NOT NULL,
  decision_started_at INTEGER,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE UNIQUE INDEX product_project_access_requests_active
  ON product_project_access_requests(project_id, requester_id)
  WHERE status IN ('pending','approving');
CREATE INDEX product_project_access_requests_owner_active
  ON product_project_access_requests(project_id, status, created_at, id);
CREATE INDEX product_project_access_requests_requester_latest
  ON product_project_access_requests(project_id, requester_id, created_at DESC, id DESC);
