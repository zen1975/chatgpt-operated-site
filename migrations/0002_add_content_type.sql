PRAGMA foreign_keys = ON;

-- Append-only compatibility migration. Existing rows remain news by default.
ALTER TABLE news ADD COLUMN content_type TEXT NOT NULL DEFAULT 'news' CHECK(content_type IN ('news','article'));
CREATE INDEX IF NOT EXISTS idx_news_content_type_published ON news(content_type,status,published_at DESC);
