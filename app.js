// ═══════════════════════════════════
//  STATE
// ═══════════════════════════════════
const STATE = {
  apiKey: '',
  model: 'moonshotai/kimi-k2-instruct-0905',
  userName: 'Learner',
  currentRoadmapId: null,
  task: '',
  roadmap: [],
  nodeStatus: [],
  totalXP: 0,
  earnedXP: 0,
  roadmaps: [],
  discoverRoadmaps: [],
  discoverSearch: '',
  discoverFilter: 'all',
  discoverGenre: 'all',
  discoverTag: '',
  currentRoadmapGenre: '',
  currentRoadmapTags: [],
  playgroundCode: '',
  playgroundLanguage: 'javascript',
  playgroundResult: '',
  playgroundBusy: false,
  chatHistory: [],
  leaderboard: [],
  activeNodeIndex: -1,
  currentQA: [],
  currentQIndex: 0,
  currentNodeForModal: -1,
};

const NIM_PROXY = '/api/nim/chat';
let generationPreviewTimer = null;
let generationPreviewStep = 0;

// ═══════════════════════════════════
//  SCREEN UTILS
// ═══════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function toast(msg, dur = 2400) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

function syncUserBadges() {
  const label = STATE.userName ? `👤 ${STATE.userName}` : '';
  ['home-user-badge', 'discover-user-badge', 'playground-user-badge'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
}

function isProgrammingRoadmap() {
  const genre = normalizeText(STATE.currentRoadmapGenre);
  const tags = (STATE.currentRoadmapTags || []).map(normalizeText);
  const programmingSignals = [
    'frontend', 'backend', 'backend/api', 'full stack', 'python', 'javascript', 'node.js',
    'react', 'sql', 'data & sql', 'machine learning', 'devops', 'testing', 'security',
    'mobile', 'algorithms', 'data science', 'api', 'sqlite', 'programming', 'code',
  ];
  return programmingSignals.some(signal => genre.includes(signal) || tags.some(tag => tag.includes(signal)));
}

function updatePlaygroundAvailability() {
  const visible = isProgrammingRoadmap();
  const buttonIds = ['hud-playground-btn', 'modal-playground-btn'];
  buttonIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  });
}

function setPlaygroundResult(html) {
  STATE.playgroundResult = html;
  const el = document.getElementById('playground-result');
  if (el) el.innerHTML = html || '<div class="empty-state">Run a check to see AI feedback here.</div>';
}

function setPlaygroundCode(code) {
  STATE.playgroundCode = code;
  const el = document.getElementById('playground-code');
  if (el) el.value = code;
}

function getPlaygroundSample(language) {
  const samples = {
    javascript: `function greet(name) {
  return 'Hello, ' + name;
}

console.log(greet('Zebri'));
`,
    typescript: `type User = {
  name: string;
  xp: number;
};

function awardXp(user: User, amount: number): User {
  return { ...user, xp: user.xp + amount };
}
`,
    python: `def greet(name):
    return f"Hello, {name}"


print(greet("Zebri"))
`,
    sql: `SELECT users.name, roadmaps.task
FROM users
JOIN roadmaps ON roadmaps.user_id = users.id
WHERE roadmaps.status = 'ready';
`,
    html: `<button class="playground-btn">Launch</button>

<style>
.playground-btn {
  background: #fde047;
}
</style>
`,
  };

  return samples[language] || samples.javascript;
}

function setPlaygroundTemplate(language) {
  STATE.playgroundLanguage = language;
  const input = document.getElementById('playground-code');
  if (input && !input.value.trim()) {
    setPlaygroundCode(getPlaygroundSample(language));
  }
}

function fillPlaygroundSample(language = STATE.playgroundLanguage) {
  STATE.playgroundLanguage = language;
  const select = document.getElementById('playground-language');
  if (select) select.value = language;
  setPlaygroundCode(getPlaygroundSample(language));
  setPlaygroundResult('');
}

function openPlayground() {
  if (!isProgrammingRoadmap()) {
    toast('Playground is only available for programming roadmaps.');
    return;
  }

  syncUserBadges();
  updatePlaygroundAvailability();
  document.getElementById('playground-title').textContent = `${STATE.task || 'Technical Playground'} · ${STATE.currentRoadmapGenre || 'Programming'}`;
  document.getElementById('playground-context').textContent = `AI checks code for ${STATE.currentRoadmapGenre || 'programming'} roadmaps.`;
  showScreen('s-playground');

  if (!STATE.playgroundCode) {
    fillPlaygroundSample(STATE.playgroundLanguage || 'javascript');
  } else {
    setPlaygroundCode(STATE.playgroundCode);
  }

  if (!STATE.playgroundResult) {
    setPlaygroundResult('<div class="empty-state">Run an AI check to get code review feedback.</div>');
  }
}

function closePlayground() {
  showScreen('s-roadmap');
}

async function checkPlaygroundCode() {
  if (!isProgrammingRoadmap()) {
    toast('Playground is only available for programming roadmaps.');
    return;
  }

  const input = document.getElementById('playground-code');
  const language = document.getElementById('playground-language').value;
  const code = (input ? input.value : STATE.playgroundCode).trim();
  if (!code) {
    toast('Add some code first.');
    return;
  }

  STATE.playgroundLanguage = language;
  STATE.playgroundCode = code;
  setPlaygroundResult('<div class="empty-state">Zebri is checking your code...</div>');

  try {
    const reply = await nimChat([
      {
        role: 'system',
        content: `You are Zebri, a strict but helpful code reviewer. Review code for correctness, runtime bugs, edge cases, style, and security only when relevant. Reply in short sections: heading, short summary, bullet list of issues, and a corrected snippet if needed. Be concise.`,
      },
      {
        role: 'user',
        content: `Roadmap: ${STATE.task}\nGenre: ${STATE.currentRoadmapGenre || 'Programming'}\nLanguage: ${language}\n\nCheck this code:\n\n${code}`,
      },
    ], 900, false);

    setPlaygroundResult(formatAiResponse(reply));
  } catch (error) {
    setPlaygroundResult(`<div class="empty-state">Code check failed: ${escapeHtml(error.message)}</div>`);
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapInlineCode(text) {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_, code) => `<code>${escapeHtml(code.trim())}</code>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\b([A-Za-z_$][\w$]*\([^)]*\))\b/g, '<code>$1</code>');
}

function formatAiResponse(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  const lines = normalized
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);

  const source = lines.length ? lines : normalized
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 6);

  const heading = source[0] || normalized || 'Zebri';
  const body = source.slice(1).map(line => `<p>${wrapInlineCode(escapeHtml(line))}</p>`).join('');
  return `<h3>${wrapInlineCode(escapeHtml(heading))}</h3>${body}`;
}

function showGenerationPreview() {
  const overlay = document.getElementById('gen-overlay');
  const label = document.getElementById('gen-step');
  const fill = document.getElementById('gen-fill');
  generationPreviewStep = 0;
  overlay.classList.add('show');
  label.textContent = 'Planning your roadmap...';
  fill.style.animation = 'none';
  void fill.offsetWidth;
  fill.style.animation = 'genfill 3s ease-in-out forwards';

  if (generationPreviewTimer) clearInterval(generationPreviewTimer);
  generationPreviewTimer = setInterval(() => {
    generationPreviewStep += 1;
    if (generationPreviewStep === 1) label.textContent = 'Analyzing your goal...';
    if (generationPreviewStep === 2) label.textContent = 'Choosing milestones...';
    if (generationPreviewStep === 3) label.textContent = 'Drafting the roadmap...';
    if (generationPreviewStep >= 4) {
      clearInterval(generationPreviewTimer);
      generationPreviewTimer = null;
    }
  }, 700);
}

function hideGenerationPreview() {
  document.getElementById('gen-overlay').classList.remove('show');
  if (generationPreviewTimer) {
    clearInterval(generationPreviewTimer);
    generationPreviewTimer = null;
  }
}

// ═══════════════════════════════════
//  NVIDIA NIM API CALL
// ═══════════════════════════════════
async function nimChat(messages, maxTokens = 1200, jsonMode = false) {
  const body = {
    messages,
    temperature: jsonMode ? 0.3 : 0.7,
  };

  body.max_tokens = maxTokens;

  const res = await fetch(NIM_PROXY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || err?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ═══════════════════════════════════
//  SCREEN 0: API KEY
// ═══════════════════════════════════
async function validateApiKey() {
  const key = document.getElementById('api-key-input').value.trim();
  const model = document.getElementById('model-select').value;
  const name = document.getElementById('user-name-input').value.trim() || 'Learner';
  const errEl = document.getElementById('api-error');
  errEl.classList.remove('show');

  if (!key || !key.startsWith('nvapi-')) {
    errEl.textContent = 'Key must start with nvapi-. Get one at build.nvidia.com';
    errEl.classList.add('show');
    return;
  }

  const btn = document.querySelector('#s-apikey .btn-primary');
  btn.textContent = 'Connecting...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, apiKey: key, model }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    STATE.apiKey = '';
    STATE.model = data?.user?.model || model;
    STATE.userName = data?.user?.name || name;
    STATE.currentRoadmapId = null;
    loadLeaderboard();
    syncUserBadges();
    document.getElementById('chat-model-label').textContent = model.substring(0, 20);
    showScreen('s-home');
    await fetchRoadmaps();
    toast('✓ Connected to NVIDIA NIM!');
  } catch (e) {
    errEl.textContent = 'Connection failed: ' + e.message;
    errEl.classList.add('show');
  } finally {
    btn.textContent = 'Connect & Start →';
    btn.disabled = false;
  }
}

// ═══════════════════════════════════
//  LEADERBOARD
// ═══════════════════════════════════
const SEED_LB = [
  { name: 'Lance K.', xp: 6000 }, { name: 'Mika T.', xp: 3990 },
  { name: 'Sam K.', xp: 3200 }, { name: 'Jordan L.', xp: 2750 },
  { name: 'Riley M.', xp: 1900 },
];

function loadLeaderboard() {
  const saved = JSON.parse(localStorage.getItem('zebri_lb') || 'null');
  STATE.leaderboard = saved || [...SEED_LB];
  renderLeaderboard();
}

function saveLeaderboard() {
  const idx = STATE.leaderboard.findIndex(e => e.name === STATE.userName);
  if (idx >= 0) STATE.leaderboard[idx].xp = Math.max(STATE.leaderboard[idx].xp, STATE.earnedXP);
  else STATE.leaderboard.push({ name: STATE.userName, xp: STATE.earnedXP });
  STATE.leaderboard.sort((a, b) => b.xp - a.xp);
  localStorage.setItem('zebri_lb', JSON.stringify(STATE.leaderboard));
  renderLeaderboard();
}

function renderLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  const ranks = ['gold', 'silver', 'bronze'];
  list.innerHTML = STATE.leaderboard.slice(0, 10).map((e, i) => {
    const isMe = e.name === STATE.userName;
    return `<div class="lb-row${isMe ? ' lb-me' : ''}">
      <div class="lb-rank ${ranks[i] || ''}">${i + 1}</div>
      <div class="lb-name">${e.name}${isMe ? ' ← you' : ''}</div>
      <div class="lb-xp">${e.xp.toLocaleString()} XP</div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════
//  SCREEN 1: HOME
// ═══════════════════════════════════
function goHome() {
  saveLeaderboard();
  renderMyRoadmaps();
  showScreen('s-home');
}

async function fetchRoadmaps() {
  try {
    const res = await fetch('/api/roadmaps', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    STATE.roadmaps = Array.isArray(data.roadmaps) ? data.roadmaps : [];
    renderMyRoadmaps();
  } catch (error) {
    toast(`Could not load roadmaps: ${error.message}`, 3000);
  }
}

async function fetchDiscoverRoadmaps() {
  try {
    const params = new URLSearchParams();
    if (STATE.discoverSearch) params.set('search', STATE.discoverSearch);
    if (STATE.discoverFilter && STATE.discoverFilter !== 'all') params.set('filter', STATE.discoverFilter);
    if (STATE.discoverGenre && STATE.discoverGenre !== 'all') params.set('genre', STATE.discoverGenre);
    if (STATE.discoverTag) params.set('tag', STATE.discoverTag);

    const query = params.toString();
    const res = await fetch(`/api/discover/roadmaps${query ? `?${query}` : ''}`, { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    STATE.discoverRoadmaps = Array.isArray(data.roadmaps) ? data.roadmaps : [];
    renderDiscoverRoadmaps();
  } catch (error) {
    toast(`Could not load Discover: ${error.message}`, 3000);
  }
}

async function refreshRoadmapLists() {
  await Promise.all([fetchRoadmaps(), fetchDiscoverRoadmaps()]);
}

function normalizeText(text) {
  return String(text || '').toLowerCase().trim();
}

function getDiscoverTagCounts(roadmaps) {
  const counts = new Map();
  roadmaps.forEach(roadmap => {
    (roadmap.tags || []).forEach(tag => {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    });
  });
  return counts;
}

function renderDiscoverFilters() {
  const search = document.getElementById('discover-search');
  const filter = document.getElementById('discover-filter');
  const genre = document.getElementById('discover-genre');
  const tagBar = document.getElementById('discover-tags');
  if (search) search.value = STATE.discoverSearch;
  if (filter) filter.value = STATE.discoverFilter;
  if (genre) genre.value = STATE.discoverGenre;

  const roadmaps = STATE.discoverRoadmaps || [];
  const tagCounts = getDiscoverTagCounts(roadmaps);
  const tags = Array.from(tagCounts.keys()).sort((a, b) => a.localeCompare(b));
  if (!tagBar) return;

  if (!tags.length) {
    tagBar.innerHTML = '<button class="discover-tag-pill active" disabled>No tags yet</button>';
    return;
  }

  tagBar.innerHTML = [
    `<button class="discover-tag-pill${STATE.discoverTag ? '' : ' active'}" onclick="setDiscoverTag('')">All Tags</button>`,
    ...tags.map(tag => `<button class="discover-tag-pill${STATE.discoverTag === tag ? ' active' : ''}" onclick="setDiscoverTag(${JSON.stringify(tag)})">${escapeHtml(tag)} <span class="discover-tag-count">${tagCounts.get(tag)}</span></button>`),
  ].join('');
}

function setDiscoverSearch(value) {
  STATE.discoverSearch = value;
  void fetchDiscoverRoadmaps();
}

function setDiscoverFilter(value) {
  STATE.discoverFilter = value;
  void fetchDiscoverRoadmaps();
}

function setDiscoverGenre(value) {
  STATE.discoverGenre = value;
  void fetchDiscoverRoadmaps();
}

function setDiscoverTag(value) {
  STATE.discoverTag = value;
  void fetchDiscoverRoadmaps();
}

function formatRatingSummary(roadmap) {
  const average = Number(roadmap.averageRating || 0);
  const count = Number(roadmap.ratingCount || 0);
  if (!count) return 'Not rated yet';
  return `★ ${average.toFixed(1)} · ${count} rating${count === 1 ? '' : 's'}`;
}

function renderStarControls(roadmap) {
  const current = Number(roadmap.myRating || 0);
  return Array.from({ length: 5 }, (_, index) => {
    const rating = index + 1;
    const active = rating <= current;
    return `<button class="roadmap-star${active ? ' active' : ''}" title="Rate ${rating} star${rating === 1 ? '' : 's'}" onclick="event.stopPropagation(); rateRoadmap(${roadmap.id}, ${rating})">★</button>`;
  }).join('');
}

function renderRoadmapCard(roadmap, options = {}) {
  const mode = options.mode || 'my';
  const openable = options.openable !== false;
  const clickable = options.clickable !== false;
  const showCopy = options.showCopy === true;
  const showDelete = options.showDelete !== false;
  const canDelete = Boolean(roadmap.canDelete);
  const done = Array.isArray(roadmap.nodeStatus) ? roadmap.nodeStatus.filter(status => status === 'done').length : 0;
  const totalSteps = Array.isArray(roadmap.roadmap) ? roadmap.roadmap.length : 0;
  const pct = totalSteps ? Math.round((done / totalSteps) * 100) : 0;
  const averageLine = `By ${escapeHtml(roadmap.ownerName || 'Unknown')} · ${formatRatingSummary(roadmap)}`;
  const genreHtml = `<span class="roadmap-genre">${escapeHtml(roadmap.genre || 'General')}</span>`;
  const tags = Array.isArray(roadmap.tags) ? roadmap.tags : [];
  const actions = [];

  if (showCopy) {
    actions.push(`<button class="roadmap-action copy" onclick="event.stopPropagation(); copyRoadmap(${roadmap.id})">Copy to My Roadmaps</button>`);
  }
  if (showDelete) {
    actions.push(`<button class="roadmap-action delete" ${canDelete ? '' : 'disabled title="Only the owner can delete this roadmap"'} onclick="event.stopPropagation(); deleteRoadmap(${roadmap.id})">Delete</button>`);
  }
  if (openable && mode === 'my' && clickable) {
    actions.unshift(`<button class="roadmap-action open" onclick="event.stopPropagation(); loadSavedRoadmap(${roadmap.id})">Open</button>`);
  }

  const clickAttr = clickable ? ` onclick="${mode === 'my' ? `loadSavedRoadmap(${roadmap.id})` : ''}"` : '';
  const cardClass = `roadmap-card${roadmap.loading || roadmap.status === 'loading' ? ' loading' : ''}${mode === 'discover' ? ' discover-card' : ''}`;
  const ratingHtml = `<div class="roadmap-rating-row">${renderStarControls(roadmap)}<span class="roadmap-rating-summary">${escapeHtml(formatRatingSummary(roadmap))}</span></div>`;
  const tagHtml = tags.length ? `<div class="roadmap-tags">${tags.map(tag => `<span class="roadmap-tag">${escapeHtml(tag)}</span>`).join('')}</div>` : '';

  if (roadmap.loading || roadmap.status === 'loading') {
    return `<div class="${cardClass}" aria-busy="true">
      <div class="rc-left">
        <div class="rc-title">${escapeHtml(roadmap.task)}</div>
        <div class="rc-meta">${escapeHtml(roadmap.loadingText || 'Planning roadmap...')}</div>
        <div class="rc-loading"><span class="rc-loading-dot"></span><span class="rc-loading-dot"></span><span class="rc-loading-dot"></span> AI is drafting it now</div>
        <div class="rc-bar-wrap"><div class="rc-bar-fill" style="width:72%"></div></div>
      </div>
      <div class="rc-side"><div class="rc-xp loading">Loading</div></div>
    </div>`;
  }

  if (roadmap.status === 'error') {
    return `<div class="${cardClass}" aria-busy="false">
      <div class="rc-left">
        <div class="rc-title">${escapeHtml(roadmap.task)}</div>
        <div class="rc-meta">Generation failed</div>
        <div class="rc-loading">${escapeHtml(roadmap.loadingText || 'Try again later')}</div>
        <div class="rc-bar-wrap"><div class="rc-bar-fill" style="width:20%;background:var(--pink)"></div></div>
      </div>
      <div class="rc-side"><div class="rc-xp loading">Error</div></div>
    </div>`;
  }

  return `<div class="${cardClass}"${clickAttr}>
    <div class="rc-left">
      <div class="rc-title">${escapeHtml(roadmap.task)}</div>
      <div class="rc-meta">${escapeHtml(averageLine)}</div>
      <div class="roadmap-submeta">${done}/${totalSteps} steps complete · ${escapeHtml(roadmap.ownerName || 'Unknown')}</div>
      <div class="roadmap-genre-row">${genreHtml}</div>
      ${tagHtml}
      ${ratingHtml}
      <div class="rc-bar-wrap"><div class="rc-bar-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="rc-side">
      <div class="rc-xp">★ ${Number(roadmap.earnedXP || 0)} XP</div>
      <div class="roadmap-actions">${actions.join('')}</div>
    </div>
  </div>`;
}

function renderMyRoadmaps() {
  const el = document.getElementById('my-roadmaps');
  const saved = STATE.roadmaps || [];
  if (!saved.length) {
    el.innerHTML = '<div class="empty-state">No roadmaps yet.<br>Create your first one to get started!</div>';
    return;
  }
  el.innerHTML = saved.map(r => renderRoadmapCard(r, { mode: 'my', openable: true, clickable: true, showCopy: false, showDelete: true })).join('');
}

function renderDiscoverRoadmaps() {
  const el = document.getElementById('discover-roadmaps');
  const saved = STATE.discoverRoadmaps || [];
  renderDiscoverFilters();

  if (!saved.length) {
    const filtersActive = Boolean(STATE.discoverSearch || STATE.discoverTag || STATE.discoverGenre !== 'all' || STATE.discoverFilter !== 'all');
    const emptyMessage = filtersActive
      ? 'No roadmaps match your search or filters.<br>Try a different tag, genre, or reset the filter.'
      : 'No public roadmaps yet.<br>Generate one or refresh later.';
    el.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }

  el.innerHTML = saved.map(r => renderRoadmapCard(r, { mode: 'discover', openable: false, clickable: false, showCopy: true, showDelete: true })).join('');
}

async function goDiscover() {
  showScreen('s-discover');
  await fetchDiscoverRoadmaps();
}

async function loadSavedRoadmap(id) {
  const local = (STATE.roadmaps || []).find(item => item.id === id);
  const r = local || await (async () => {
    const res = await fetch(`/api/roadmaps/${id}`, { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  })();

  if (r.loading || r.status === 'loading') {
    toast('This roadmap is still generating.');
    return;
  }
  if (r.status === 'error') {
    toast(r.loadingText || 'Roadmap generation failed.');
    return;
  }

  STATE.task = r.task;
  STATE.currentRoadmapId = r.id;
  STATE.currentRoadmapGenre = r.genre || '';
  STATE.currentRoadmapTags = Array.isArray(r.tags) ? r.tags : [];
  STATE.roadmap = r.roadmap;
  STATE.nodeStatus = r.nodeStatus;
  STATE.earnedXP = r.earnedXP;
  STATE.totalXP = r.totalXP;
  STATE.chatHistory = [];
  renderRoadmap();
  updateHUD();
  updatePlaygroundAvailability();
  document.getElementById('chat-msgs').innerHTML = '';
  addChatMsg('ai', `Welcome back! Continuing: <strong>${STATE.task}</strong>. You have <strong>${STATE.earnedXP} XP</strong>. Keep going!`, true);
  showScreen('s-roadmap');
}

function upsertRoadmapEntry(entry) {
  const saved = Array.isArray(STATE.roadmaps) ? [...STATE.roadmaps] : [];
  const idx = saved.findIndex(item => item.id ? item.id === entry.id : item.task === entry.task && item.loading);
  if (idx >= 0) saved[idx] = entry;
  else saved.unshift(entry);
  STATE.roadmaps = saved;
  renderMyRoadmaps();
}

function setRoadmapLoading(task, isLoading) {
  const tempId = `temp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  upsertRoadmapEntry({
    id: tempId,
    task,
    status: isLoading ? 'loading' : 'ready',
    loading: isLoading,
    loadingText: isLoading ? 'Planning roadmap...' : '',
    roadmap: [],
    nodeStatus: [],
    earnedXP: 0,
    totalXP: 0,
  });
}

// ═══════════════════════════════════
//  SCREEN 2: TASK
// ═══════════════════════════════════
function goToTaskScreen() { showScreen('s-task'); }
function setExample(text) { document.getElementById('task-input').value = text; }

async function generateRoadmap() {
  const task = document.getElementById('task-input').value.trim();
  if (!task || task.length < 8) {
    toast('Please describe your goal first!');
    return;
  }
  STATE.task = task;

  setRoadmapLoading(task, true);
  showScreen('s-home');
  toast('Roadmap request started. Browse your roadmaps while Zebri plans it.');
  try {
    const res = await fetch('/api/roadmaps/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ task }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    STATE.currentRoadmapId = data.id;
    STATE.currentRoadmapGenre = data.genre || '';
    STATE.currentRoadmapTags = Array.isArray(data.tags) ? data.tags : [];
    STATE.roadmap = data.roadmap || [];
    STATE.nodeStatus = data.nodeStatus || [];
    STATE.earnedXP = data.earnedXP || 0;
    STATE.totalXP = data.totalXP || 0;
    STATE.chatHistory = [];
    document.getElementById('chat-msgs').innerHTML = '';
    renderRoadmap();
    updateHUD();
    updatePlaygroundAvailability();
    await refreshRoadmapLists();
    toast(`Roadmap ready: ${task}`);
  } catch (e) {
    await refreshRoadmapLists();
    toast('Generation failed: ' + e.message, 4000);
    console.error(e);
  }
}

async function copyRoadmap(id) {
  try {
    const res = await fetch(`/api/roadmaps/${id}/copy`, {
      method: 'POST',
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const copied = data.roadmap;
    if (copied) {
      STATE.currentRoadmapId = copied.id;
      STATE.task = copied.task;
      STATE.currentRoadmapGenre = copied.genre || '';
      STATE.currentRoadmapTags = Array.isArray(copied.tags) ? copied.tags : [];
      STATE.roadmap = copied.roadmap || [];
      STATE.nodeStatus = copied.nodeStatus || [];
      STATE.earnedXP = copied.earnedXP || 0;
      STATE.totalXP = copied.totalXP || 0;
      STATE.chatHistory = [];
      document.getElementById('chat-msgs').innerHTML = '';
      renderRoadmap();
      updateHUD();
      updatePlaygroundAvailability();
      showScreen('s-roadmap');
    }

    await refreshRoadmapLists();
    toast('Roadmap copied to your collection.');
  } catch (error) {
    toast(`Copy failed: ${error.message}`, 3000);
  }
}

async function rateRoadmap(id, rating) {
  try {
    const res = await fetch(`/api/roadmaps/${id}/rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ rating }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await refreshRoadmapLists();
  } catch (error) {
    toast(`Rating failed: ${error.message}`, 3000);
  }
}

async function deleteRoadmap(id) {
  const ok = confirm('Delete this roadmap? This cannot be undone.');
  if (!ok) return;

  try {
    const res = await fetch(`/api/roadmaps/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (STATE.currentRoadmapId === id) {
      STATE.currentRoadmapId = null;
      STATE.currentRoadmapGenre = '';
      STATE.currentRoadmapTags = [];
      STATE.roadmap = [];
      STATE.nodeStatus = [];
      STATE.earnedXP = 0;
      STATE.totalXP = 0;
      STATE.chatHistory = [];
      document.getElementById('chat-msgs').innerHTML = '';
      updatePlaygroundAvailability();
    }

    await refreshRoadmapLists();
    renderRoadmap();
    updateHUD();
    if (STATE.currentRoadmapId === null) {
      showScreen('s-home');
    }
    toast('Roadmap deleted.');
  } catch (error) {
    toast(`Delete failed: ${error.message}`, 3000);
  }
}

// ═══════════════════════════════════
//  ROADMAP RENDERING
// ═══════════════════════════════════
const POSITIONS = ['l', 'r', 'l', 'r', 'c', 'l', 'r', 'l', 'r', 'c'];

function renderRoadmap() {
  const track = document.getElementById('roadmap-track');
  track.innerHTML = '<div class="spine"></div>';

  const chapters = [
    { label: 'Chapter 1 — Foundations', from: 0, to: 4 },
    { label: 'Chapter 2 — Core Skills', from: 5, to: 9 },
  ];

  STATE.roadmap.forEach((node, i) => {
    const ch = chapters.find(c => i >= c.from && i <= c.to);
    if (ch && i === ch.from) {
      const sl = document.createElement('div');
      sl.className = 'sec-label';
      sl.innerHTML = `<div class="sec-pill">${ch.label}</div>`;
      track.appendChild(sl);
    }

    const status = STATE.nodeStatus[i];
    const pos = POSITIONS[i] || 'c';
    const typeClass = node.type === 'boss' ? 'boss' : node.type === 'bonus' ? 'bonus' : '';

    const row = document.createElement('div');
    row.className = `node-row ${pos}`;
    row.style.animationDelay = `${i * 0.06}s`;

    const nodeEl = document.createElement('div');
    nodeEl.className = `node ${status} ${typeClass}`;
    nodeEl.style.animationDelay = `${i * 0.07}s`;
    nodeEl.onclick = () => onNodeClick(i);

    nodeEl.innerHTML = `
      ${status === 'done' ? '<div class="node-check">✓</div>' : ''}
      <div class="node-inner">
        <span class="node-icon">${node.icon || '📌'}</span>
        <div class="node-title">${node.title}</div>
        <div class="node-sub">${status === 'locked' ? 'Locked' : status === 'done' ? 'Completed' : status === 'active' ? 'In progress' : ''}</div>
        <div class="node-xp">+${node.xp || 100} XP</div>
      </div>`;

    row.appendChild(nodeEl);
    track.appendChild(row);

    if (i < STATE.roadmap.length - 1) {
      const sp = document.createElement('div');
      sp.className = 'spacer';
      track.appendChild(sp);
    }
  });
}

function updateHUD() {
  const done = STATE.nodeStatus.filter(s => s === 'done').length;
  const pct = STATE.roadmap.length ? Math.round((done / STATE.roadmap.length) * 100) : 0;
  const level = Math.floor(done / 2) + 1;
  document.getElementById('hud-xp').textContent = STATE.earnedXP.toLocaleString() + ' XP';
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('prog-label').textContent = `Level ${level} · ${pct}% complete (${done}/${STATE.roadmap.length} steps)`;
}

// ═══════════════════════════════════
//  NODE CLICK
// ═══════════════════════════════════
function onNodeClick(i) {
  const status = STATE.nodeStatus[i];
  const node = STATE.roadmap[i];

  if (status === 'locked') {
    toast('🔒 Finish the previous step first!');
    addChatMsg('ai', `<strong>${node.title}</strong> is still locked. Complete the current active step to unlock it!`, true);
    return;
  }

  if (status === 'done') {
    addChatMsg('ai', `You've already completed <strong>${node.title}</strong> and earned +${node.xp} XP. Want me to explain it again or quiz you?`, true);
    document.getElementById('prompt-ctx').textContent = 'Context: ' + node.title;
    return;
  }

  STATE.currentNodeForModal = i;
  document.getElementById('modal-node-name').textContent = node.icon + ' ' + node.title;
  document.getElementById('modal-node-desc').textContent = node.desc || '';
  showModal('modal-pol');
  document.getElementById('prompt-ctx').textContent = 'Context: ' + node.title;
}

// ═══════════════════════════════════
//  PLAY MODE (Q&A)
// ═══════════════════════════════════
function startPlay() {
  closeModal('modal-pol');
  const i = STATE.currentNodeForModal;
  const node = STATE.roadmap[i];
  if (!node.qa || !node.qa.length) {
    toast('No quiz for this node yet!');
    return;
  }
  STATE.currentQA = node.qa;
  STATE.currentQIndex = 0;
  document.getElementById('qna-node-name').textContent = node.icon + ' ' + node.title;
  renderQNA();
  showModal('modal-qna');
}

function renderQNA() {
  const q = STATE.currentQA[STATE.currentQIndex];
  if (!q) return;
  document.getElementById('qna-progress').textContent = `Q ${STATE.currentQIndex + 1}/${STATE.currentQA.length}`;
  document.getElementById('qna-question').textContent = q.q;
  document.getElementById('qna-feedback').className = 'qna-feedback';
  document.getElementById('qna-feedback').textContent = '';
  document.getElementById('qna-next-btn').style.display = 'none';

  const opts = document.getElementById('qna-options');
  opts.innerHTML = q.opts.map((o, oi) =>
    `<button class="qna-opt" onclick="answerQNA(${oi})">${String.fromCharCode(65 + oi)}. ${o}</button>`
  ).join('');
}

function answerQNA(chosen) {
  const q = STATE.currentQA[STATE.currentQIndex];
  const correct = q.ans;
  const optBtns = document.querySelectorAll('.qna-opt');
  optBtns.forEach((b, i) => {
    b.onclick = null;
    if (i === correct) b.classList.add('correct');
    else if (i === chosen && chosen !== correct) b.classList.add('wrong');
  });
  const fb = document.getElementById('qna-feedback');
  if (chosen === correct) {
    fb.textContent = '✓ Correct! Well done.';
    fb.className = 'qna-feedback show ok';
  } else {
    fb.textContent = `✗ Wrong. Correct: ${String.fromCharCode(65 + correct)}. ${q.opts[correct]}`;
    fb.className = 'qna-feedback show bad';
  }
  document.getElementById('qna-next-btn').style.display = 'block';
}

function nextQuestion() {
  STATE.currentQIndex++;
  if (STATE.currentQIndex >= STATE.currentQA.length) {
    closeModal('modal-qna');
    completeNode(STATE.currentNodeForModal);
    toast('🎉 Quiz complete! XP earned!', 3000);
  } else {
    renderQNA();
  }
}

// ═══════════════════════════════════
//  LEARN MODE (AI explanation)
// ═══════════════════════════════════
async function startLearn() {
  closeModal('modal-pol');
  const i = STATE.currentNodeForModal;
  const node = STATE.roadmap[i];
  addChatMsg('user', `Teach me about: ${node.title}`);
  showTyping();
  try {
    const reply = await nimChat([
      {
        role: 'system',
        content: `You are Zebri, a concise learning tutor. Reply with at most 4 short lines: 1) Heading, 2) Subheading, 3) one short paragraph, 4) bullet points when useful. Wrap any code in backticks only. No filler, no markdown.`
      },
      {
        role: 'user',
        content: `Explain this learning step for someone studying "${STATE.task}": "${node.title}" — ${node.desc}`
      }
    ], 400);
    hideTyping();
    addChatMsg('ai', reply);
    setTimeout(() => {
      addChatMsg('ai', `Ready to test yourself? Tap the <strong>${node.icon} ${node.title}</strong> node and choose <strong>Play Quiz</strong>. You earn <strong>+${node.xp} XP</strong> when you finish.`, true);
    }, 800);
  } catch (e) {
    hideTyping();
    addChatMsg('ai', `Request failed: ${e.message}. Try again.`);
  }
}

// ═══════════════════════════════════
//  NODE COMPLETE
// ═══════════════════════════════════
function completeNode(i) {
  const node = STATE.roadmap[i];
  STATE.nodeStatus[i] = 'done';
  STATE.earnedXP += node.xp || 100;

  const next = i + 1;
  if (next < STATE.roadmap.length && STATE.nodeStatus[next] === 'locked') {
    STATE.nodeStatus[next] = 'active';
  }

  renderRoadmap();
  updateHUD();
  saveCurrentRoadmap();
  saveLeaderboard();

  addChatMsg('ai', `Done: <strong>${node.title}</strong>. You earned <strong>+${node.xp} XP</strong>, bringing you to <strong>${STATE.earnedXP} XP</strong>.${next < STATE.roadmap.length ? ` Next: <strong>${STATE.roadmap[next].title}</strong>.` : ' Roadmap complete.'}`, true);

  const allDone = STATE.nodeStatus.every(s => s === 'done');
  if (allDone) {
    setTimeout(() => {
      toast('🏆 ROADMAP COMPLETE! Leaderboard updated!', 4000);
      saveLeaderboard();
    }, 1200);
  }
}

// ═══════════════════════════════════
//  CHAT
// ═══════════════════════════════════
function addChatMsg(role, html, rawHtml = false) {
  const container = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const bubbleHtml = role === 'ai'
    ? (rawHtml ? html : formatAiResponse(html))
    : `<p>${escapeHtml(html).replace(/\n/g, '<br>')}</p>`;
  div.innerHTML = `<div class="msg-label">${role === 'user' ? STATE.userName : 'Zebri'}</div><div class="msg-bubble">${bubbleHtml}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showTyping() { document.getElementById('typing').classList.add('show'); }
function hideTyping() { document.getElementById('typing').classList.remove('show'); }


async function saveCurrentRoadmap() {
  if (!STATE.currentRoadmapId) return;
  try {
    await fetch(`/api/roadmaps/${STATE.currentRoadmapId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        roadmap: STATE.roadmap,
        nodeStatus: STATE.nodeStatus,
        earnedXP: STATE.earnedXP,
        totalXP: STATE.totalXP,
        status: 'ready',
      }),
    });
  } catch {
    // Best effort; the user-facing state is already updated.
  }
}
async function sendChat() {
  const el = document.getElementById('chat-input');
  const text = el.value.trim();
  if (!text) return;
  el.value = '';
  addChatMsg('user', text);
  showTyping();

  const activeIdx = STATE.nodeStatus.findIndex(s => s === 'active');
  const activeNode = activeIdx >= 0 ? STATE.roadmap[activeIdx] : null;
  const done = STATE.nodeStatus.filter(s => s === 'done').length;

  const sysPrompt = `You are Zebri, a concise AI guide. Reply with at most 4 short lines: 1) Heading, 2) Subheading, 3) one short paragraph, 4) bullet points when useful. Wrap any code in backticks only. No filler, no markdown. The user is working on: "${STATE.task}". They have completed ${done}/${STATE.roadmap.length} steps and earned ${STATE.earnedXP} XP. Current active step: ${activeNode ? `"${activeNode.title}" — ${activeNode.desc}` : 'All steps locked/done'}.`;

  STATE.chatHistory.push({ role: 'user', content: text });
  if (STATE.chatHistory.length > 12) STATE.chatHistory = STATE.chatHistory.slice(-12);

  try {
    const reply = await nimChat([
      { role: 'system', content: sysPrompt },
      ...STATE.chatHistory,
    ], 300);
    hideTyping();
    STATE.chatHistory.push({ role: 'assistant', content: reply });
    addChatMsg('ai', reply);
  } catch (e) {
    hideTyping();
    addChatMsg('ai', `Request failed: ${e.message}. Try again.`);
  }
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
}

function quickChip(text) {
  document.getElementById('chat-input').value = text;
  sendChat();
}

// ═══════════════════════════════════
//  PROFILE
// ═══════════════════════════════════
function showProfile() {
  const done = STATE.nodeStatus.filter(s => s === 'done').length;
  const rank = STATE.leaderboard.findIndex(e => e.name === STATE.userName) + 1 || '?';
  addChatMsg('ai', `<strong>👤 ${STATE.userName}</strong> has <strong>${STATE.earnedXP}</strong> XP this session. Steps done: <strong>${done}/${STATE.roadmap.length}</strong>. Rank: <strong>#${rank}</strong>.`, true);
}

// ═══════════════════════════════════
//  LOGOUT
// ═══════════════════════════════════
function logout() {
  saveLeaderboard();
  fetch('/api/session/logout', {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {});
  saveCurrentRoadmap();
  STATE.apiKey = '';
  STATE.currentRoadmapId = null;
  STATE.chatHistory = [];
  STATE.roadmaps = [];
  STATE.discoverRoadmaps = [];
  STATE.roadmap = [];
  STATE.nodeStatus = [];
  STATE.earnedXP = 0;
  STATE.totalXP = 0;
  document.getElementById('api-key-input').value = '';
  document.getElementById('task-input').value = '';
  document.getElementById('chat-msgs').innerHTML = '';
  syncUserBadges();
  renderMyRoadmaps();
  renderDiscoverRoadmaps();
  showScreen('s-apikey');
  toast('Logged out. Progress saved.');
}

async function bootstrapApp() {
  try {
    const res = await fetch('/api/session/me', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (!data.loggedIn) {
      showScreen('s-apikey');
      return;
    }
    STATE.userName = data.user?.name || STATE.userName;
    STATE.model = data.user?.model || STATE.model;
    STATE.apiKey = '';
    syncUserBadges();
    document.getElementById('chat-model-label').textContent = STATE.model.substring(0, 20);
    loadLeaderboard();
    showScreen('s-home');
    await fetchRoadmaps();
    updatePlaygroundAvailability();
    renderDiscoverRoadmaps();
  } catch {
    showScreen('s-apikey');
  }
}

bootstrapApp();
