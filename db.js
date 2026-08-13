// Node.js 내장 SQLite 모듈 사용 (Node 22.5+ 필요, 별도 네이티브 빌드 불필요)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'db', 'scheduler.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  link TEXT,               -- 쿠팡파트너스 링크 등 첨부 링크 (댓글로 자동 등록됨)
  image_url TEXT,          -- 이미지 URL (선택)
  scheduled_at TEXT NOT NULL,   -- ISO 문자열, 발행 예정 시각
  status TEXT NOT NULL DEFAULT 'pending', -- pending | posted | failed
  threads_media_id TEXT,   -- 발행 성공 후 스레드 미디어 ID
  posted_at TEXT,
  error_message TEXT,
  auto_comment_enabled INTEGER DEFAULT 1, -- 1: 본문 발행 후 안내문구+링크를 댓글로 자동 등록
  comment_status TEXT DEFAULT 'none',     -- none | pending | posted | failed (link 없으면 계속 none)
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

// 이미 만들어진 DB 파일에도 새 컬럼을 안전하게 추가 (이미 있으면 에러 무시)
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

// 기본 쿠팡파트너스 안내문구 (공정위 표기 의무 문구 포함) - {link} 자리에 실제 링크가 들어감
const DEFAULT_DISCLOSURE_TEMPLATE =
  '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.\n\n{link}';

if (!getSetting('COUPANG_DISCLOSURE_TEMPLATE')) {
  setSetting('COUPANG_DISCLOSURE_TEMPLATE', DEFAULT_DISCLOSURE_TEMPLATE);
}

module.exports = { db, getSetting, setSetting, DEFAULT_DISCLOSURE_TEMPLATE };
