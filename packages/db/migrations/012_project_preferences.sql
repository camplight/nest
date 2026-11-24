CREATE TABLE product_project_preferences (
  project_id TEXT NOT NULL REFERENCES product_projects(id) ON DELETE CASCADE,
  human_id TEXT NOT NULL,
  starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
  last_activity_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id,human_id)
);
CREATE INDEX product_message_personal_activity ON product_message_requests(channel_id,sender_id,delivered_at);
