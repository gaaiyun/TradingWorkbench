-- Evidence-layer metadata for news. Existing rows remain discovery records
-- until their publisher and source tier are explicitly verified.
ALTER TABLE news_items ADD COLUMN source_tier TEXT NOT NULL DEFAULT 'discovery';
ALTER TABLE news_items ADD COLUMN publisher TEXT;
ALTER TABLE news_items ADD COLUMN relevance REAL;
ALTER TABLE news_items ADD COLUMN cluster_id TEXT;

CREATE INDEX IF NOT EXISTS idx_news_items_source_tier_published_at
  ON news_items (source_tier, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_items_cluster_id
  ON news_items (cluster_id);
