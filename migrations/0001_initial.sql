PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS news (
 id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, excerpt TEXT, blocks_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','pending','scheduled','published','archived')),
 published_at TEXT, starts_at TEXT, ends_at TEXT, seo_title TEXT, seo_description TEXT,
 featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER NOT NULL DEFAULT 0, featured_until TEXT,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_active ON news(status,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC);

CREATE TABLE IF NOT EXISTS taxonomies (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, hierarchical INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS taxonomy_terms (
 id TEXT PRIMARY KEY, taxonomy_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT,
 canonical_path TEXT, sort_order INTEGER NOT NULL DEFAULT 0, seo_title TEXT, seo_description TEXT, status TEXT NOT NULL DEFAULT 'published',
 UNIQUE(taxonomy_id,slug), FOREIGN KEY(taxonomy_id) REFERENCES taxonomies(id), FOREIGN KEY(parent_id) REFERENCES taxonomy_terms(id)
);
CREATE TABLE IF NOT EXISTS content_term_links (
 content_type TEXT NOT NULL, content_id TEXT NOT NULL, term_id TEXT NOT NULL,
 PRIMARY KEY(content_type,content_id,term_id), FOREIGN KEY(term_id) REFERENCES taxonomy_terms(id)
);

CREATE TABLE IF NOT EXISTS timed_contents (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, placement TEXT NOT NULL, title TEXT, body TEXT, asset_id TEXT, link_label TEXT, link_url TEXT,
 starts_at TEXT NOT NULL, ends_at TEXT, priority INTEGER NOT NULL DEFAULT 10,
 status TEXT NOT NULL CHECK(status IN ('draft','pending','scheduled','published','archived')),
 dismissible INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timed_active ON timed_contents(placement,status,starts_at,ends_at,priority DESC);

CREATE TABLE IF NOT EXISTS campaigns (
 id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, lead TEXT, hero_asset_id TEXT, sections_json TEXT NOT NULL,
 cta_label TEXT, cta_url TEXT, seo_title TEXT, seo_description TEXT, starts_at TEXT, ends_at TEXT,
 status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS faqs (
 id TEXT PRIMARY KEY, category_term_id TEXT, question TEXT NOT NULL, answer TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
 starts_at TEXT, ends_at TEXT, status TEXT NOT NULL DEFAULT 'published', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
 id TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, original_filename TEXT, mime_type TEXT NOT NULL, width INTEGER, height INTEGER, bytes INTEGER,
 alt TEXT, caption TEXT, description TEXT, original_asset_id TEXT, variant TEXT NOT NULL DEFAULT 'original', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content_revisions (
 id TEXT PRIMARY KEY, content_type TEXT NOT NULL, content_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT, after_json TEXT, command_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_content ON content_revisions(content_type,content_id,created_at DESC);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, command_type TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
 github_run_id TEXT, github_commit_sha TEXT, error_type TEXT, error_code TEXT, error_message TEXT, result_json TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS redirects (id TEXT PRIMARY KEY, source_path TEXT NOT NULL UNIQUE, destination_path TEXT NOT NULL, status_code INTEGER NOT NULL DEFAULT 301, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reusable_patterns (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, blocks_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);

INSERT OR IGNORE INTO taxonomies (id,name,slug,hierarchical) VALUES ('taxonomy_category','Category','category',1);
INSERT OR IGNORE INTO taxonomies (id,name,slug,hierarchical) VALUES ('taxonomy_tag','Tag','tag',0);
