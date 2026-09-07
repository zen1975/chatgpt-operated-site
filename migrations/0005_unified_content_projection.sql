-- Append-only v1.5 Unified Content Mutation / Derived Projection migration.
-- 0001-0004 are immutable.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  price_amount REAL,
  price_currency TEXT NOT NULL DEFAULT 'JPY',
  price_display TEXT,
  minimum_order_quantity TEXT,
  primary_asset_id TEXT,
  seo_title_override TEXT,
  seo_description_override TEXT,
  og_image_override TEXT,
  thumbnail_override TEXT,
  breadcrumb_label_override TEXT,
  card_excerpt_override TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived','scheduled')),
  published_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(primary_asset_id) REFERENCES assets(id)
);
CREATE INDEX IF NOT EXISTS idx_products_public ON products(status, published_at DESC);

CREATE TABLE IF NOT EXISTS product_assets (
  product_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('primary','gallery')),
  position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(product_id, asset_id, role, position),
  FOREIGN KEY(product_id) REFERENCES products(id),
  FOREIGN KEY(asset_id) REFERENCES assets(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_asset_slot
  ON product_assets(product_id, role, position);

CREATE TABLE IF NOT EXISTS search_documents (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  content_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  thumbnail TEXT,
  category TEXT,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE(content_type, content_id)
);

CREATE INDEX IF NOT EXISTS idx_search_documents_public ON search_documents(content_type, updated_at DESC);
