const axios = require('axios');
const crypto = require('crypto');
const { getSetting } = require('./db');

const DOMAIN = 'https://api-gateway.coupang.com';

// 쿠팡파트너스 Open API는 HMAC-SHA256 서명 인증(CEA 알고리즘)을 사용한다.
// 참고: signed-date는 GMT 기준 yyMMdd'T'HHmmss'Z' 형식이어야 한다.
function buildAuthHeader(method, pathWithQuery) {
  const accessKey = getSetting('COUPANG_ACCESS_KEY');
  const secretKey = getSetting('COUPANG_SECRET_KEY');
  if (!accessKey || !secretKey) {
    throw new Error('쿠팡파트너스 Access Key/Secret Key가 설정되지 않았습니다 (연결 설정 탭에서 입력)');
  }

  const [path, query = ''] = pathWithQuery.split('?');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // GMT 기준 yyMMdd'T'HHmmss'Z'
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
  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

// 키워드로 상품 검색 (이미지, 가격, 파트너스 링크가 포함된 productUrl까지 한번에 반환됨)
async function searchProducts(keyword, limit = 10) {
  const subId = getSetting('COUPANG_SUB_ID') || undefined;
  const params = new URLSearchParams({ keyword, limit: String(limit) });
  if (subId) params.set('subId', subId);

  const path = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
  const pathWithQuery = `${path}?${params.toString()}`;

  const res = await axios.get(`${DOMAIN}${pathWithQuery}`, {
    headers: { Authorization: buildAuthHeader('GET', pathWithQuery) },
    timeout: 10000,
  });

  const list = res.data?.data?.productData || [];
  return list.map((p) => ({
    productId: p.productId,
    name: p.productName,
    image: p.productImage,
    price: p.productPrice,
    url: p.productUrl, // 이미 파트너스 트래킹이 포함된 링크
    isRocket: !!p.isRocket,
    isFreeShipping: !!p.isFreeShipping,
  }));
}

// 이미 갖고 있는 일반 쿠팡 상품 URL을 파트너스 링크로 변환
async function createDeeplink(urls) {
  const subId = getSetting('COUPANG_SUB_ID') || undefined;
  const path = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
  const body = { coupangUrls: Array.isArray(urls) ? urls : [urls], ...(subId ? { subId } : {}) };

  const res = await axios.post(`${DOMAIN}${path}`, body, {
    headers: {
      Authorization: buildAuthHeader('POST', path),
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
