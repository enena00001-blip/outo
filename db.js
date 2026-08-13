// Node.js 내장 SQLite 모듈 사용 (Node 22.5+ 필요, 별도 네이티브 빌드 불필요)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'db');
// 배포 환경에 빈 폴더가 누락되는 경우가 있어(git은 빈 폴더를 추적하지 않음) 없으면 직접 생성
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(path.join(dbDir, 'scheduler.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  link TEXT,
  image_url TEXT,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  threads_media_id TEXT,
  posted_at TEXT,
  error_message TEXT,
  auto_comment_enabled INTEGER DEFAULT 1,
  comment_status TEXT DEFAULT 'none',
  comment_media_id TEXT,
  comment_posted_at TEXT,
  comment_error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS insights (
  post_id INTEGER PRIMARY KEY,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  quotes INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);
`);

const migrations = [
  `ALTER TABLE posts ADD COLUMN auto_comment_enabled INTEGER DEFAULT 1`,
  `ALTER TABLE posts ADD COLUMN comment_status TEXT DEFAULT 'none'`,
  `ALTER TABLE posts ADD COLUMN comment_media_id TEXT`,
  `ALTER TABLE posts ADD COLUMN comment_posted_at TEXT`,
  `ALTER TABLE posts ADD COLUMN comment_error_message TEXT`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* 컬럼이 이미 있으면 무시 */ }
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

const DEFAULT_DISCLOSURE_TEMPLATE =
  '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.\n\n{link}';

if (!getSetting('COUPANG_DISCLOSURE_TEMPLATE')) {
  setSetting('COUPANG_DISCLOSURE_TEMPLATE', DEFAULT_DISCLOSURE_TEMPLATE);
}

module.exports = { db, getSetting, setSetting, DEFAULT_DISCLOSURE_TEMPLATE };
