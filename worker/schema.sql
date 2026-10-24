CREATE TABLE IF NOT EXISTS tryon_usage (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS tryon_usage_expire ON tryon_usage (expire_at);
