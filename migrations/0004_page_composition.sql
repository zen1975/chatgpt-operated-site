PRAGMA foreign_keys = ON;

-- Append-only Page Composition Engine migration.
-- 0001/0002/0003 remain unchanged.
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  page_type TEXT NOT NULL CHECK(page_type IN ('standard','landing','company','service','contact','custom')),
  template_profile TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
  seo_title TEXT,
  seo_description TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_sections (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  section_type TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  variant TEXT,
  props_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(page_id) REFERENCES pages(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_page_sections_position
  ON page_sections(page_id, position);
CREATE INDEX IF NOT EXISTS idx_page_sections_page
  ON page_sections(page_id, position);
