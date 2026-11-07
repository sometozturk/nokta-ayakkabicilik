-- "Tek ödemede sepet" tabloları. Kombininde Dene ile aynı D1 veritabanını paylaşır.
CREATE TABLE IF NOT EXISTS checkout_bundles (
  product_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  cart_hash TEXT NOT NULL,
  items TEXT NOT NULL,
  total TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  order_id TEXT,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS checkout_bundles_hash ON checkout_bundles (cart_hash, status, created_at);
CREATE INDEX IF NOT EXISTS checkout_bundles_status ON checkout_bundles (status, created_at);

CREATE TABLE IF NOT EXISTS checkout_rate (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expire_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkout_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
