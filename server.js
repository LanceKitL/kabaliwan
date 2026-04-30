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

async function syncRoadmapTags(roadmapId, tags = []) {
  await run('DELETE FROM roadmap_tags WHERE roadmap_id = ?', [roadmapId]);
  for (const tag of tags) {
    await run('INSERT OR IGNORE INTO roadmap_tags (roadmap_id, tag) VALUES (?, ?)', [roadmapId, tag]);
  }
}

async function backfillRoadmapMetadata() {
  const rows = await all('SELECT id, task, roadmap_json, genre, tags_json, search_text FROM roadmaps');
  for (const row of rows) {
    const roadmap = parseJsonArray(row.roadmap_json);
    const metadata = buildRoadmapMetadata(row.task, roadmap);
    const currentTags = JSON.stringify(parseJsonArray(row.tags_json));
    const nextTags = JSON.stringify(metadata.tags);
    const currentGenre = String(row.genre || '');
    const currentSearch = String(row.search_text || '');
    if (currentGenre !== metadata.genre || currentTags !== nextTags || currentSearch !== metadata.searchText) {
      await run(
        `
          UPDATE roadmaps
          SET genre = ?, tags_json = ?, search_text = ?
          WHERE id = ?
        `,
        [metadata.genre, nextTags, metadata.searchText, row.id]
      );
    }
    await syncRoadmapTags(row.id, metadata.tags);
  }
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
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
      earned_xp INTEGER NOT NULL DEFAULT 0,
      total_xp INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await ensureRoadmapSchema();
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
      SELECT sessions.token, sessions.expires_at, users.id AS user_id, users.name, users.api_key, users.model
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ? AND sessions.expires_at > ?
    `,
    [token, Date.now()]
  );

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
  const roadmap = Array.isArray(parsed.roadmap) ? parsed.roadmap.slice(0, 10) : [];
  const nodeStatus = roadmap.map((_, index) => (index === 0 ? 'active' : 'locked'));
  roadmap.forEach((node, index) => {
    if (node.type === 'bonus') nodeStatus[index] = index === 0 ? 'active' : 'locked';
    if (node.type === 'boss') nodeStatus[index] = 'locked';
  });
  if (nodeStatus.length) nodeStatus[0] = 'active';
  const totalXP = roadmap.reduce((sum, node) => sum + (node.xp || 100), 0);

  const metadata = buildRoadmapMetadata(task, roadmap);

  return { roadmap, nodeStatus, totalXP, ...metadata };
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
  return {
    id: row.id,
    task: row.task,
    ownerId: row.user_id,
    ownerName: row.owner_name || row.name || '',
    genre: row.genre || buildRoadmapMetadata(row.task, roadmap).genre,
    status: row.status,
    loading: row.status === 'loading',
    loadingText: row.loading_text || '',
    roadmap,
    nodeStatus: parseJsonArray(row.node_status_json),
    earnedXP: row.earned_xp,
    totalXP: row.total_xp,
    averageRating: Number(row.average_rating || 0),
    ratingCount: Number(row.rating_count || 0),
    myRating: Number(row.my_rating || 0),
    canDelete: viewerUserId != null ? row.user_id === viewerUserId : false,
    tags: parseJsonArray(row.tags_json).length ? parseJsonArray(row.tags_json) : buildRoadmapMetadata(row.task, roadmap).tags,
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

  const name = String(body.name || '').trim() || 'Learner';
  const apiKey = String(body.apiKey || '').trim();
  const model = String(body.model || 'meta/llama-3.3-70b-instruct').trim();

  if (!apiKey || !apiKey.startsWith('nvapi-')) {
    sendJson(res, 400, { error: 'Key must start with nvapi-. Get one at build.nvidia.com' });
    return;
  }

  try {
    await verifyNimLogin(apiKey, model);
  } catch (error) {
    sendJson(res, 401, { error: `Connection failed: ${error.message}` });
    return;
  }

  const timestamp = nowIso();
  const existing = await get('SELECT id FROM users WHERE name = ?', [name]);
  let userId;
  if (existing) {
    userId = existing.id;
    await run('UPDATE users SET api_key = ?, model = ?, updated_at = ? WHERE id = ?', [apiKey, model, timestamp, userId]);
  } else {
    const result = await run('INSERT INTO users (name, api_key, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [name, apiKey, model, timestamp, timestamp]);
    userId = result.lastID;
  }

  const token = randomToken();
  const expiresAt = Date.now() + SESSION_MAX_AGE * 1000;
  await run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [token, userId, timestamp, expiresAt]);
  setCookie(res, SESSION_COOKIE, token, { maxAge: SESSION_MAX_AGE, httpOnly: true });

  sendJson(res, 200, { user: { name, model } });
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
  sendJson(res, 200, { loggedIn: true, user: { name: session.name, model: session.model } });
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
      SET roadmap_json = ?, node_status_json = ?, earned_xp = ?, total_xp = ?, status = ?, loading_text = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
    [
      body.roadmap ? JSON.stringify(body.roadmap) : row.roadmap_json,
      body.nodeStatus ? JSON.stringify(body.nodeStatus) : row.node_status_json,
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
  const timestamp = nowIso();

  const created = await run(
    `
      INSERT INTO roadmaps (user_id, task, status, loading_text, roadmap_json, node_status_json, earned_xp, total_xp, genre, tags_json, search_text, created_at, updated_at)
      VALUES (?, ?, 'ready', NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `,
    [session.user_id, source.task, JSON.stringify(roadmap), JSON.stringify(nodeStatus), totalXP, metadata.genre, JSON.stringify(metadata.tags), metadata.searchText, timestamp, timestamp]
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
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    sendJson(res, 400, { error: 'Rating must be an integer between 1 and 5' });
    return;
  }

  const roadmap = await get('SELECT id FROM roadmaps WHERE id = ?', [id]);
  if (!roadmap) {
    sendJson(res, 404, { error: 'Roadmap not found' });
    return;
  }

  const timestamp = nowIso();
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
      INSERT INTO roadmaps (user_id, task, status, loading_text, roadmap_json, node_status_json, earned_xp, total_xp, genre, tags_json, search_text, created_at, updated_at)
      VALUES (?, ?, 'loading', ?, '[]', '[]', 0, 0, ?, ?, ?, ?, ?)
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
        SET status = 'ready', loading_text = NULL, roadmap_json = ?, node_status_json = ?, earned_xp = 0, total_xp = ?, genre = ?, tags_json = ?, search_text = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `,
      [JSON.stringify(generated.roadmap), JSON.stringify(generated.nodeStatus), generated.totalXP, generated.genre, JSON.stringify(generated.tags), generated.searchText, updateTimestamp, roadmapId, session.user_id]
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

    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }

    send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed');
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Zebri server running at http://localhost:${PORT}`);
    });
  })
  .catch(error => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });
