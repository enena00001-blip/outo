const axios = require('axios');
const { getAccount } = require('./db');

const GRAPH_BASE = 'https://graph.threads.net/v1.0';

// ---- OAuth ----
// 1. 사용자를 아래 URL로 보내 로그인/권한 동의를 받는다. (state에 accountId를 실어서 콜백에서 어느 계정인지 식별)
function getAuthUrl(accountId) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  const scopes = ['threads_basic', 'threads_content_publish', 'threads_manage_insights'].join(',');
  return `https://threads.net/oauth/authorize?client_id=${account.threads_app_id}&redirect_uri=${encodeURIComponent(
    account.threads_redirect_uri
  )}&scope=${scopes}&response_type=code&state=${accountId}`;
}

// 2. 콜백으로 받은 code를 단기 액세스 토큰으로 교환
async function exchangeCodeForToken(accountId, code) {
  const account = getAccount(accountId);
  const res = await axios.post('https://graph.threads.net/oauth/access_token', null, {
    params: {
      client_id: account.threads_app_id,
      client_secret: account.threads_app_secret,
      grant_type: 'authorization_code',
      redirect_uri: account.threads_redirect_uri,
      code,
    },
  });
  return res.data; // { access_token, user_id }
}

// 3. 단기 토큰(1시간) -> 장기 토큰(60일)으로 교환
async function exchangeForLongLivedToken(accountId, shortLivedToken) {
  const account = getAccount(accountId);
  const res = await axios.get(`${GRAPH_BASE}/access_token`, {
    params: {
      grant_type: 'th_exchange_token',
      client_secret: account.threads_app_secret,
      access_token: shortLivedToken,
    },
  });
  return res.data; // { access_token, token_type, expires_in }
}

// 4. 만료 전(60일 주기) 갱신
async function refreshLongLivedToken(currentToken) {
  const res = await axios.get(`${GRAPH_BASE}/refresh_access_token`, {
    params: { grant_type: 'th_refresh_token', access_token: currentToken },
  });
  return res.data;
}

// 계정 프로필(사용자명) 조회 - 연결 직후 표시용
async function fetchProfile(accessToken, userId) {
  const res = await axios.get(`${GRAPH_BASE}/${userId}`, {
    params: { fields: 'username', access_token: accessToken },
  });
  return res.data.username;
}

// 영상 미디어 컨테이너는 비동기로 인코딩되므로, 발행 가능 상태(FINISHED)가 될 때까지 폴링
async function waitForContainerReady(creationId, accessToken, maxTries = 20) {
  for (let i = 0; i < maxTries; i++) {
    const res = await axios.get(`${GRAPH_BASE}/${creationId}`, {
      params: { fields: 'status_code', access_token: accessToken },
    });
    const status = res.data.status_code;
    if (status === 'FINISHED') return;
    if (status === 'ERROR') throw new Error('영상 처리에 실패했습니다 (스레드 서버 측 인코딩 오류)');
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('영상 처리 시간이 너무 오래 걸립니다 (잠시 후 다시 시도해주세요)');
}

// ---- 발행 ----
async function publishPost(accountId, { text, imageUrl, videoUrl }) {
  const account = getAccount(accountId);
  if (!account?.threads_user_id || !account?.threads_access_token) {
    throw new Error('스레드 계정이 아직 연결되지 않았습니다 (연결 설정에서 로그인 필요)');
  }
  const { threads_user_id: userId, threads_access_token: accessToken } = account;
  const mediaType = videoUrl ? 'VIDEO' : imageUrl ? 'IMAGE' : 'TEXT';

  const createRes = await axios.post(`${GRAPH_BASE}/${userId}/threads`, null, {
    params: {
      media_type: mediaType,
      text,
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(videoUrl ? { video_url: videoUrl } : {}),
      access_token: accessToken,
    },
  });
  const creationId = createRes.data.id;

  if (mediaType === 'VIDEO') {
    await waitForContainerReady(creationId, accessToken);
  }

  const publishRes = await axios.post(`${GRAPH_BASE}/${userId}/threads_publish`, null, {
    params: { creation_id: creationId, access_token: accessToken },
  });

  return publishRes.data.id; // 발행된 미디어 ID
}

// ---- 댓글(답글) 발행 ----
async function publishReply(accountId, parentMediaId, text) {
  const account = getAccount(accountId);
  if (!account?.threads_user_id || !account?.threads_access_token) {
    throw new Error('스레드 계정이 아직 연결되지 않았습니다 (연결 설정에서 로그인 필요)');
  }
  const { threads_user_id: userId, threads_access_token: accessToken } = account;

  const createRes = await axios.post(`${GRAPH_BASE}/${userId}/threads`, null, {
    params: { media_type: 'TEXT', text, reply_to_id: parentMediaId, access_token: accessToken },
  });
  const creationId = createRes.data.id;

  const publishRes = await axios.post(`${GRAPH_BASE}/${userId}/threads_publish`, null, {
    params: { creation_id: creationId, access_token: accessToken },
  });

  return publishRes.data.id;
}

// ---- 인사이트 조회 ----
async function getMediaInsights(accountId, mediaId) {
  const account = getAccount(accountId);
  const res = await axios.get(`${GRAPH_BASE}/${mediaId}/insights`, {
    params: { metric: 'views,likes,replies,reposts,quotes', access_token: account.threads_access_token },
  });
  const data = {};
  for (const item of res.data.data) {
    data[item.name] = item.values?.[0]?.value ?? item.total_value?.value ?? 0;
  }
  return data;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  refreshLongLivedToken,
  fetchProfile,
  publishPost,
  publishReply,
  getMediaInsights,
};
