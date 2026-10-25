CREATE TABLE product_project_naming (
  project_id TEXT PRIMARY KEY REFERENCES product_projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES product_message_requests(id),
  expected_name TEXT NOT NULL,
  expected_description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX product_project_naming_due ON product_project_naming(status,next_at);
