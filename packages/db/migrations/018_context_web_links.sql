-- Web links (pasted URLs) in canvas and area context. Like context files, scope_id has no foreign key.
CREATE TABLE product_canvas_context_web_links (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL REFERENCES product_canvases(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('canvas','area')),
  scope_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  UNIQUE (scope_kind, scope_id, url)
);
CREATE INDEX product_canvas_context_web_links_scope ON product_canvas_context_web_links(scope_kind, scope_id);
