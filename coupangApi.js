const axios = require('axios');
const crypto = require('crypto');
const { getAccount } = require('./db');

const DOMAIN = 'https://api-gateway.coupang.com';

// 쿠팡파트너스 Open API는 HMAC-SHA256 서명 인증(CEA 알고리즘)을 사용한다.
function buildAuthHeader(account, method, pathWithQuery) {
  if (!account.coupang_access_key || !account.coupang_secret_key) {
    throw new Error('이 계정에 쿠팡파트너스 Access Key/Secret Key가 설정되지 않았습니다');
  }
  const [path, query = ''] = pathWithQuery.split('?');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const signedDate =
    String(now.getUTCFullYear()).slice(2) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    'T' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) +
    'Z';

  const message = signedDate + method + path + query;
  const signature = crypto.createHmac('sha256', account.coupang_secret_key).update(message).digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${account.coupang_access_key}, signed-date=${signedDate}, signature=${signature}`;
}

async function searchProducts(accountId, keyword, limit = 10) {
  const account = getAccount(accountId);
  const params = new URLSearchParams({ keyword, limit: String(limit) });
  if (account.coupang_sub_id) params.set('subId', account.coupang_sub_id);

  const path = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
  const pathWithQuery = `${path}?${params.toString()}`;

  const res = await axios.get(`${DOMAIN}${pathWithQuery}`, {
    headers: { Authorization: buildAuthHeader(account, 'GET', pathWithQuery) },
    timeout: 10000,
  });

  const list = res.data?.data?.productData || [];
  return list.map((p) => ({
    productId: p.productId,
    name: p.productName,
    image: p.productImage,
    price: p.productPrice,
    url: p.productUrl,
    isRocket: !!p.isRocket,
    isFreeShipping: !!p.isFreeShipping,
  }));
}

async function createDeeplink(accountId, urls) {
  const account = getAccount(accountId);
  const path = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
  const body = {
    coupangUrls: Array.isArray(urls) ? urls : [urls],
    ...(account.coupang_sub_id ? { subId: account.coupang_sub_id } : {}),
  };

  const res = await axios.post(`${DOMAIN}${path}`, body, {
    headers: {
      Authorization: buildAuthHeader(account, 'POST', path),
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  return (res.data?.data || []).map((d) => ({
    originalUrl: d.originalUrl,
    shortenUrl: d.shortenUrl,
    landingUrl: d.landingUrl,
  }));
}

module.exports = { searchProducts, createDeeplink };
