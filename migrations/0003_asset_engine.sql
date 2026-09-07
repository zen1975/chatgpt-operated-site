PRAGMA foreign_keys = ON;

-- Append-only Asset Engine migration. 0001/0002 remain unchanged.
ALTER TABLE assets ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE assets ADD COLUMN source_id TEXT;
ALTER TABLE assets ADD COLUMN source_sha256 TEXT;
ALTER TABLE assets ADD COLUMN source_metadata_json TEXT;
ALTER TABLE assets ADD COLUMN sha256 TEXT;
ALTER TABLE assets ADD COLUMN logical_asset_id TEXT;
ALTER TABLE assets ADD COLUMN intake_key TEXT;
ALTER TABLE assets ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'validated';

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_sha256_variant
  ON assets(sha256, variant)
  WHERE sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_intake_key
  ON assets(intake_key)
  WHERE intake_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets_logical_asset
  ON assets(logical_asset_id, variant);

-- General content-to-asset association. content_type is intentionally not
-- constrained to news/article so future domains can reuse this relation.
CREATE TABLE IF NOT EXISTS content_assets (
  content_type TEXT NOT NULL,
  content_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('hero','thumbnail','ogp','inline')),
  position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(content_type, content_id, asset_id, role, position),
  FOREIGN KEY(asset_id) REFERENCES assets(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_assets_slot
  ON content_assets(content_type, content_id, role, position);
CREATE INDEX IF NOT EXISTS idx_content_assets_asset
  ON content_assets(asset_id);
