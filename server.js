require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const {
  db,
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  DEFAULT_DISCLOSURE_TEMPLATE,
} = require('./db');
const threadsApi = require('./threadsApi');
const { scrapeProduct } = require('./scraper');
const coupangApi = require('./coupangApi');
const { generateCaption } = require('./aiCaption');
const { startPublishJob, startInsightsJob } = require('./scheduler');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 직접 업로드한 사진/영상 저장 폴더 (Threads API가 공개 URL을 요구하므로 정적 파일로 서빙)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const ALLOWED_MEDIA_TYPES = /^(image\/(jpeg|png|gif|webp)|video\/mp4|video\/quicktime)$/;
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      cb(null, safeName);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MEDIA_TYPES.test(file.mimetype)) {
      return cb(new Error('지원하지 않는 파일 형식입니다 (jpg/png/gif/webp/mp4/mov만 가능)'));
    }
    cb(null, true);
  },
});

function getPublicBaseUrl(req, account) {
  if (account?.threads_redirect_uri) {
    try {
      const u = new URL(account.threads_redirect_uri);
      return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through */
    }
  }
  return `${req.protocol}://${req.get('host')}`;
}

// 요청에서 accountId를 뽑아서 계정 레코드를 붙여주는 미들웨어
function requireAccount(req, res, next) {
  const accountId = Number(req.query.accountId || req.body?.accountId || req.params.accountId);
  if (!accountId) return res.status(400).json({ error: 'accountId가 필요합니다' });
  const account = getAccount(accountId);
  if (!account) return res.status(404).json({ error: '존재하지 않는 계정입니다' });
  req.account = account;
  next();
}

// ---------- 계정 관리 ----------
app.get('/api/accounts', (req, res) => {
  res.json(listAccounts());
});

app.post('/api/accounts', (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: '계정 이름을 입력해주세요' });
  const existing = listAccounts();
  if (existing.length >= 5) {
    return res.status(400).json({ error: '계정은 최대 5개까지 만들 수 있습니다' });
  }
  const id = createAccount(label.trim());
  res.json({ id });
});

app.put('/api/accounts/:accountId', requireAccount, (req, res) => {
  const { label } = req.body;
  if (label !== undefined) updateAccount(req.account.id, { label: label.trim() });
  res.json({ ok: true });
});

app.delete('/api/accounts/:accountId', requireAccount, (req, res) => {
  deleteAccount(req.account.id);
  res.json({ ok: true });
});

// ---------- 연결 상태 ----------
app.get('/api/accounts/:accountId/connection-status', requireAccount, (req, res) => {
  const a = req.account;
  res.json({
    connected: !!(a.threads_access_token && a.threads_user_id),
    username: a.threads_username || null,
  });
});

// ---------- OAuth ----------
app.get('/auth/login', requireAccount, (req, res) => {
  try {
    res.redirect(threadsApi.getAuthUrl(req.account.id));
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const accountId = Number(state);
    if (!accountId) throw new Error('콜백에 계정 정보(state)가 없습니다');

    const shortLived = await threadsApi.exchangeCodeForToken(accountId, code);
    const longLived = await threadsApi.exchangeForLongLivedToken(accountId, shortLived.access_token);
    let username = null;
    try {
      username = await threadsApi.fetchProfile(longLived.access_token, shortLived.user_id);
    } catch {
      /* 사용자명 조회 실패해도 연결 자체는 계속 진행 */
    }

    updateAccount(accountId, {
      threads_user_id: String(shortLived.user_id),
      threads_access_token: longLived.access_token,
      threads_token_expires_at: String(Date.now() + longLived.expires_in * 1000),
      threads_username: username,
    });

    res.redirect(`/?connected=1&accountId=${accountId}`);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('연결 실패: ' + (err.response?.data?.error?.message || err.message));
  }
});

// ---------- 직접 업로드한 사진/영상 첨부 ----------
app.post('/api/upload-media', requireAccount, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
  const url = `${getPublicBaseUrl(req, req.account)}/uploads/${req.file.filename}`;
  const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  res.json({ url, filename: req.file.filename, mediaType });
});

app.delete('/api/upload-media/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // 경로 조작 방지
  const filePath = path.join(uploadsDir, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ---------- AI로 스레드 본문 자동 생성 ----------
app.post('/api/generate-caption', requireAccount, async (req, res) => {
  const { productName, price } = req.body;
  if (!productName) return res.status(400).json({ error: 'productName이 필요합니다' });
  try {
    const texts = await generateCaption(req.account.id, { productName, price });
    res.json({ texts });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ---------- 쿠팡파트너스 상품 검색 (Open API) ----------
app.get('/api/coupang/search', requireAccount, async (req, res) => {
  const { keyword, limit } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword가 필요합니다' });
  try {
    const products = await coupangApi.searchProducts(req.account.id, keyword, Number(limit) || 10);
    res.json({ products });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.message || err.message });
  }
});

app.post('/api/coupang/deeplink', requireAccount, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url이 필요합니다' });
  try {
    const [result] = await coupangApi.createDeeplink(req.account.id, [url]);
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.message || err.message });
  }
});

// ---------- 상품 이미지/제목 자동 가져오기 (검색 API를 못 쓸 때의 보조 수단) ----------
app.post('/api/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url이 필요합니다' });
  try {
    const result = await scrapeProduct(url);
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ---------- 글 등록 (예약) ----------
app.post('/api/posts', requireAccount, (req, res) => {
  const { text, link, image_url, video_url, scheduled_at, auto_comment_enabled } = req.body;
  if (!text || !scheduled_at) {
    return res.status(400).json({ error: 'text와 scheduled_at은 필수입니다' });
  }
  const info = db
    .prepare(
      `INSERT INTO posts (account_id, text, link, image_url, video_url, scheduled_at, auto_comment_enabled, comment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.account.id,
      text,
      link || null,
      image_url || null,
      video_url || null,
      scheduled_at,
      auto_comment_enabled === false ? 0 : 1,
      link ? 'pending' : 'none'
    );
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/posts/:id', requireAccount, (req, res) => {
  db.prepare(`DELETE FROM posts WHERE id = ? AND account_id = ? AND status = 'pending'`).run(
    req.params.id,
    req.account.id
  );
  res.json({ ok: true });
});

// ---------- 대시보드용 요약 데이터 ----------
app.get('/api/dashboard', requireAccount, (req, res) => {
  const accountId = req.account.id;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startIso = startOfDay.toISOString();
  const endOfDay = new Date(startOfDay.getTime() + 24 * 3600 * 1000).toISOString();

  const pendingToday = db
    .prepare(
      `SELECT COUNT(*) c FROM posts WHERE account_id = ? AND status = 'pending' AND scheduled_at >= ? AND scheduled_at < ?`
    )
    .get(accountId, startIso, endOfDay).c;

  const postedToday = db
    .prepare(
      `SELECT * FROM posts WHERE account_id = ? AND status = 'posted' AND posted_at >= ? AND posted_at < ?`
    )
    .all(accountId, startIso, endOfDay);

  const totalScheduled = db
    .prepare(
      `SELECT COUNT(*) c FROM posts WHERE account_id = ? AND scheduled_at >= ? AND scheduled_at < ? AND status != 'failed'`
    )
    .get(accountId, startIso, endOfDay).c;

  const postIds = postedToday.map((p) => p.id);
  let totalViews = 0;
  const insightsByPost = {};
  if (postIds.length) {
    const placeholders = postIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM insights WHERE post_id IN (${placeholders})`).all(...postIds);
    for (const r of rows) {
      totalViews += r.views || 0;
      insightsByPost[r.post_id] = r;
    }
  }

  const next = db
    .prepare(`SELECT * FROM posts WHERE account_id = ? AND status = 'pending' ORDER BY scheduled_at ASC LIMIT 1`)
    .get(accountId);

  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, views: 0 }));
  for (const p of postedToday) {
    const h = new Date(p.posted_at).getHours();
    hourly[h].count += 1;
    hourly[h].views += insightsByPost[p.id]?.views || 0;
  }
  const pendingRows = db
    .prepare(
      `SELECT * FROM posts WHERE account_id = ? AND status = 'pending' AND scheduled_at >= ? AND scheduled_at < ?`
    )
    .all(accountId, startIso, endOfDay);
  for (const p of pendingRows) {
    const h = new Date(p.scheduled_at).getHours();
    hourly[h].count += 1;
  }

  res.json({
    pendingToday,
    postedTodayCount: postedToday.length,
    totalScheduled,
    totalViews,
    nextPost: next || null,
    hourly,
    postedToday: postedToday.map((p) => ({ ...p, insights: insightsByPost[p.id] || null })),
  });
});

app.get('/api/posts', requireAccount, (req, res) => {
  const rows = db
    .prepare(`SELECT * FROM posts WHERE account_id = ? ORDER BY scheduled_at DESC LIMIT 200`)
    .all(req.account.id);
  res.json(rows);
});

// ---------- 계정 설정 (App ID/Secret, 쿠팡 키, AI 키, 안내문구 템플릿) ----------
app.get('/api/accounts/:accountId/settings', requireAccount, (req, res) => {
  const a = req.account;
  res.json({
    label: a.label,
    THREADS_APP_ID: a.threads_app_id || '',
    THREADS_REDIRECT_URI: a.threads_redirect_uri || '',
    hasThreadsSecret: !!a.threads_app_secret,
    COUPANG_ACCESS_KEY: a.coupang_access_key || '',
    COUPANG_SUB_ID: a.coupang_sub_id || '',
    hasCoupangSecret: !!a.coupang_secret_key,
    COUPANG_DISCLOSURE_TEMPLATE: a.coupang_disclosure_template || DEFAULT_DISCLOSURE_TEMPLATE,
    hasAnthropicKey: !!a.anthropic_api_key,
  });
});

app.post('/api/accounts/:accountId/settings', requireAccount, (req, res) => {
  const {
    THREADS_APP_ID,
    THREADS_APP_SECRET,
    THREADS_REDIRECT_URI,
    COUPANG_ACCESS_KEY,
    COUPANG_SECRET_KEY,
    COUPANG_SUB_ID,
    ANTHROPIC_API_KEY,
  } = req.body;

  const fields = {};
  if (THREADS_APP_ID !== undefined) fields.threads_app_id = THREADS_APP_ID;
  if (THREADS_APP_SECRET) fields.threads_app_secret = THREADS_APP_SECRET;
  if (THREADS_REDIRECT_URI !== undefined) fields.threads_redirect_uri = THREADS_REDIRECT_URI;
  if (COUPANG_ACCESS_KEY !== undefined) fields.coupang_access_key = COUPANG_ACCESS_KEY;
  if (COUPANG_SECRET_KEY) fields.coupang_secret_key = COUPANG_SECRET_KEY;
  if (COUPANG_SUB_ID !== undefined) fields.coupang_sub_id = COUPANG_SUB_ID;
  if (ANTHROPIC_API_KEY) fields.anthropic_api_key = ANTHROPIC_API_KEY;

  updateAccount(req.account.id, fields);
  res.json({ ok: true });
});

app.post('/api/accounts/:accountId/disclosure-template', requireAccount, (req, res) => {
  const { template } = req.body;
  if (!template || !template.includes('{link}')) {
    return res.status(400).json({ error: '템플릿에는 {link} 자리표시자가 반드시 포함되어야 합니다' });
  }
  updateAccount(req.account.id, { coupang_disclosure_template: template });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Threads 스케줄러 서버 http://localhost:${PORT}`);
  startPublishJob();
  startInsightsJob();
});
