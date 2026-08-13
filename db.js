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

// 기본 쿠팡파트너스 안내문구 (공정위 표기 의무 문구 포함) - {link} 자리에 실제 링크가 들어감
const DEFAULT_DISCLOSURE_TEMPLATE =
  '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.\n\n{link}';

db.exec(`
-- 계정 하나 = 스레드 계정 하나 + 그 계정에 딸린 쿠팡파트너스/AI 설정
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,                 -- 화면에 표시할 이름 (예: 홈템픽, 젠틀블루)

  threads_app_id TEXT,
  threads_app_secret TEXT,
  threads_redirect_uri TEXT,
  threads_user_id TEXT,
  threads_access_token TEXT,
  threads_token_expires_at TEXT,
  threads_username TEXT,

  coupang_access_key TEXT,
  coupang_secret_key TEXT,
  coupang_sub_id TEXT,
  coupang_disclosure_template TEXT,

  anthropic_api_key TEXT,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  link TEXT,               -- 쿠팡파트너스 링크 등 첨부 링크 (댓글로 자동 등록됨)
  image_url TEXT,          -- 이미지 URL (선택)
  video_url TEXT,          -- 영상 URL (선택, image_url과 동시 사용 불가)
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
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
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

-- 예전 버전(단일 계정)에서 쓰던 전역 설정 테이블. 마이그레이션 시 참고용으로만 유지.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// posts에 account_id 컬럼이 없던 예전 DB를 위한 마이그레이션
const migrations = [
  `ALTER TABLE posts ADD COLUMN auto_comment_enabled INTEGER DEFAULT 1`,
  `ALTER TABLE posts ADD COLUMN comment_status TEXT DEFAULT 'none'`,
  `ALTER TABLE posts ADD COLUMN comment_media_id TEXT`,
  `ALTER TABLE posts ADD COLUMN comment_posted_at TEXT`,
  `ALTER TABLE posts ADD COLUMN comment_error_message TEXT`,
  `ALTER TABLE posts ADD COLUMN video_url TEXT`,
  `ALTER TABLE posts ADD COLUMN account_id INTEGER`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* 컬럼이 이미 있으면 무시 */ }
}

// ---- 예전 단일 계정(settings 테이블) 데이터를 계정 1개로 자동 이전 ----
function migrateLegacySettingsToAccount() {
  const legacyRows = db.prepare('SELECT key, value FROM settings').all();
  if (!legacyRows.length) return;

  const legacy = {};
  for (const r of legacyRows) legacy[r.key] = r.value;

  const hasThreadsData = legacy.THREADS_APP_ID || legacy.THREADS_ACCESS_TOKEN;
  if (!hasThreadsData) return;

  const existingAccount = db.prepare('SELECT id FROM accounts LIMIT 1').get();
  if (existingAccount) return; // 이미 계정이 있으면 중복 이전하지 않음

  db.prepare(
    `INSERT INTO accounts (
      label, threads_app_id, threads_app_secret, threads_redirect_uri,
      threads_user_id, threads_access_token, threads_token_expires_at,
      coupang_access_key, coupang_secret_key, coupang_sub_id, coupang_disclosure_template,
      anthropic_api_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    '기본 계정',
    legacy.THREADS_APP_ID || null,
    legacy.THREADS_APP_SECRET || null,
    legacy.THREADS_REDIRECT_URI || null,
    legacy.THREADS_USER_ID || null,
    legacy.THREADS_ACCESS_TOKEN || null,
    legacy.THREADS_TOKEN_EXPIRES_AT || null,
    legacy.COUPANG_ACCESS_KEY || null,
    legacy.COUPANG_SECRET_KEY || null,
    legacy.COUPANG_SUB_ID || null,
    legacy.COUPANG_DISCLOSURE_TEMPLATE || DEFAULT_DISCLOSURE_TEMPLATE,
    legacy.ANTHROPIC_API_KEY || null
  );

  const newAccountId = db.prepare('SELECT id FROM accounts ORDER BY id DESC LIMIT 1').get().id;
  // 계정 없이 저장된 예전 글들을 새로 만든 계정으로 연결
  db.prepare('UPDATE posts SET account_id = ? WHERE account_id IS NULL').run(newAccountId);
}
migrateLegacySettingsToAccount();

// ---- 계정 CRUD ----
function listAccounts() {
  return db
    .prepare(
      `SELECT id, label, threads_username,
              (threads_access_token IS NOT NULL) AS connected
       FROM accounts ORDER BY id ASC`
    )
    .all();
}

function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

function createAccount(label) {
  const info = db
    .prepare(`INSERT INTO accounts (label, coupang_disclosure_template) VALUES (?, ?)`)
    .run(label, DEFAULT_DISCLOSURE_TEMPLATE);
  return info.lastInsertRowid;
}

const ACCOUNT_UPDATABLE_FIELDS = [
  'label',
  'threads_app_id',
  'threads_app_secret',
  'threads_redirect_uri',
  'threads_user_id',
  'threads_access_token',
  'threads_token_expires_at',
  'threads_username',
  'coupang_access_key',
  'coupang_secret_key',
  'coupang_sub_id',
  'coupang_disclosure_template',
  'anthropic_api_key',
];

function updateAccount(id, fields) {
  const entries = Object.entries(fields).filter(([k]) => ACCOUNT_UPDATABLE_FIELDS.includes(k));
  if (!entries.length) return;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE accounts SET ${setClause} WHERE id = ?`).run(...values, id);
}

function deleteAccount(id) {
  db.prepare('DELETE FROM insights WHERE post_id IN (SELECT id FROM posts WHERE account_id = ?)').run(id);
  db.prepare('DELETE FROM posts WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

module.exports = {
  db,
  DEFAULT_DISCLOSURE_TEMPLATE,
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
};
