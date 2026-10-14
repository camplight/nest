-- Existing projects keep their creator-only product history. New team projects
-- resolve current membership through OrgOps rather than mirroring it here.
ALTER TABLE product_projects ADD COLUMN collaboration TEXT NOT NULL DEFAULT 'private'
  CHECK (collaboration IN ('private','team'));
