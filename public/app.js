// ================= 계정(멀티 계정) 관리 =================
let accounts = [];
let activeAccountId = Number(localStorage.getItem('activeAccountId')) || null;

function qs(params) {
  return new URLSearchParams(params).toString();
}

// accountId를 항상 붙여서 fetch하는 헬퍼
async function apiFetch(url, options = {}) {
  const hasQuery = url.includes('?');
  const withAccount = activeAccountId
    ? `${url}${hasQuery ? '&' : '?'}accountId=${activeAccountId}`
    : url;
  return fetch(withAccount, options);
}

async function loadAccounts() {
  const res = await fetch('/api/accounts');
  accounts = await res.json();

  if (!accounts.length) {
    // 계정이 하나도 없으면 처음 쓰는 것이므로 기본 계정 하나 자동 생성
    const created = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '계정 1' }),
    }).then((r) => r.json());
    activeAccountId = created.id;
    localStorage.setItem('activeAccountId', activeAccountId);
    accounts = await fetch('/api/accounts').then((r) => r.json());
  }

  if (!activeAccountId || !accounts.find((a) => a.id === activeAccountId)) {
    activeAccountId = accounts[0].id;
    localStorage.setItem('activeAccountId', activeAccountId);
  }

  renderAccountStrip();
}

function renderAccountStrip() {
  const strip = document.getElementById('accountStrip');
  strip.innerHTML = accounts
    .map(
      (a) => `
    <button class="account-chip ${a.id === activeAccountId ? 'active' : ''} ${a.connected ? 'connected' : ''}" data-id="${a.id}">
      <span class="dot"></span>${a.label}
    </button>`
    )
    .join('');

  if (accounts.length < 5) {
    strip.innerHTML += `<button class="account-chip add-chip" id="addAccountChip">+ 계정 추가</button>`;
  }

  strip.querySelectorAll('.account-chip[data-id]').forEach((chip) => {
    chip.addEventListener('click', () => switchAccount(Number(chip.dataset.id)));
  });

  const addChip = document.getElementById('addAccountChip');
  if (addChip) addChip.addEventListener('click', addAccount);
}

async function switchAccount(id) {
  if (id === activeAccountId) return;
  activeAccountId = id;
  localStorage.setItem('activeAccountId', id);
  renderAccountStrip();
  await refreshActiveTabData();
}

async function addAccount() {
  const label = prompt('새 계정 이름을 입력하세요 (예: 젠틀블루)');
  if (!label || !label.trim()) return;
  const res = await fetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: label.trim() }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '계정 추가 실패');
    return;
  }
  activeAccountId = data.id;
  localStorage.setItem('activeAccountId', activeAccountId);
  await loadAccounts();
  await refreshActiveTabData();
}

async function refreshActiveTabData() {
  loadConnectionStatus();
  loadDashboard();
  loadSettings();
  const activeTab = document.querySelector('.nav-btn.active')?.dataset.tab;
  if (activeTab === 'posts') loadPosts();
}

// ---- 계정 이름 변경/삭제 (연결 설정 탭) ----
document.getElementById('renameAccountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = e.target.label.value.trim();
  const msg = document.getElementById('accountManageMsg');
  if (!label) return;
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    msg.textContent = '이름 변경 완료';
    msg.className = 'msg';
    await loadAccounts();
    updateCurrentAccountLabel();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
  const account = accounts.find((a) => a.id === activeAccountId);
  if (!account) return;
  if (!confirm(`"${account.label}" 계정을 삭제할까요? 이 계정의 예약/발행 기록도 모두 함께 삭제됩니다.`)) return;

  await apiFetch(`/api/accounts/${activeAccountId}`, { method: 'DELETE' });
  localStorage.removeItem('activeAccountId');
  activeAccountId = null;
  await loadAccounts();
  await refreshActiveTabData();
});

function updateCurrentAccountLabel() {
  const account = accounts.find((a) => a.id === activeAccountId);
  document.getElementById('currentAccountLabel').textContent = account?.label || '–';
}

// ---- 탭 전환 (하단 네비게이션) ----
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    document.querySelector('.app-content').scrollTop = 0;
    if (btn.dataset.tab === 'posts') loadPosts();
  });
});

// ---- 연결 상태 ----
async function loadConnectionStatus() {
  const el = document.getElementById('connStatus');
  if (!activeAccountId) return;
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/connection-status`);
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
  if (!activeAccountId) return;
  const res = await apiFetch('/api/dashboard');
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

// ---- 현재 상품 컨텍스트 (AI 글 생성에 사용) ----
let currentProduct = { name: '', price: null };

// ---- AI로 본문 자동 생성 (5개 후보 중 선택) ----
document.getElementById('aiGenerateBtn').addEventListener('click', async () => {
  const btn = document.getElementById('aiGenerateBtn');
  const status = document.getElementById('aiGenerateStatus');
  const textArea = document.querySelector('#composeForm textarea[name="text"]');
  const candidatesBox = document.getElementById('aiCandidates');

  const productName = currentProduct.name || textArea.value.trim();
  if (!productName) {
    status.textContent = '먼저 상품을 검색하거나 링크를 넣어주세요';
    status.className = 'ai-status error';
    return;
  }

  btn.disabled = true;
  status.textContent = '5개 작성 중…';
  status.className = 'ai-status';
  candidatesBox.classList.add('hidden');
  candidatesBox.innerHTML = '';

  try {
    const res = await apiFetch('/api/generate-caption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productName, price: currentProduct.price }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    candidatesBox.innerHTML = data.texts
      .map(
        (t, i) => `
      <div class="ai-candidate" data-idx="${i}">
        <span class="pick-label">버전 ${i + 1} · 클릭하면 본문에 채워짐</span>
        <p>${t.replace(/</g, '&lt;')}</p>
      </div>`
      )
      .join('');
    candidatesBox.classList.remove('hidden');

    candidatesBox.querySelectorAll('.ai-candidate').forEach((card) => {
      card.addEventListener('click', () => {
        candidatesBox.querySelectorAll('.ai-candidate').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        textArea.value = data.texts[Number(card.dataset.idx)];
      });
    });

    status.textContent = `${data.texts.length}개 완성 · 마음에 드는 걸 눌러서 본문에 채우세요`;
    status.className = 'ai-status ok';
  } catch (err) {
    status.textContent = '실패: ' + err.message;
    status.className = 'ai-status error';
  } finally {
    btn.disabled = false;
  }
});

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
    const res = await apiFetch(`/api/coupang/search?keyword=${encodeURIComponent(keyword)}&limit=8`);
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
  form.video_url.value = '';
  uploadedFilename = null; // 검색 결과 이미지로 교체되므로 이전 직접 업로드 참조는 해제
  lastScrapedLink = p.url; // 자동 스크래핑이 이 링크로 또 돌지 않도록 표시
  currentProduct = { name: p.name, price: p.price };

  document.getElementById('videoPreviewBox').classList.add('hidden');
  document.getElementById('imagePreviewImg').src = p.image;
  document.getElementById('imagePreviewBox').classList.remove('hidden');
  const scrapeStatus = document.getElementById('scrapeStatus');
  scrapeStatus.textContent = '상품 검색 결과에서 링크·사진을 채웠어요 · 이제 "AI로 글 써주기"를 눌러보세요';
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

// ---- 내 사진/영상 직접 업로드 ----
let uploadedFilename = null; // 삭제 API 호출용

document.getElementById('mediaUploadInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const status = document.getElementById('uploadStatus');
  status.textContent = '업로드 중…';
  status.className = 'scrape-status loading';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await apiFetch('/api/upload-media', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    uploadedFilename = data.filename;
    const form = document.getElementById('composeForm');

    if (data.mediaType === 'video') {
      form.video_url.value = data.url;
      form.image_url.value = '';
      document.getElementById('imagePreviewBox').classList.add('hidden');
      document.getElementById('videoPreviewEl').src = data.url;
      document.getElementById('videoPreviewBox').classList.remove('hidden');
    } else {
      form.image_url.value = data.url;
      form.video_url.value = '';
      document.getElementById('videoPreviewBox').classList.add('hidden');
      document.getElementById('imagePreviewImg').src = data.url;
      document.getElementById('imagePreviewBox').classList.remove('hidden');
    }

    status.textContent = '업로드 완료';
    status.className = 'scrape-status ok';
  } catch (err) {
    status.textContent = '업로드 실패: ' + err.message;
    status.className = 'scrape-status error';
  } finally {
    e.target.value = ''; // 같은 파일 다시 선택 가능하도록
  }
});

async function removeUploadedMedia() {
  const form = document.getElementById('composeForm');
  if (uploadedFilename) {
    try {
      await fetch(`/api/upload-media/${uploadedFilename}`, { method: 'DELETE' });
    } catch {
      /* 서버에서 이미 지워졌어도 무시 */
    }
    uploadedFilename = null;
  }
  form.image_url.value = '';
  form.video_url.value = '';
  document.getElementById('imagePreviewBox').classList.add('hidden');
  document.getElementById('videoPreviewBox').classList.add('hidden');
  document.getElementById('imagePreviewImg').src = '';
  document.getElementById('videoPreviewEl').src = '';
  document.getElementById('uploadStatus').className = 'scrape-status hidden';
}

document.getElementById('removeMediaBtn').addEventListener('click', removeUploadedMedia);
document.getElementById('removeVideoBtn').addEventListener('click', removeUploadedMedia);

// ---- 링크 입력 시 상품 이미지/제목 자동 가져오기 ----
let scrapeTimer = null;
let lastScrapedLink = '';

async function runScrape(link) {
  const statusEl = document.getElementById('scrapeStatus');
  const imageInput = document.getElementById('imageUrlInput');
  const previewBox = document.getElementById('imagePreviewBox');
  const previewImg = document.getElementById('imagePreviewImg');

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

    if (data.title) {
      currentProduct = { name: data.title, price: null };
    }

    statusEl.textContent = '상품 이미지를 자동으로 채웠어요' + (data.title ? ` · "AI로 글 써주기"를 눌러보세요` : '');
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
    video_url: form.video_url.value,
    scheduled_at: new Date(form.scheduled_at.value).toISOString(),
    auto_comment_enabled: form.auto_comment_enabled.checked,
  };
  try {
    const res = await apiFetch('/api/posts', {
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
    document.getElementById('videoPreviewBox').classList.add('hidden');
    document.getElementById('uploadStatus').className = 'scrape-status hidden';
    document.getElementById('scrapeStatus').className = 'scrape-status hidden';
    document.getElementById('aiGenerateStatus').textContent = '';
    document.getElementById('aiCandidates').classList.add('hidden');
    document.getElementById('aiCandidates').innerHTML = '';
    lastScrapedLink = '';
    uploadedFilename = null;
    currentProduct = { name: '', price: null };
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
  if (!activeAccountId) return;
  const res = await apiFetch('/api/posts');
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
      await apiFetch(`/api/posts/${btn.dataset.id}`, { method: 'DELETE' });
      loadPosts();
      loadDashboard();
    });
  });
}

// ---- 설정 저장 ----
async function loadSettings() {
  if (!activeAccountId) return;
  const res = await apiFetch(`/api/accounts/${activeAccountId}/settings`);
  const data = await res.json();

  updateCurrentAccountLabel();
  document.getElementById('renameAccountForm').label.value = '';
  document.getElementById('renameAccountForm').label.placeholder = data.label || '';

  const form = document.getElementById('settingsForm');
  form.THREADS_APP_ID.value = data.THREADS_APP_ID;
  form.THREADS_REDIRECT_URI.value = data.THREADS_REDIRECT_URI;
  form.THREADS_APP_SECRET.placeholder = data.hasThreadsSecret ? '저장됨 (변경 시에만 입력)' : '';

  const cForm = document.getElementById('coupangForm');
  cForm.COUPANG_ACCESS_KEY.value = data.COUPANG_ACCESS_KEY || '';
  cForm.COUPANG_SUB_ID.value = data.COUPANG_SUB_ID || '';
  cForm.COUPANG_SECRET_KEY.placeholder = data.hasCoupangSecret ? '저장됨 (변경 시에만 입력)' : '';

  const aForm = document.getElementById('anthropicForm');
  aForm.ANTHROPIC_API_KEY.placeholder = data.hasAnthropicKey ? '저장됨 (변경 시에만 입력)' : 'sk-ant-... (변경 시에만 입력)';

  disclosureTemplate = data.COUPANG_DISCLOSURE_TEMPLATE || '';
  document.getElementById('disclosureForm').template.value = disclosureTemplate;

  document.getElementById('connectBtn').href = `/auth/login?accountId=${activeAccountId}`;
}

document.getElementById('anthropicForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('anthropicMsg');
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ANTHROPIC_API_KEY: form.ANTHROPIC_API_KEY.value }),
    });
    if (!res.ok) throw new Error('저장 실패');
    msg.textContent = '저장 완료';
    msg.className = 'msg';
    form.reset();
    loadSettings();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

document.getElementById('coupangForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('coupangMsg');
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/settings`, {
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
    const res = await apiFetch(`/api/accounts/${activeAccountId}/disclosure-template`, {
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
  await apiFetch(`/api/accounts/${activeAccountId}/settings`, {
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
(async function init() {
  await loadAccounts();
  loadConnectionStatus();
  loadDashboard();
  loadSettings();
  setInterval(loadDashboard, 30000);
})();
