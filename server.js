const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'zebri.sqlite');
const NIM_BASE = 'https://integrate.api.nvidia.com/v1';
const SESSION_COOKIE = 'zebri_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const APP_SECRET = crypto.createHash('sha256').update(String(process.env.ZEBRI_SECRET || ROOT)).digest();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  send(res, statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }, JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, pair) => {
    const index = pair.indexOf('=');
    if (index === -1) return acc;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.maxAge) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.secure) parts.push('Secure');
  const header = res.getHeader('Set-Cookie');
  const next = Array.isArray(header) ? header.concat(parts.join('; ')) : header ? [header, parts.join('; ')] : [parts.join('; ')];
  res.setHeader('Set-Cookie', next);
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

function nowIso() {
  return new Date().toISOString();
}

function encryptApiKey(apiKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', APP_SECRET, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actualHash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  const actual = Buffer.from(actualHash, 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function normalizeLoginInput(body = {}) {
  const loginId = String(body.loginId || body.identifier || body.name || body.email || '').trim();
  const emailFromBody = String(body.email || '').trim().toLowerCase();
  const email = emailFromBody || (loginId.includes('@') ? loginId.toLowerCase() : '');
  const name = String(body.name || '').trim() || (loginId.includes('@') ? loginId.split('@')[0] : loginId) || 'Learner';

  return {
    loginId,
    email,
    name,
    password: String(body.password || ''),
    apiKey: String(body.apiKey || '').trim(),
    model: String(body.model || 'meta/llama-3.3-70b-instruct').trim(),
  };
}

async function ensureUserSchema() {
  await ensureColumn('users', 'email', 'TEXT');
  await ensureColumn('users', 'password_hash', 'TEXT');
  await ensureColumn('users', 'password_salt', 'TEXT');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != ""');
}

function decryptApiKey(value) {
  const raw = String(value || '');
  if (!raw.startsWith('enc:')) return raw;

  const payload = Buffer.from(raw.slice(4), 'base64');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', APP_SECRET, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function normalizeSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s+.#/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferRoadmapGenre(task, roadmap = []) {
  const text = normalizeSearchText(task + ' ' + roadmap.map(node => `${node.title || ''} ${node.desc || ''}`).join(' '));
  const genreRules = [
    ['machine learning|\bml\b|neural|ai|artificial intelligence', 'Machine Learning'],
    ['full stack|full-stack', 'Full Stack'],
    ['frontend|react|ui|ux|html|css|javascript|js', 'Frontend'],
    ['backend|node|api|express|server', 'Backend/API'],
    ['python|django|flask', 'Python'],
    ['sql|sqlite|database|query|schema', 'Data & SQL'],
    ['devops|docker|kubernetes|ci/cd|infra', 'DevOps'],
    ['testing|qa|jest|cypress|unit test', 'Testing'],
    ['security|auth|oauth|jwt|penetration', 'Security'],
    ['mobile|android|ios|react native|flutter', 'Mobile'],
    ['algorithms|data structures|coding interview', 'Algorithms'],
    ['data science|analytics|pandas|numpy', 'Data Science'],
  ];

  for (const [pattern, genre] of genreRules) {
    if (new RegExp(pattern, 'i').test(text)) return genre;
  }

  return 'General';
}

function buildRoadmapMetadata(task, roadmap = []) {
  const genre = inferRoadmapGenre(task, roadmap);
  const tags = new Set([genre]);
  const text = normalizeSearchText(task);
  const patterns = [
    ['javascript', 'JavaScript'],
    ['js', 'JavaScript'],
    ['react', 'React'],
    ['node', 'Node.js'],
    ['python', 'Python'],
    ['sql', 'SQL'],
    ['sqlite', 'SQLite'],
    ['api', 'API'],
    ['frontend', 'Frontend'],
    ['backend', 'Backend'],
    ['full stack', 'Full Stack'],
    ['machine learning', 'Machine Learning'],
    ['ml', 'Machine Learning'],
    ['data', 'Data'],
    ['devops', 'DevOps'],
    ['testing', 'Testing'],
  ];

  patterns.forEach(([needle, label]) => {
    if (text.includes(needle)) tags.add(label);
  });

  roadmap.forEach(node => {
    const nodeText = normalizeSearchText(`${node.title || ''} ${node.desc || ''}`);
    if (!nodeText) return;
    if (node.type === 'boss') tags.add('Boss Level');
    if (node.type === 'bonus') tags.add('Bonus Node');
    if (nodeText.includes('quiz')) tags.add('Quiz');
    if (nodeText.includes('project')) tags.add('Project');
    if (nodeText.includes('build')) tags.add('Build');
    if (nodeText.includes('learn')) tags.add('Learn');
  });

  if (roadmap.length >= 8) tags.add('Long Form');
  if (!tags.size) tags.add('General');

  const tagList = Array.from(tags).slice(0, 8);
  const searchText = normalizeSearchText([
    task,
    genre,
    ...tagList,
    ...roadmap.map(node => `${node.title || ''} ${node.desc || ''}`),
  ].join(' '));

  return { genre, tags: tagList, searchText };
}

function buildRoadmapOverview(task, roadmap = []) {
  const genre = inferRoadmapGenre(task, roadmap);
  const highlights = roadmap
    .slice(0, 3)
    .map(node => node.title)
    .filter(Boolean)
    .join(', ');

  if (highlights) {
    return `A ${genre.toLowerCase()} roadmap for ${task} that starts with ${highlights}.`;
  }

  return `A ${genre.toLowerCase()} roadmap for ${task}.`;
}

function buildRoadmapTitle(task, roadmap = []) {
  const source = normalizeSearchText(task).replace(/\bsource excerpt\b.*$/i, '').trim();
  const firstLine = String(task || '').split(/\n+/)[0].replace(/reference file.*$/i, '').trim();
  const genre = inferRoadmapGenre(task, roadmap);
  const keywords = roadmap.slice(0, 2).map(node => node.title).filter(Boolean);

  const title = firstLine || source || keywords.join(' ');
  if (!title) return `${genre} roadmap`;

  const words = title.split(/\s+/).filter(Boolean).slice(0, 8);
  const concise = words.join(' ');
  return concise.length > 52 ? `${concise.slice(0, 49).trim()}…` : concise;
}

function parseChatHistory(value) {
  const entries = parseJsonArray(value);
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(entry => entry && typeof entry === 'object')
    .map(entry => ({
      role: String(entry.role || 'assistant'),
      content: String(entry.content || ''),
      rawHtml: Boolean(entry.rawHtml),
    }));
}

function buildPlaygroundExample(title, desc, task) {
  const text = normalizeSearchText(`${title} ${desc} ${task}`);

  if (/sort|order|ranking/.test(text)) {
    return 'Example problem: Build a function that takes [8, 3, 5, 1] and returns [1, 3, 5, 8].';
  }
  if (/fetch|api|request|network/.test(text)) {
    return 'Example problem: Fetch a list of users from an API endpoint and render their names on the page.';
  }
  if (/form|input|validation|submit/.test(text)) {
    return 'Example problem: Create a form that only submits when the email field is valid and shows a clear error otherwise.';
  }
  if (/array|loop|iterate|count|filter/.test(text)) {
    return 'Example problem: Given [2, 4, 7, 9], return only the even numbers using one loop or array helper.';
  }
  if (/class|object|method|constructor/.test(text)) {
    return 'Example problem: Create a small class that stores a user name and returns a greeting with a method.';
  }

  return `Example problem: Build a small solution for "${title}" using the idea described in the step.`;
}

function buildPlaygroundChallenge(task, node, index) {
  const title = String(node?.title || `Step ${index + 1}`).trim();
  const desc = String(node?.desc || '').trim();
  const goal = desc || `Demonstrate ${title.toLowerCase()}`;
  const example = buildPlaygroundExample(title, desc, task);
  return {
    prompt: `Build or fix code for this step: ${title}. Goal: ${goal}.`,
    acceptance: `The code should show a working solution for ${title} and match the described goal.`,
    starter: `Start from the task: ${title}. Focus on ${goal}.`,
    example,
  };
}

function nodeRequiresPlayground(task, node, index, roadmap = []) {
  const text = normalizeSearchText(`${task} ${node.title || ''} ${node.desc || ''}`);
  const programmingSignals = /code|build|implement|execute|debug|deploy|project|html|css|javascript|typescript|python|sql|react|node|api|function|class|loop|algorithm|program/i;
  if (!programmingSignals.test(text)) return false;
  if (node.type === 'boss') return true;
  return [2, 5, 8].includes(index) || /execute|build|implement|debug|project/.test(text);
}


function assignRoadmapModes(task, roadmap = []) {
  return roadmap.map((node, index) => ({
    ...node,
    mode: nodeRequiresPlayground(task, node, index, roadmap) ? 'playground' : 'quiz',
    playground: nodeRequiresPlayground(task, node, index, roadmap) ? buildPlaygroundChallenge(task, node, index) : null,
  }));
}

async function ensureColumn(table, column, definition) {
  const rows = await all(`PRAGMA table_info(${table})`);
  if (!rows.some(row => row.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureRoadmapSchema() {
  await ensureColumn('roadmaps', 'genre', "TEXT NOT NULL DEFAULT 'General'");
  await ensureColumn('roadmaps', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn('roadmaps', 'search_text', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('roadmaps', 'overview', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('roadmaps', 'chat_history_json', "TEXT NOT NULL DEFAULT '[]'");

  await run(`
    CREATE TABLE IF NOT EXISTS roadmap_tags (
      roadmap_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (roadmap_id, tag),
      FOREIGN KEY(roadmap_id) REFERENCES roadmaps(id) ON DELETE CASCADE
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_roadmaps_status_created ON roadmaps(status, created_at DESC)');
  await run('CREATE INDEX IF NOT EXISTS idx_roadmaps_genre ON roadmaps(genre)');
  await run('CREATE INDEX IF NOT EXISTS idx_roadmaps_user_created ON roadmaps(user_id, created_at DESC)');
  await run('CREATE INDEX IF NOT EXISTS idx_roadmap_tags_tag ON roadmap_tags(tag)');
  await run('CREATE INDEX IF NOT EXISTS idx_roadmap_tags_roadmap ON roadmap_tags(roadmap_id)');
}

async function ensurePomodoroSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      roadmap_id INTEGER,
      task TEXT NOT NULL,
      node_title TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      remaining_seconds INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(roadmap_id) REFERENCES roadmaps(id) ON DELETE SET NULL
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_pomodoro_user_status ON pomodoro_sessions(user_id, status)');
  await run('CREATE INDEX IF NOT EXISTS idx_pomodoro_updated ON pomodoro_sessions(updated_at DESC)');
}

async function syncRoadmapTags(roadmapId, tags = []) {
  await run('DELETE FROM roadmap_tags WHERE roadmap_id = ?', [roadmapId]);
  for (const tag of tags) {
    await run('INSERT OR IGNORE INTO roadmap_tags (roadmap_id, tag) VALUES (?, ?)', [roadmapId, tag]);
  }
}

async function backfillRoadmapMetadata() {
  const rows = await all('SELECT id, task, roadmap_json, genre, tags_json, search_text, overview FROM roadmaps');
  for (const row of rows) {
    const roadmap = parseJsonArray(row.roadmap_json);
    const metadata = buildRoadmapMetadata(row.task, roadmap);
    const overview = String(row.overview || '').trim() || buildRoadmapOverview(row.task, roadmap);
    const currentTags = JSON.stringify(parseJsonArray(row.tags_json));
    const nextTags = JSON.stringify(metadata.tags);
    const currentGenre = String(row.genre || '');
    const currentSearch = String(row.search_text || '');
    const currentOverview = String(row.overview || '');
    if (currentGenre !== metadata.genre || currentTags !== nextTags || currentSearch !== metadata.searchText || currentOverview !== overview) {
      await run(
        `
          UPDATE roadmaps
          SET genre = ?, tags_json = ?, search_text = ?, overview = ?
          WHERE id = ?
        `,
        [metadata.genre, nextTags, metadata.searchText, overview, row.id]
      );
    }
    await syncRoadmapTags(row.id, metadata.tags);
  }
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

const pomodoroClients = new Map();
const pomodoroSessions = new Map();

function buildTrackerUrl(req, token) {
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || `localhost:${PORT}`}`;
  return `${origin}/tracker.html?token=${encodeURIComponent(token)}`;
}

function hydratePomodoroSession(row) {
  if (!row) return null;
  return {
    token: row.token,
    userId: row.user_id,
    roadmapId: row.roadmap_id,
    task: row.task,
    nodeTitle: row.node_title,
    durationSeconds: Number(row.duration_seconds || 1500),
    remainingSeconds: Number(row.remaining_seconds || 1500),
    status: row.status || 'running',
    startedAt: Number(row.started_at || Date.now()),
    updatedAt: Number(row.updated_at || Date.now()),
    endsAt: Number(row.ends_at || Date.now()),
  };
}

function computePomodoroRemaining(session, now = Date.now()) {
  if (!session) return 0;
  if (session.status === 'running') {
    return Math.max(0, Math.ceil((session.endsAt - now) / 1000));
  }
  return Math.max(0, Number(session.remainingSeconds || 0));
}

function snapshotPomodoroSession(session, now = Date.now()) {
  const remainingSeconds = computePomodoroRemaining(session, now);
  const status = session.status === 'running' && remainingSeconds <= 0 ? 'completed' : session.status;
  return {
    token: session.token,
    roadmapId: session.roadmapId,
    task: session.task,
    nodeTitle: session.nodeTitle,
    durationSeconds: Number(session.durationSeconds || 1500),
    remainingSeconds,
    status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    endsAt: session.endsAt,
    progress: Math.max(0, Math.min(1, 1 - (remainingSeconds / Math.max(1, Number(session.durationSeconds || 1500))))),
  };
}

async function savePomodoroSession(session) {
  const timestamp = Date.now();
  await run(
    `
      INSERT INTO pomodoro_sessions (token, user_id, roadmap_id, task, node_title, duration_seconds, remaining_seconds, status, started_at, updated_at, ends_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        roadmap_id = excluded.roadmap_id,
        task = excluded.task,
        node_title = excluded.node_title,
        duration_seconds = excluded.duration_seconds,
        remaining_seconds = excluded.remaining_seconds,
        status = excluded.status,
        updated_at = excluded.updated_at,
        ends_at = excluded.ends_at
    `,
    [
      session.token,
      session.userId,
      session.roadmapId || null,
      session.task,
      session.nodeTitle,
      session.durationSeconds,
      session.remainingSeconds,
      session.status,
      session.startedAt,
      timestamp,
      session.endsAt,
    ]
  );
  session.updatedAt = timestamp;
  pomodoroSessions.set(session.token, session);
  return session;
}

async function loadPomodoroSession(token) {
  if (pomodoroSessions.has(token)) return pomodoroSessions.get(token);
  const row = await get('SELECT * FROM pomodoro_sessions WHERE token = ?', [token]);
  const session = hydratePomodoroSession(row);
  if (session) pomodoroSessions.set(token, session);
  return session;
}

function getPomodoroClients(token) {
  if (!pomodoroClients.has(token)) {
    pomodoroClients.set(token, new Set());
  }
  return pomodoroClients.get(token);
}

function sendWebSocketFrame(socket, message) {
  const payload = Buffer.from(String(message));
  let header;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

function broadcastPomodoroSnapshot(session) {
  const snapshot = snapshotPomodoroSession(session);
  const clients = pomodoroClients.get(session.token);
  if (!clients || !clients.size) return snapshot;

  const payload = JSON.stringify({ type: 'snapshot', snapshot });
  for (const socket of clients) {
    if (!socket.destroyed) {
      sendWebSocketFrame(socket, payload);
    }
  }
  return snapshot;
}

async function completeExpiredPomodoroSession(session) {
  if (!session || session.status !== 'running') return session;
  const remaining = computePomodoroRemaining(session);
  if (remaining > 0) return session;

  session.status = 'completed';
  session.remainingSeconds = 0;
  session.endsAt = Date.now();
  await savePomodoroSession(session);
  return session;
}

async function tickPomodoroSessions() {
  const sessions = Array.from(pomodoroSessions.values());
  for (const session of sessions) {
    if (session.status !== 'running') continue;
    const remaining = computePomodoroRemaining(session);
    if (remaining <= 0) {
      session.status = 'completed';
      session.remainingSeconds = 0;
      session.endsAt = Date.now();
      await savePomodoroSession(session);
      broadcastPomodoroSnapshot(session);
    }
  }
}

async function handlePomodoroStart(req, res) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const durationMinutes = Math.max(5, Math.min(90, Number(body.durationMinutes || 25) || 25));
  const durationSeconds = Math.round(durationMinutes * 60);
  const token = randomToken();
  const startedAt = Date.now();
  const pomodoroSession = {
    token,
    userId: session.user_id,
    roadmapId: Number(body.roadmapId || 0) || null,
    task: String(body.task || 'Focus Session').trim() || 'Focus Session',
    nodeTitle: String(body.nodeTitle || 'Pomodoro').trim() || 'Pomodoro',
    durationSeconds,
    remainingSeconds: durationSeconds,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    endsAt: startedAt + durationSeconds * 1000,
  };

  await savePomodoroSession(pomodoroSession);
  const snapshot = broadcastPomodoroSnapshot(pomodoroSession);
  sendJson(res, 200, {
    token,
    trackerUrl: buildTrackerUrl(req, token),
    snapshot,
  });
}

async function handlePomodoroAction(req, res, token) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  const pomodoroSession = await loadPomodoroSession(token);
  if (!pomodoroSession) {
    sendJson(res, 404, { error: 'Pomodoro session not found' });
    return;
  }

  if (pomodoroSession.userId !== session.user_id) {
    sendJson(res, 403, { error: 'Not allowed' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const action = String(body.action || '').trim();
  const now = Date.now();

  if (action === 'pause' && pomodoroSession.status === 'running') {
    pomodoroSession.remainingSeconds = computePomodoroRemaining(pomodoroSession, now);
    pomodoroSession.status = 'paused';
    pomodoroSession.endsAt = now + pomodoroSession.remainingSeconds * 1000;
  } else if (action === 'resume' && pomodoroSession.status === 'paused') {
    pomodoroSession.status = 'running';
    pomodoroSession.endsAt = now + Number(pomodoroSession.remainingSeconds || pomodoroSession.durationSeconds) * 1000;
  } else if (action === 'reset') {
    pomodoroSession.status = 'running';
    pomodoroSession.remainingSeconds = pomodoroSession.durationSeconds;
    pomodoroSession.startedAt = now;
    pomodoroSession.endsAt = now + pomodoroSession.durationSeconds * 1000;
  } else if (action === 'complete') {
    pomodoroSession.status = 'completed';
    pomodoroSession.remainingSeconds = 0;
    pomodoroSession.endsAt = now;
  } else {
    sendJson(res, 400, { error: 'Unsupported pomodoro action' });
    return;
  }

  await savePomodoroSession(pomodoroSession);
  sendJson(res, 200, { snapshot: broadcastPomodoroSnapshot(pomodoroSession) });
}

async function handlePomodoroGet(req, res, token) {
  const pomodoroSession = await loadPomodoroSession(token);
  if (!pomodoroSession) {
    sendJson(res, 404, { error: 'Pomodoro session not found' });
    return;
  }

  const snapshot = await completeExpiredPomodoroSession(pomodoroSession);
  sendJson(res, 200, { snapshot: snapshotPomodoroSession(snapshot) });
}

async function handlePomodoroUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  if (url.pathname !== '/ws/pomodoro') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  if (!token) {
    socket.destroy();
    return;
  }

  const pomodoroSession = await loadPomodoroSession(token);
  if (!pomodoroSession) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto.createHash('sha1')
    .update(String(req.headers['sec-websocket-key'] || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    '',
  ].join('\r\n'));

  const clients = getPomodoroClients(token);
  clients.add(socket);

  const snapshot = snapshotPomodoroSession(pomodoroSession);
  sendWebSocketFrame(socket, JSON.stringify({ type: 'snapshot', snapshot }));

  socket.on('data', () => {});
  socket.on('close', () => {
    clients.delete(socket);
    if (!clients.size) pomodoroClients.delete(token);
  });
  socket.on('error', () => {
    clients.delete(socket);
    if (!clients.size) pomodoroClients.delete(token);
  });
}

async function initDb() {
  await run('PRAGMA foreign_keys = ON');
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await ensureUserSchema();
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS roadmaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      loading_text TEXT,
      roadmap_json TEXT,
      node_status_json TEXT,
      chat_history_json TEXT NOT NULL DEFAULT '[]',
      earned_xp INTEGER NOT NULL DEFAULT 0,
      total_xp INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await ensureRoadmapSchema();
  await ensurePomodoroSchema();
  await run(`
    CREATE TABLE IF NOT EXISTS roadmap_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roadmap_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(roadmap_id, user_id),
      FOREIGN KEY(roadmap_id) REFERENCES roadmaps(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await backfillRoadmapMetadata();
}

async function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const row = await get(
    `
      SELECT sessions.token, sessions.expires_at, users.id AS user_id, users.name, users.email, users.api_key, users.model, users.password_hash, users.password_salt
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ? AND sessions.expires_at > ?
    `,
    [token, Date.now()]
  );

  if (row) {
    row.api_key = decryptApiKey(row.api_key);
  }
  return row || null;
}

async function callNim(apiKey, model, messages, maxTokens = 1200, temperature = 0.7) {
  const response = await fetch(`${NIM_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }

  return JSON.parse(text).choices[0].message.content;
}

async function verifyNimLogin(apiKey, model) {
  await callNim(apiKey, model, [{ role: 'user', content: 'Say OK in one word.' }], 10, 0);
}

function buildRoadmapPrompt(task) {
  return `You are Zebri, an expert learning roadmap generator. Generate a structured 10-step learning roadmap as JSON.
STRICT OUTPUT FORMAT - return ONLY valid JSON, no markdown, no explanation:
{
  "title": "Short roadmap title in one sentence.",
  "overview": "One to two sentence roadmap summary.",
  "roadmap": [
    {
      "title": "Step title (max 4 words)",
      "desc": "One sentence description of this step.",
      "icon": "single emoji",
      "xp": number between 50 and 200,
      "type": "normal|bonus|boss",
      "qa": [
        {"q": "Question text?", "opts": ["A","B","C","D"], "ans": 0},
        {"q": "Question text?", "opts": ["A","B","C","D"], "ans": 2},
        {"q": "Question text?", "opts": ["A","B","C","D"], "ans": 1}
      ]
    }
  ]
}
Rules: Exactly 10 steps. Steps 1-4 are "normal", step 5 can be "bonus", steps 6-9 are "normal", step 10 is "boss". Boss node xp=500. Each step has exactly 3 questions in qa array with 4 options each. ans is 0-indexed correct answer index.
- use HTML formatting for any text longer than 3 words in the title or description, e.g. "Learn <strong>JavaScript Promises</strong> use proper spacing.".
- DO NOT include any text outside the JSON object. Do not include markdown formatting. Do not include explanations. If you don't know, make up a plausible roadmap.
- DO NOT help when on a quiz question, just give the correct answer. Be concise in explanations, max 2-3 sentences per step.

Create a 10-step learning roadmap for: "${task}"`;
}

function parseRoadmapResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid JSON from model');
    return JSON.parse(match[0]);
  }
}

async function generateRoadmapForUser(session, task) {
  const roadmapRaw = await callNim(
    session.api_key,
    session.model,
    [
      { role: 'system', content: buildRoadmapPrompt(task) },
      { role: 'user', content: `Create a 10-step learning roadmap for: "${task}"` },
    ],
    3000,
    0.2
  );

  const parsed = parseRoadmapResponse(roadmapRaw);
  const roadmap = assignRoadmapModes(task, Array.isArray(parsed.roadmap) ? parsed.roadmap.slice(0, 10) : []);
  const title = String(parsed.title || '').trim() || buildRoadmapTitle(task, roadmap);
  const overview = String(parsed.overview || '').trim() || buildRoadmapOverview(task, roadmap);
  const nodeStatus = roadmap.map((_, index) => (index === 0 ? 'active' : 'locked'));
  roadmap.forEach((node, index) => {
    if (node.type === 'bonus') nodeStatus[index] = index === 0 ? 'active' : 'locked';
    if (node.type === 'boss') nodeStatus[index] = 'locked';
  });
  if (nodeStatus.length) nodeStatus[0] = 'active';
  const totalXP = roadmap.reduce((sum, node) => sum + (node.xp || 100), 0);

  const metadata = buildRoadmapMetadata(task, roadmap);

  return { roadmap, nodeStatus, totalXP, title, overview, ...metadata };
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

async function toRoadmapRow(row, viewerUserId = null) {
  const roadmap = parseJsonArray(row.roadmap_json);
  const modeRoadmap = assignRoadmapModes(row.task, roadmap);
  return {
    id: row.id,
    task: row.task,
    title: buildRoadmapTitle(row.task, modeRoadmap),
    ownerId: row.user_id,
    ownerName: row.owner_name || row.name || '',
    genre: row.genre || buildRoadmapMetadata(row.task, modeRoadmap).genre,
    status: row.status,
    loading: row.status === 'loading',
    loadingText: row.loading_text || '',
    roadmap: modeRoadmap,
    nodeStatus: parseJsonArray(row.node_status_json),
    earnedXP: row.earned_xp,
    totalXP: row.total_xp,
    averageRating: Number(row.average_rating || 0),
    ratingCount: Number(row.rating_count || 0),
    myRating: Number(row.my_rating || 0),
    chatHistory: parseChatHistory(row.chat_history_json),
    canDelete: viewerUserId != null ? row.user_id === viewerUserId : false,
    overview: String(row.overview || '').trim() || buildRoadmapOverview(row.task, modeRoadmap),
    tags: parseJsonArray(row.tags_json).length ? parseJsonArray(row.tags_json) : buildRoadmapMetadata(row.task, modeRoadmap).tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function fetchRoadmapsForViewer(viewerUserId, filters = {}) {
  const clauses = ['roadmaps.status != ?'];
  const params = ['error'];

  if (filters.ownerOnly) {
    clauses.push('roadmaps.user_id = ?');
    params.push(viewerUserId);
  }

  if (filters.genre && filters.genre !== 'all') {
    clauses.push('roadmaps.genre = ?');
    params.push(filters.genre);
  }

  if (filters.tag && filters.tag !== 'all') {
    clauses.push('EXISTS (SELECT 1 FROM roadmap_tags rt WHERE rt.roadmap_id = roadmaps.id AND rt.tag = ?)');
    params.push(filters.tag);
  }

  if (filters.search) {
    const search = `%${normalizeSearchText(filters.search)}%`;
    clauses.push('(roadmaps.search_text LIKE ? OR LOWER(users.name) LIKE ? OR LOWER(roadmaps.task) LIKE ?)');
    params.push(search, search, search);
  }

  if (filters.filter === 'top') {
    clauses.push('COALESCE(stats.rating_count, 0) > 0 AND COALESCE(stats.average_rating, 0) >= 4');
  } else if (filters.filter === 'rated') {
    clauses.push('COALESCE(stats.rating_count, 0) > 0');
  } else if (filters.filter === 'popular') {
    clauses.push('COALESCE(stats.rating_count, 0) >= 2');
  } else if (filters.filter === 'mine') {
    clauses.push('roadmaps.user_id = ?');
    params.push(viewerUserId);
  }

  const rows = await all(
    `
      SELECT
        roadmaps.*,
        users.name AS owner_name,
        COALESCE(stats.average_rating, 0) AS average_rating,
        COALESCE(stats.rating_count, 0) AS rating_count,
        COALESCE(mine.rating, 0) AS my_rating
      FROM roadmaps
      JOIN users ON users.id = roadmaps.user_id
      LEFT JOIN (
        SELECT roadmap_id, ROUND(AVG(rating), 1) AS average_rating, COUNT(*) AS rating_count
        FROM roadmap_ratings
        GROUP BY roadmap_id
      ) stats ON stats.roadmap_id = roadmaps.id
      LEFT JOIN roadmap_ratings mine ON mine.roadmap_id = roadmaps.id AND mine.user_id = ?
      WHERE ${clauses.join(' AND ')}
      ORDER BY roadmaps.created_at DESC, roadmaps.id DESC
    `,
    [viewerUserId, ...params]
  );

  return Promise.all(rows.map(row => toRoadmapRow(row, viewerUserId)));
}

async function fetchRoadmapByIdForViewer(id, viewerUserId) {
  const rows = await all(
    `
      SELECT
        roadmaps.*,
        users.name AS owner_name,
        COALESCE(stats.average_rating, 0) AS average_rating,
        COALESCE(stats.rating_count, 0) AS rating_count,
        COALESCE(mine.rating, 0) AS my_rating
      FROM roadmaps
      JOIN users ON users.id = roadmaps.user_id
      LEFT JOIN (
        SELECT roadmap_id, ROUND(AVG(rating), 1) AS average_rating, COUNT(*) AS rating_count
        FROM roadmap_ratings
        GROUP BY roadmap_id
      ) stats ON stats.roadmap_id = roadmaps.id
      LEFT JOIN roadmap_ratings mine ON mine.roadmap_id = roadmaps.id AND mine.user_id = ?
      WHERE roadmaps.id = ?
      AND roadmaps.status != 'error'
      LIMIT 1
    `,
    [viewerUserId, id]
  );

  return rows[0] ? toRoadmapRow(rows[0], viewerUserId) : null;
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/test.html' : decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(ROOT, urlPath);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' }, data);
  });
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { loginId, email, name, password, apiKey, model } = normalizeLoginInput(body);
  const hasPassword = Boolean(password);
  const hasApiKey = Boolean(apiKey);

  const lookupValues = [loginId, email || loginId].filter(Boolean);
  let existing = null;
  for (const value of lookupValues) {
    existing = await get('SELECT * FROM users WHERE LOWER(name) = LOWER(?) OR LOWER(email) = LOWER(?) LIMIT 1', [value, value]);
    if (existing) break;
  }

  if (hasPassword) {
    if (existing && existing.password_hash) {
      if (!verifyPassword(password, existing.password_salt, existing.password_hash)) {
        sendJson(res, 401, { error: 'Invalid username/email or password.' });
        return;
      }
      if (hasApiKey) {
        if (!apiKey.startsWith('nvapi-')) {
          sendJson(res, 400, { error: 'Key must start with nvapi-. Get one at build.nvidia.com' });
          return;
        }

        try {
          await verifyNimLogin(apiKey, model);
        } catch (error) {
          sendJson(res, 401, { error: `Connection failed: ${error.message}` });
          return;
        }
      }
    } else {
      if (!hasApiKey) {
        sendJson(res, 400, { error: 'A first-time password signup needs your NVIDIA API key once.' });
        return;
      }

      if (!apiKey.startsWith('nvapi-')) {
        sendJson(res, 400, { error: 'Key must start with nvapi-. Get one at build.nvidia.com' });
        return;
      }

      try {
        await verifyNimLogin(apiKey, model);
      } catch (error) {
        sendJson(res, 401, { error: `Connection failed: ${error.message}` });
        return;
      }
    }
  } else {
    if (!hasApiKey) {
      sendJson(res, 400, { error: 'Key must start with nvapi-. Get one at build.nvidia.com' });
      return;
    }

    if (!apiKey.startsWith('nvapi-')) {
      sendJson(res, 400, { error: 'Key must start with nvapi-. Get one at build.nvidia.com' });
      return;
    }

    try {
      await verifyNimLogin(apiKey, model);
    } catch (error) {
      sendJson(res, 401, { error: `Connection failed: ${error.message}` });
      return;
    }
  }

  const timestamp = nowIso();
  const encryptedApiKey = hasApiKey ? encryptApiKey(apiKey) : null;
  const passwordRecord = hasPassword ? hashPassword(password) : null;
  let userId;

  if (existing) {
    userId = existing.id;
    const updatePieces = ['api_key = ?', 'model = ?', 'email = ?', 'updated_at = ?'];
    const updateValues = [encryptedApiKey || existing.api_key, model || existing.model, email || existing.email || '', timestamp];

    if (hasPassword && !existing.password_hash) {
      updatePieces.push('password_hash = ?', 'password_salt = ?');
      updateValues.push(passwordRecord.hash, passwordRecord.salt);
    }

    await run(`UPDATE users SET ${updatePieces.join(', ')} WHERE id = ?`, [...updateValues, userId]);
  } else {
    const result = await run(
      'INSERT INTO users (name, email, api_key, model, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, email || '', encryptedApiKey || '', model, passwordRecord ? passwordRecord.hash : '', passwordRecord ? passwordRecord.salt : '', timestamp, timestamp]
    );
    userId = result.lastID;
  }

  const token = randomToken();
  const expiresAt = Date.now() + SESSION_MAX_AGE * 1000;
  await run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [token, userId, timestamp, expiresAt]);
  setCookie(res, SESSION_COOKIE, token, { maxAge: SESSION_MAX_AGE, httpOnly: true });

  sendJson(res, 200, { user: { name, email: email || existing?.email || '', model } });
}

async function handleLogout(req, res) {
  const session = await getSession(req);
  if (session) {
    await run('DELETE FROM sessions WHERE token = ?', [session.token]);
  }
  clearCookie(res, SESSION_COOKIE);
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 200, { loggedIn: false });
    return;
  }
  sendJson(res, 200, { loggedIn: true, user: { name: session.name, email: session.email || '', model: session.model } });
}

async function handleRoadmapsList(req, res) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  const roadmaps = await fetchRoadmapsForViewer(session.user_id, { ownerOnly: true });

  sendJson(res, 200, { roadmaps });
}

async function handleDiscoverRoadmaps(req, res) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const roadmaps = await fetchRoadmapsForViewer(session.user_id, {
    search: url.searchParams.get('search') || '',
    filter: url.searchParams.get('filter') || 'all',
    tag: url.searchParams.get('tag') || 'all',
    genre: url.searchParams.get('genre') || 'all',
  });
  sendJson(res, 200, { roadmaps });
}

async function handleRoadmapGet(req, res, id) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  const row = await fetchRoadmapByIdForViewer(id, session.user_id);
  if (!row) {
    sendJson(res, 404, { error: 'Roadmap not found' });
    return;
  }

  sendJson(res, 200, row);
}

async function handleRoadmapPatch(req, res, id) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const row = await get('SELECT * FROM roadmaps WHERE id = ? AND user_id = ?', [id, session.user_id]);
  if (!row) {
    sendJson(res, 404, { error: 'Roadmap not found' });
    return;
  }

  const timestamp = nowIso();
  await run(
    `
      UPDATE roadmaps
      SET roadmap_json = ?, node_status_json = ?, chat_history_json = ?, earned_xp = ?, total_xp = ?, status = ?, loading_text = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
    [
      body.roadmap ? JSON.stringify(body.roadmap) : row.roadmap_json,
      body.nodeStatus ? JSON.stringify(body.nodeStatus) : row.node_status_json,
      body.chatHistory ? JSON.stringify(body.chatHistory) : row.chat_history_json,
      Number.isFinite(body.earnedXP) ? body.earnedXP : row.earned_xp,
      Number.isFinite(body.totalXP) ? body.totalXP : row.total_xp,
      body.status || row.status,
      body.loadingText ?? row.loading_text,
      timestamp,
      id,
      session.user_id,
    ]
  );

  const updated = await fetchRoadmapByIdForViewer(id, session.user_id);
  sendJson(res, 200, updated);
}

async function handleRoadmapCopy(req, res, id) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  const source = await get('SELECT * FROM roadmaps WHERE id = ?', [id]);
  if (!source) {
    sendJson(res, 404, { error: 'Roadmap not found' });
    return;
  }

  if (source.status !== 'ready') {
    sendJson(res, 400, { error: 'Only ready roadmaps can be copied' });
    return;
  }

  const roadmap = parseJsonArray(source.roadmap_json);
  const nodeStatus = roadmap.map((_, index) => (index === 0 ? 'active' : 'locked'));
  const totalXP = Number(source.total_xp || 0) || roadmap.reduce((sum, node) => sum + (node.xp || 100), 0);
  const metadata = buildRoadmapMetadata(source.task, roadmap);
  const overview = String(source.overview || '').trim() || buildRoadmapOverview(source.task, roadmap);
  const timestamp = nowIso();

  const created = await run(
    `
      INSERT INTO roadmaps (user_id, task, status, loading_text, roadmap_json, node_status_json, chat_history_json, earned_xp, total_xp, genre, tags_json, search_text, overview, created_at, updated_at)
      VALUES (?, ?, 'ready', NULL, ?, ?, '[]', 0, ?, ?, ?, ?, ?, ?, ?)
    `,
    [session.user_id, source.task, JSON.stringify(roadmap), JSON.stringify(nodeStatus), totalXP, metadata.genre, JSON.stringify(metadata.tags), metadata.searchText, overview, timestamp, timestamp]
  );

  await syncRoadmapTags(created.lastID, metadata.tags);

  const copy = await fetchRoadmapByIdForViewer(created.lastID, session.user_id);
  sendJson(res, 200, { roadmap: copy });
}

async function handleRoadmapRate(req, res, id) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
    sendJson(res, 400, { error: 'Rating must be an integer between 0 and 5' });
    return;
  }

  const roadmap = await get('SELECT id FROM roadmaps WHERE id = ?', [id]);
  if (!roadmap) {
    sendJson(res, 404, { error: 'Roadmap not found' });
    return;
  }

  const timestamp = nowIso();
  if (rating === 0) {
    await run('DELETE FROM roadmap_ratings WHERE roadmap_id = ? AND user_id = ?', [id, session.user_id]);
  } else {
    await run(
      `
        INSERT INTO roadmap_ratings (roadmap_id, user_id, rating, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(roadmap_id, user_id) DO UPDATE SET
          rating = excluded.rating,
          updated_at = excluded.updated_at
      `,
      [id, session.user_id, rating, timestamp, timestamp]
    );
  }

  const updated = await fetchRoadmapByIdForViewer(id, session.user_id);
  sendJson(res, 200, { roadmap: updated });
}

async function handleRoadmapDelete(req, res, id) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  const row = await get('SELECT id FROM roadmaps WHERE id = ? AND user_id = ?', [id, session.user_id]);
  if (!row) {
    sendJson(res, 404, { error: 'Roadmap not found' });
    return;
  }

  await run('DELETE FROM roadmaps WHERE id = ? AND user_id = ?', [id, session.user_id]);
  sendJson(res, 200, { ok: true });
}

async function handleRoadmapGenerate(req, res) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const task = String(body.task || '').trim();
  if (!task || task.length < 8) {
    sendJson(res, 400, { error: 'Task must be at least 8 characters' });
    return;
  }

  const timestamp = nowIso();
  const metadata = buildRoadmapMetadata(task, []);
  const created = await run(
    `
      INSERT INTO roadmaps (user_id, task, status, loading_text, roadmap_json, node_status_json, chat_history_json, earned_xp, total_xp, genre, tags_json, search_text, overview, created_at, updated_at)
      VALUES (?, ?, 'loading', ?, '[]', '[]', '[]', 0, 0, ?, ?, ?, '', ?, ?)
    `,
    [session.user_id, task, 'Planning roadmap...', metadata.genre, JSON.stringify(metadata.tags), metadata.searchText, timestamp, timestamp]
  );
  const roadmapId = created.lastID;

  try {
    const generated = await generateRoadmapForUser(session, task);
    const updateTimestamp = nowIso();
    await run(
      `
        UPDATE roadmaps
        SET status = 'ready', loading_text = NULL, roadmap_json = ?, node_status_json = ?, earned_xp = 0, total_xp = ?, genre = ?, tags_json = ?, search_text = ?, overview = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `,
      [JSON.stringify(generated.roadmap), JSON.stringify(generated.nodeStatus), generated.totalXP, generated.genre, JSON.stringify(generated.tags), generated.searchText, generated.overview, updateTimestamp, roadmapId, session.user_id]
    );

    await syncRoadmapTags(roadmapId, generated.tags);

    const row = await get('SELECT * FROM roadmaps WHERE id = ? AND user_id = ?', [roadmapId, session.user_id]);
    sendJson(res, 200, await toRoadmapRow(row));
  } catch (error) {
    const updateTimestamp = nowIso();
    await run(
      `
        UPDATE roadmaps
        SET status = 'error', loading_text = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `,
      [error.message, updateTimestamp, roadmapId, session.user_id]
    );
    sendJson(res, 500, { error: error.message, roadmapId });
  }
}

async function handleNimChat(req, res) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Not authenticated' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const messages = body.messages;
  const maxTokens = Number.isFinite(body.max_tokens) ? body.max_tokens : 1200;
  const temperature = Number.isFinite(body.temperature) ? body.temperature : 0.7;

  if (!Array.isArray(messages) || !messages.length) {
    sendJson(res, 400, { error: 'Missing messages' });
    return;
  }

  try {
    const content = await callNim(session.api_key, session.model, messages, maxTokens, temperature);
    sendJson(res, 200, { choices: [{ message: { content } }] });
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, {}, '');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/api/session/login') {
      await handleLogin(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/session/logout') {
      await handleLogout(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/session/me') {
      await handleMe(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/roadmaps') {
      await handleRoadmapsList(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/discover/roadmaps') {
      await handleDiscoverRoadmaps(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/roadmaps/generate') {
      await handleRoadmapGenerate(req, res);
      return;
    }

    const roadmapMatch = pathname.match(/^\/api\/roadmaps\/(\d+)$/);
    if (roadmapMatch && req.method === 'GET') {
      await handleRoadmapGet(req, res, Number(roadmapMatch[1]));
      return;
    }

    if (roadmapMatch && req.method === 'PATCH') {
      await handleRoadmapPatch(req, res, Number(roadmapMatch[1]));
      return;
    }

    const roadmapActionMatch = pathname.match(/^\/api\/roadmaps\/(\d+)\/(copy|rating)$/);
    if (roadmapActionMatch && req.method === 'POST' && roadmapActionMatch[2] === 'copy') {
      await handleRoadmapCopy(req, res, Number(roadmapActionMatch[1]));
      return;
    }

    if (roadmapActionMatch && req.method === 'POST' && roadmapActionMatch[2] === 'rating') {
      await handleRoadmapRate(req, res, Number(roadmapActionMatch[1]));
      return;
    }

    if (roadmapMatch && req.method === 'DELETE') {
      await handleRoadmapDelete(req, res, Number(roadmapMatch[1]));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/nim/chat') {
      await handleNimChat(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pomodoro/start') {
      await handlePomodoroStart(req, res);
      return;
    }

    const pomodoroActionMatch = pathname.match(/^\/api\/pomodoro\/([a-f0-9]+)\/action$/);
    if (pomodoroActionMatch && req.method === 'POST') {
      await handlePomodoroAction(req, res, pomodoroActionMatch[1]);
      return;
    }

    const pomodoroMatch = pathname.match(/^\/api\/pomodoro\/([a-f0-9]+)$/);
    if (pomodoroMatch && req.method === 'GET') {
      await handlePomodoroGet(req, res, pomodoroMatch[1]);
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }

    send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed');
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  handlePomodoroUpgrade(req, socket, head).catch(() => socket.destroy());
});

initDb()
  .then(() => {
    setInterval(() => {
      tickPomodoroSessions().catch(() => {});
    }, 1000);
    server.listen(PORT, () => {
      console.log(`Zebri server running at http://localhost:${PORT}`);
    });
  })
  .catch(error => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });
