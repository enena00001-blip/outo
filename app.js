// ---- 탭 전환 ----
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---- 연결 상태 ----
async function loadConnectionStatus() {
  const el = document.getElementById('connStatus');
  try {
    const res = await fetch('/api/connection-status');
    const data = await res.json();
    if (data.connected) {
      el.textContent = `연결됨${data.username ? ' · @' + data.username : ''}`;
      el.className = 'conn-badge conn-yes';
    } else {
      el.textContent = '스레드 계정 미연결 · 연결 설정 탭 확인';
      el.className = 'conn-badge conn-no';
    }
  } catch {
    el.textContent = '상태 확인 실패';
    el.className = 'conn-badge conn-no';
  }
}

// ---- 대시보드 데이터 ----
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadDashboard() {
  const res = await fetch('/api/dashboard');
  const data = await res.json();

  document.getElementById('statPending').textContent = data.pendingToday;
  document.getElementById('statNextTime').textContent = data.nextPost
    ? `다음 ${fmtTime(data.nextPost.scheduled_at)}`
    : '예정된 글 없음';

  document.getElementById('statPosted').textContent = data.postedTodayCount;
  document.getElementById('statTotal').textContent = `전체 예약 ${data.totalScheduled}개`;

  document.getElementById('statViews').textContent = data.totalViews.toLocaleString('ko-KR');
  document.getElementById('statViewsSub').textContent = `${data.postedTodayCount}개 글 합계`;

  document.getElementById('panelHeadSummary').textContent =
    `완료 ${data.postedTodayCount} · 예정 ${data.pendingToday}`;

  const grid = document.getElementById('hourlyGrid');
  grid.innerHTML = '';
  data.hourly.forEach((h) => {
    const cell = document.createElement('div');
    cell.className = `hour-cell ${h.count > 0 ? 'has-posts' : 'empty'}`;
    cell.innerHTML = `
      <div class="h-label">${String(h.hour).padStart(2, '0')}</div>
      <div class="h-count">${h.count > 0 ? h.count : '–'}</div>
    `;
    grid.appendChild(cell);
  });

  const detail = document.getElementById('hourDetail');
  if (data.postedToday.length) {
    detail.innerHTML =
      '오늘 발행: ' +
      data.postedToday
        .map((p) => `${fmtTime(p.posted_at)} · 조회 ${p.insights?.views ?? 0}`)
        .join(' &nbsp;|&nbsp; ');
  } else {
    detail.textContent = '오늘 아직 발행된 글이 없습니다.';
  }
}

// ---- 쿠팡파트너스 상품 검색 ----
function fmtPrice(n) {
  if (n === null || n === undefined) return '';
  return Number(n).toLocaleString('ko-KR') + '원';
}

async function searchCoupangProducts() {
  const keyword = document.getElementById('productSearchInput').value.trim();
  const msg = document.getElementById('productSearchMsg');
  const resultsBox = document.getElementById('productResults');
  if (!keyword) return;

  msg.textContent = '검색 중…';
  msg.className = 'msg';
  resultsBox.innerHTML = '';

  try {
    const res = await fetch(`/api/coupang/search?keyword=${encodeURIComponent(keyword)}&limit=8`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    if (!data.products.length) {
      msg.textContent = '검색 결과가 없어요';
      return;
    }
    msg.textContent = `${data.products.length}개 상품 찾음 · 원하는 상품을 선택하세요`;

    resultsBox.innerHTML = data.products
      .map(
        (p, i) => `
      <div class="product-card">
        <img src="${p.image}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="p-info">
          <div class="p-name">${(p.name || '').replace(/</g, '&lt;')}</div>
          <div class="p-price">${fmtPrice(p.price)}</div>
        </div>
        <button type="button" class="pick-btn" data-idx="${i}">이 상품 선택</button>
      </div>`
      )
      .join('');

    resultsBox.querySelectorAll('.pick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = data.products[Number(btn.dataset.idx)];
        applyPickedProduct(p);
      });
    });
  } catch (err) {
    msg.textContent = '검색 실패: ' + err.message;
    msg.className = 'msg error';
  }
}

function applyPickedProduct(p) {
  const form = document.getElementById('composeForm');
  form.link.value = p.url;
  form.image_url.value = p.image;
  lastScrapedLink = p.url; // 자동 스크래핑이 이 링크로 또 돌지 않도록 표시

  const textArea = form.querySelector('textarea[name="text"]');
  if (!textArea.value.trim()) {
    textArea.value = `${p.name}\n${fmtPrice(p.price)}`;
  }

  document.getElementById('imagePreviewImg').src = p.image;
  document.getElementById('imagePreviewBox').classList.remove('hidden');
  const scrapeStatus = document.getElementById('scrapeStatus');
  scrapeStatus.textContent = '상품 검색 결과에서 링크·사진을 채웠어요 (파트너스 링크 포함됨)';
  scrapeStatus.className = 'scrape-status ok';
  updateCommentPreview();
}

document.getElementById('productSearchBtn').addEventListener('click', searchCoupangProducts);
document.getElementById('productSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchCoupangProducts();
  }
});

// ---- 링크 입력 시 상품 이미지/제목 자동 가져오기 ----
let scrapeTimer = null;
let lastScrapedLink = '';

async function runScrape(link) {
  const statusEl = document.getElementById('scrapeStatus');
  const imageInput = document.getElementById('imageUrlInput');
  const previewBox = document.getElementById('imagePreviewBox');
  const previewImg = document.getElementById('imagePreviewImg');
  const textArea = document.querySelector('#composeForm textarea[name="text"]');

  statusEl.textContent = '상품 정보 가져오는 중…';
  statusEl.className = 'scrape-status loading';

  try {
    const res = await fetch('/api/scrape-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: link }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    imageInput.value = data.imageUrl;
    previewImg.src = data.imageUrl;
    previewBox.classList.remove('hidden');

    if (data.title && !textArea.value.trim()) {
      textArea.value = data.title;
    }

    statusEl.textContent = '상품 이미지를 자동으로 채웠어요' + (data.title ? ` · ${data.title}` : '');
    statusEl.className = 'scrape-status ok';
  } catch (err) {
    statusEl.textContent = '자동으로 못 가져왔어요: ' + err.message;
    statusEl.className = 'scrape-status error';
  }
}

document.getElementById('linkInput').addEventListener('input', () => {
  updateCommentPreview();
  clearTimeout(scrapeTimer);
  const link = document.getElementById('linkInput').value.trim();
  if (!link || link === lastScrapedLink) return;
  scrapeTimer = setTimeout(() => {
    lastScrapedLink = link;
    runScrape(link);
  }, 900); // 타이핑 멈추고 0.9초 후 자동 실행
});

// ---- 댓글 미리보기 ----
let disclosureTemplate = '';

function updateCommentPreview() {
  const link = document.getElementById('linkInput').value.trim();
  const enabled = document.getElementById('autoCommentToggle').checked;
  const box = document.getElementById('commentPreview');
  const textEl = document.getElementById('commentPreviewText');
  if (link && enabled) {
    box.classList.remove('hidden');
    textEl.textContent = (disclosureTemplate || '{link}').replace('{link}', link);
  } else {
    box.classList.add('hidden');
  }
}
document.getElementById('autoCommentToggle').addEventListener('change', updateCommentPreview);

// ---- 글 예약 폼 ----
document.getElementById('composeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('composeMsg');
  const body = {
    text: form.text.value,
    link: form.link.value,
    image_url: form.image_url.value,
    scheduled_at: new Date(form.scheduled_at.value).toISOString(),
    auto_comment_enabled: form.auto_comment_enabled.checked,
  };
  try {
    const res = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    msg.textContent = '예약 등록 완료';
    msg.className = 'msg';
    form.reset();
    updateCommentPreview();
    document.getElementById('imagePreviewBox').classList.add('hidden');
    document.getElementById('scrapeStatus').className = 'scrape-status hidden';
    lastScrapedLink = '';
    loadDashboard();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

// ---- 전체 글 목록 ----
const statusLabel = { pending: '예정', posted: '완료', failed: '실패' };
const commentStatusLabel = { none: '해당없음', pending: '대기', posted: '완료', failed: '실패' };

async function loadPosts() {
  const res = await fetch('/api/posts');
  const rows = await res.json();
  const tbody = document.getElementById('postsTableBody');
  tbody.innerHTML = rows
    .map(
      (p) => `
    <tr>
      <td><span class="status-pill status-${p.status}">${statusLabel[p.status]}</span></td>
      <td class="text-cell">${(p.text || '').replace(/</g, '&lt;')}</td>
      <td>${fmtTime(p.status === 'posted' ? p.posted_at : p.scheduled_at)}</td>
      <td>–</td>
      <td><span class="status-pill status-${p.comment_status === 'posted' ? 'posted' : p.comment_status === 'failed' ? 'failed' : p.comment_status === 'pending' ? 'pending' : 'none'}">${commentStatusLabel[p.comment_status] || '해당없음'}</span></td>
      <td>${p.status === 'pending' ? `<button class="del-btn" data-id="${p.id}">삭제</button>` : ''}</td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/posts/${btn.dataset.id}`, { method: 'DELETE' });
      loadPosts();
      loadDashboard();
    });
  });
}

document.querySelector('[data-tab="posts"]').addEventListener('click', loadPosts);

// ---- 설정 저장 ----
async function loadSettings() {
  const res = await fetch('/api/settings');
  const data = await res.json();
  const form = document.getElementById('settingsForm');
  form.THREADS_APP_ID.value = data.THREADS_APP_ID;
  form.THREADS_REDIRECT_URI.value = data.THREADS_REDIRECT_URI;
  form.THREADS_APP_SECRET.placeholder = data.hasSecret ? '저장됨 (변경 시에만 입력)' : '';

  const cForm = document.getElementById('coupangForm');
  cForm.COUPANG_ACCESS_KEY.value = data.COUPANG_ACCESS_KEY || '';
  cForm.COUPANG_SUB_ID.value = data.COUPANG_SUB_ID || '';
  cForm.COUPANG_SECRET_KEY.placeholder = data.hasCoupangSecret ? '저장됨 (변경 시에만 입력)' : '';

  disclosureTemplate = data.COUPANG_DISCLOSURE_TEMPLATE || '';
  document.getElementById('disclosureForm').template.value = disclosureTemplate;
}

document.getElementById('coupangForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('coupangMsg');
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        COUPANG_ACCESS_KEY: form.COUPANG_ACCESS_KEY.value,
        COUPANG_SECRET_KEY: form.COUPANG_SECRET_KEY.value,
        COUPANG_SUB_ID: form.COUPANG_SUB_ID.value,
      }),
    });
    if (!res.ok) throw new Error('저장 실패');
    msg.textContent = '저장 완료';
    msg.className = 'msg';
    loadSettings();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

document.getElementById('disclosureForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('disclosureMsg');
  const template = e.target.template.value;
  try {
    const res = await fetch('/api/disclosure-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    disclosureTemplate = template;
    msg.textContent = '템플릿 저장 완료';
    msg.className = 'msg';
    updateCommentPreview();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      THREADS_APP_ID: form.THREADS_APP_ID.value,
      THREADS_APP_SECRET: form.THREADS_APP_SECRET.value,
      THREADS_REDIRECT_URI: form.THREADS_REDIRECT_URI.value,
    }),
  });
  loadSettings();
  alert('저장되었습니다');
});

// ---- 초기 로드 ----
loadConnectionStatus();
loadDashboard();
loadSettings();
setInterval(loadDashboard, 30000);
