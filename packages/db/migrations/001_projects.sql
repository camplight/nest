CREATE TABLE product_projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX product_projects_owner ON product_projects(owner_id);
CREATE TABLE product_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES product_projects(id),
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX product_tasks_project ON product_tasks(project_id);
CREATE TABLE product_deliverables (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES product_tasks(id),
  attempt INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  text TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, attempt)
);
CREATE TABLE product_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES product_tasks(id),
  deliverable_id TEXT NOT NULL REFERENCES product_deliverables(id),
  decision TEXT NOT NULL CHECK(decision IN ('approve','request_changes')),
  feedback TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(deliverable_id)
);
