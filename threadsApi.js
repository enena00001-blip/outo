const axios = require('axios');
const { getSetting, setSetting } = require('./db');

const GRAPH_BASE = 'https://graph.threads.net/v1.0';

// ---- OAuth ----
// 1. 사용자를 아래 URL로 보내 로그인/권한 동의를 받는다.
function getAuthUrl() {
  const appId = getSetting('THREADS_APP_ID');
  const redirectUri = getSetting('THREADS_REDIRECT_URI');
  const scopes = [
    'threads_basic',
    'threads_content_publish',
    'threads_manage_insights',
  ].join(',');
  return `https://threads.net/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=${scopes}&response_type=code`;
}

// 2. 콜백으로 받은 code를 단기 액세스 토큰으로 교환
async function exchangeCodeForToken(code) {
  const appId = getSetting('THREADS_APP_ID');
  const appSecret = getSetting('THREADS_APP_SECRET');
  const redirectUri = getSetting('THREADS_REDIRECT_URI');

  const res = await axios.post('https://graph.threads.net/oauth/access_token', null, {
    params: {
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    },
  });
  return res.data; // { access_token, user_id }
}

// 3. 단기 토큰(1시간) -> 장기 토큰(60일)으로 교환
async function exchangeForLongLivedToken(shortLivedToken) {
  const appSecret = getSetting('THREADS_APP_SECRET');
  const res = await axios.get(`${GRAPH_BASE}/access_token`, {
    params: {
      grant_type: 'th_exchange_token',
      client_secret: appSecret,
      access_token: shortLivedToken,
    },
  });
  return res.data; // { access_token, token_type, expires_in }
}

// 4. 만료 전(60일 주기) 갱신 - cron에서 주기적으로 호출 권장
async function refreshLongLivedToken(currentToken) {
  const res = await axios.get(`${GRAPH_BASE}/refresh_access_token`, {
    params: {
      grant_type: 'th_refresh_token',
      access_token: currentToken,
    },
  });
  return res.data;
}

// ---- 발행 ----
// 스레드 발행은 2단계: 컨테이너 생성 -> 발행
async function publishPost({ text, imageUrl }) {
  const userId = getSetting('THREADS_USER_ID');
  const accessToken = getSetting('THREADS_ACCESS_TOKEN');
  if (!userId || !accessToken) {
    throw new Error('스레드 계정이 아직 연결되지 않았습니다 (설정 페이지에서 로그인 필요)');
  }

  // 1) 미디어 컨테이너 생성 (링크는 본문에 넣지 않고 발행 후 댓글로 따로 등록)
  const createRes = await axios.post(`${GRAPH_BASE}/${userId}/threads`, null, {
    params: {
      media_type: imageUrl ? 'IMAGE' : 'TEXT',
      text,
      ...(imageUrl ? { image_url: imageUrl } : {}),
      access_token: accessToken,
    },
  });
  const creationId = createRes.data.id;

  // 2) 발행
  const publishRes = await axios.post(`${GRAPH_BASE}/${userId}/threads_publish`, null, {
    params: {
      creation_id: creationId,
      access_token: accessToken,
    },
  });

  return publishRes.data.id; // 발행된 미디어 ID
}

// ---- 댓글(답글) 발행 ----
// 본문 발행 후 그 글에 달리는 답글 형태로 쿠팡파트너스 안내문+링크를 올릴 때 사용
async function publishReply(parentMediaId, text) {
  const userId = getSetting('THREADS_USER_ID');
  const accessToken = getSetting('THREADS_ACCESS_TOKEN');
  if (!userId || !accessToken) {
    throw new Error('스레드 계정이 아직 연결되지 않았습니다 (설정 페이지에서 로그인 필요)');
  }

  // 1) 답글 컨테이너 생성 (reply_to_id로 원글 지정)
  const createRes = await axios.post(`${GRAPH_BASE}/${userId}/threads`, null, {
    params: {
      media_type: 'TEXT',
      text,
      reply_to_id: parentMediaId,
      access_token: accessToken,
    },
  });
  const creationId = createRes.data.id;

  // 2) 발행
  const publishRes = await axios.post(`${GRAPH_BASE}/${userId}/threads_publish`, null, {
    params: {
      creation_id: creationId,
      access_token: accessToken,
    },
  });

  return publishRes.data.id;
}

// ---- 인사이트 조회 ----
async function getMediaInsights(mediaId) {
  const accessToken = getSetting('THREADS_ACCESS_TOKEN');
  const res = await axios.get(`${GRAPH_BASE}/${mediaId}/insights`, {
    params: {
      metric: 'views,likes,replies,reposts,quotes',
      access_token: accessToken,
    },
  });
  const data = {};
  for (const item of res.data.data) {
    data[item.name] = item.values?.[0]?.value ?? item.total_value?.value ?? 0;
  }
  return data;
}

// 일일 발행 한도 확인 (스레드는 계정당 하루 발행 개수 제한이 있음)
async function getPublishingLimit() {
  const userId = getSetting('THREADS_USER_ID');
  const accessToken = getSetting('THREADS_ACCESS_TOKEN');
  const res = await axios.get(`${GRAPH_BASE}/${userId}/threads_publishing_limit`, {
    params: {
      fields: 'quota_usage,config',
      access_token: accessToken,
    },
  });
  return res.data.data?.[0];
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  refreshLongLivedToken,
  publishPost,
  publishReply,
  getMediaInsights,
  getPublishingLimit,
};
