-- Reserve before contacting the engine: an uncertain POST must never be repeated.
CREATE TABLE product_project_chats (
  project_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  marker TEXT NOT NULL UNIQUE
);
