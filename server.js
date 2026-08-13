require('dotenv').config();
const express = require('express');
const path = require('path');
const { db, getSetting, setSetting } = require('./db');
const threadsApi = require('./threadsApi');
const { scrapeProduct } = require('./scraper');
const coupangApi = require('./coupangApi');
const { startPublishJob, startInsightsJob } = require('./scheduler');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 최초 1회 env -> settings 테이블로 반영 (App ID/Secret/Redirect URI, 쿠팡파트너스 키)
[
  'THREADS_APP_ID',
  'THREADS_APP_SECRET',
  'THREADS_REDIRECT_URI',
  'COUPANG_ACCESS_KEY',
  'COUPANG_SECRET_KEY',
  'COUPANG_SUB_ID',
].forEach((k) => {
  if (process.env[k] && !getSetting(k)) setSetting(k, process.env[k]);
});

// ---------- 연결 상태 ----------
app.get('/api/connection-status', (req, res) => {
  const connected = !!(getSetting('THREADS_ACCESS_TOKEN') && getSetting('THREADS_USER_ID'));
  res.json({ connected, username: getSetting('THREADS_USERNAME') || null });
});

// ---------- OAuth ----------
app.get('/auth/login', (req, res) => {
  res.redirect(threadsApi.getAuthUrl());
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const shortLived = await threadsApi.exchangeCodeForToken(code);
    const longLived = await threadsApi.exchangeForLongLivedToken(shortLived.access_token);

    setSetting('THREADS_USER_ID', String(shortLived.user_id));
    setSetting('THREADS_ACCESS_TOKEN', longLived.access_token);
    setSetting('THREADS_TOKEN_EXPIRES_AT', String(Date.now() + longLived.expires_in * 1000));

    res.redirect('/?connected=1');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('연결 실패: ' + (err.response?.data?.error?.message || err.message));
  }
});

// ---------- 쿠팡파트너스 상품 검색 (Open API) ----------
app.get('/api/coupang/search', async (req, res) => {
  const { keyword, limit } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword가 필요합니다' });
  try {
    const products = await coupangApi.searchProducts(keyword, Number(limit) || 10);
    res.json({ products });
  } catch (err) {
    res.status(422).json({ error: err.response?.data?.message || err.message });
  }
});

// 이미 있는 일반 쿠팡 링크를 파트너스 링크로 변환하고 싶을 때
app.post('/api/coupang/deeplink', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url이 필요합니다' });
  try {
    const [result] = await coupangApi.createDeeplink([url]);
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
app.post('/api/posts', (req, res) => {
  const { text, link, image_url, scheduled_at, auto_comment_enabled } = req.body;
  if (!text || !scheduled_at) {
    return res.status(400).json({ error: 'text와 scheduled_at은 필수입니다' });
  }
  const info = db
    .prepare(
      `INSERT INTO posts (text, link, image_url, scheduled_at, auto_comment_enabled, comment_status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      text,
      link || null,
      image_url || null,
      scheduled_at,
      auto_comment_enabled === false ? 0 : 1,
      link ? 'pending' : 'none'
    );
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/posts/:id', (req, res) => {
  db.prepare(`DELETE FROM posts WHERE id = ? AND status = 'pending'`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- 대시보드용 요약 데이터 ----------
app.get('/api/dashboard', (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startIso = startOfDay.toISOString();
  const endOfDay = new Date(startOfDay.getTime() + 24 * 3600 * 1000).toISOString();

  const pendingToday = db
    .prepare(
      `SELECT COUNT(*) c FROM posts WHERE status = 'pending' AND scheduled_at >= ? AND scheduled_at < ?`
    )
    .get(startIso, endOfDay).c;

  const postedToday = db
    .prepare(
      `SELECT * FROM posts WHERE status = 'posted' AND posted_at >= ? AND posted_at < ?`
    )
    .all(startIso, endOfDay);

  const totalScheduled = db
    .prepare(
      `SELECT COUNT(*) c FROM posts WHERE scheduled_at >= ? AND scheduled_at < ? AND status != 'failed'`
    )
    .get(startIso, endOfDay).c;

  const postIds = postedToday.map((p) => p.id);
  let totalViews = 0;
  const insightsByPost = {};
  if (postIds.length) {
    const placeholders = postIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM insights WHERE post_id IN (${placeholders})`)
      .all(...postIds);
    for (const r of rows) {
      totalViews += r.views || 0;
      insightsByPost[r.post_id] = r;
    }
  }

  // 다음 발행 예정 글
  const next = db
    .prepare(
      `SELECT * FROM posts WHERE status = 'pending' ORDER BY scheduled_at ASC LIMIT 1`
    )
    .get();

  // 시간대별(0~23시) 발행 건수 + 해당 시간대 조회수 합
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, views: 0 }));
  for (const p of postedToday) {
    const h = new Date(p.posted_at).getHours();
    hourly[h].count += 1;
    hourly[h].views += insightsByPost[p.id]?.views || 0;
  }
  // pending 글도 예정 시간대에 표시
  const pendingRows = db
    .prepare(
      `SELECT * FROM posts WHERE status = 'pending' AND scheduled_at >= ? AND scheduled_at < ?`
    )
    .all(startIso, endOfDay);
  for (const p of pendingRows) {
    const h = new Date(p.scheduled_at).getHours();
    hourly[h].count += 1; // 예정 건수도 합산 표시
  }

  res.json({
    pendingToday,
    postedTodayCount: postedToday.length,
    totalScheduled,
    totalViews,
    nextPost: next || null,
    hourly,
    postedToday: postedToday.map((p) => ({
      ...p,
      insights: insightsByPost[p.id] || null,
    })),
  });
});

app.get('/api/posts', (req, res) => {
  const rows = db.prepare(`SELECT * FROM posts ORDER BY scheduled_at DESC LIMIT 200`).all();
  res.json(rows);
});

// ---------- 설정 저장 (App ID/Secret/Redirect URI) ----------
app.post('/api/settings', (req, res) => {
  const {
    THREADS_APP_ID,
    THREADS_APP_SECRET,
    THREADS_REDIRECT_URI,
    COUPANG_ACCESS_KEY,
    COUPANG_SECRET_KEY,
    COUPANG_SUB_ID,
  } = req.body;
  if (THREADS_APP_ID) setSetting('THREADS_APP_ID', THREADS_APP_ID);
  if (THREADS_APP_SECRET) setSetting('THREADS_APP_SECRET', THREADS_APP_SECRET);
  if (THREADS_REDIRECT_URI) setSetting('THREADS_REDIRECT_URI', THREADS_REDIRECT_URI);
  if (COUPANG_ACCESS_KEY) setSetting('COUPANG_ACCESS_KEY', COUPANG_ACCESS_KEY);
  if (COUPANG_SECRET_KEY) setSetting('COUPANG_SECRET_KEY', COUPANG_SECRET_KEY);
  if (COUPANG_SUB_ID !== undefined) setSetting('COUPANG_SUB_ID', COUPANG_SUB_ID);
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => {
  res.json({
    THREADS_APP_ID: getSetting('THREADS_APP_ID') || '',
    THREADS_REDIRECT_URI: getSetting('THREADS_REDIRECT_URI') || '',
    hasSecret: !!getSetting('THREADS_APP_SECRET'),
    COUPANG_DISCLOSURE_TEMPLATE: getSetting('COUPANG_DISCLOSURE_TEMPLATE') || '',
    COUPANG_ACCESS_KEY: getSetting('COUPANG_ACCESS_KEY') || '',
    COUPANG_SUB_ID: getSetting('COUPANG_SUB_ID') || '',
    hasCoupangSecret: !!getSetting('COUPANG_SECRET_KEY'),
  });
});

// ---- 쿠팡파트너스 안내문구 템플릿 ----
app.post('/api/disclosure-template', (req, res) => {
  const { template } = req.body;
  if (!template || !template.includes('{link}')) {
    return res.status(400).json({ error: '템플릿에는 {link} 자리표시자가 반드시 포함되어야 합니다' });
  }
  setSetting('COUPANG_DISCLOSURE_TEMPLATE', template);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Threads 스케줄러 서버 http://localhost:${PORT}`);
  startPublishJob();
  startInsightsJob();
});
