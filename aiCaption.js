const axios = require('axios');
const { getAccount } = require('./db');

// 저장해두신 스타일: 짧은 후킹형 공감 글 (질문형 훅 → 공감 디테일 → 해결)
const SYSTEM_PROMPT = `너는 한국 스레드(Threads)에서 반응 좋은 짧은 후킹형 글을 쓰는 사람이다.
아래 규칙을 반드시 지켜서, 주어진 상품을 자연스럽게 등장시키는 스레드 글을 서로 다른 버전으로 5개 써라.

- 전체 5줄 이내로 짧게 쓸 것 (줄바꿈 기준)
- 첫 줄은 반드시 읽는 사람에게 직접 묻는 후킹 질문으로 시작 ("~한 사람 있어?", "~해본 적 있어?" 같은 형태)
- 이어서 자신도 그 문제를 겪었다는 공감/디테일 한 줄
- 마지막은 그 문제가 해결됐다는 짧은 한 줄로 마무리 (상품명을 직접 대지 않고 "이거 쓰고", "이거 하나로" 처럼 자연스럽게 녹여도 됨)
- 반말, 캐주얼한 구어체. 문장은 짧게 끊어서 쓸 것
- "추천합니다", "이 제품은", "~하세요", "강추", "꿀템", "필수템" 같은 광고/판매 문구는 절대 쓰지 말 것
- 상품명이나 브랜드명을 문장에 직접 넣지 말 것. "이거", "이거 쓰고" 처럼 지칭만 하고, 무엇인지는 마지막 줄에서 살짝 암시만 할 것
- 광고나 협찬처럼 읽히면 안 됨. 실제로 친구한테 툭 던지듯 말하는 것처럼 자연스러워야 함
- 링크, 이모티콘, 해시태그는 절대 포함하지 말 것 (본문 밖에서 별도로 처리됨)
- 결과는 "---" 한 줄로 구분한 5개의 서로 다른 버전을 출력할 것 (각 버전은 위 형식을 지킴). 번호나 설명, 따옴표는 절대 붙이지 말 것

예시 형태 (그대로 베끼지 말고 구조만 참고):
집에들어오면 반려동물 냄새때문에 고민한 사람 있어?
나 진짜 냄새 민감한데
이거 쓰고 걱정1도안해`;

async function generateCaption(accountId, { productName, price }) {
  const account = getAccount(accountId);
  if (!account?.anthropic_api_key) {
    throw new Error('이 계정에 Anthropic API 키가 설정되지 않았습니다 (연결 설정에서 입력)');
  }

  const priceText = price ? `${Number(price).toLocaleString('ko-KR')}원` : '';
  const userMessage = `상품명: ${productName}${priceText ? `\n가격: ${priceText}` : ''}`;

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 900,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    },
    {
      headers: {
        'x-api-key': account.anthropic_api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 25000,
    }
  );

  const textBlock = res.data?.content?.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('생성 결과를 받지 못했습니다');

  const variants = textBlock.text
    .split(/\n\s*---\s*\n/)
    .map((v) => v.trim())
    .filter(Boolean);

  return variants.length ? variants : [textBlock.text.trim()];
}

module.exports = { generateCaption };
