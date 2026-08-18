-- ============================================================
-- TextVault — worker/schema.sql
-- Cloudflare D1 建表语句（在 D1 Console 中执行）
--
-- 若已存在旧表（无 version 字段），先执行迁移：
--   ALTER TABLE notes ADD COLUMN version INTEGER DEFAULT 1;
-- ============================================================

-- 笔记主表（含 version 乐观并发控制字段）
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '未命名',
  content TEXT DEFAULT '',
  userId TEXT NOT NULL DEFAULT 'default-user',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  pinned INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1
);

-- 幂等去重表（覆盖 POST / PUT / DELETE）
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency(created_at);
