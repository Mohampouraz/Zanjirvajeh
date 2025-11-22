/**
 * server.js — Unified Node server + Telegram Bot (Long Polling)
 * - Serves public/index.html (WebApp UI)
 * - REST API for multi-chat word-chain game
 * - Telegram Bot replies to /start with a WebApp button
 *
 * Env:
 *   BOT_TOKEN=...                 (required)
 *   HOST=0.0.0.0                  (optional)
 *   PORT=8080                     (optional)
 *   WEBAPP_URL=https://yourdomain/public/index.html  (optional; defaults to local)
 *
 * Files:
 *   - public/index.html (latest premium light UI you approved)
 *   - zwords.js (exports { ZWORDS: [...] })
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ------------------------------- Config
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN env first.'); process.exit(1);
}

// Serve WebApp from /public/index.html
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_WEBAPP_URL = `http://127.0.0.1:${PORT}/public/index.html`;
const WEBAPP_URL = process.env.WEBAPP_URL || DEFAULT_WEBAPP_URL;

// ------------------------------- Game settings
const TURN_SECONDS_DEFAULT = 20;
const MIN_WORD_LEN = 3;

// ------------------------------- In-memory stores (per chat)
const games = new Map();            // chat_id -> game
const users = new Map();            // userId -> {id, name, score}
const usedWordsByChat = new Map();  // chat_id -> Set

// ------------------------------- Dictionary
const { ZWORDS } = require('./zwords.js');
const DICT = new Set(ZWORDS);

// ------------------------------- Persian normalization helpers
const FA_LETTERS = 'آاآبپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی‌';

function normalizeFa(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .normalize('NFC')
    .replace(/\u064A/g, 'ی')
    .replace(/\u0643/g, 'ک')
    .replace(/\u06C0/g, 'ه')
    .replace(/\u0640/g, '')
    .replace(/[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED]/g, '')
    .replace(new RegExp(`[^${FA_LETTERS}]`, 'g'), ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function firstLetter(word) {
  const w = normalizeFa(word).replace(new RegExp(`^[^${FA_LETTERS}]+`,'g'), '');
  return w[0] || null;
}
function lastLetter(word) {
  const w = normalizeFa(word).replace(new RegExp(`[^${FA_LETTERS}]+$`,'g'), '');
  return w[w.length - 1] || null;
}
function randomStartLetter() {
  const letters = Array.from('ابسدمزرشتکمنهیآچژغفلوقطظثحخعپ');
  return letters[Math.floor(Math.random() * letters.length)];
}

// ------------------------------- Game core
function getGame(chatId) {
  let g = games.get(chatId);
  if (!g) {
    g = createNewGame({ chatId, mode: 'team', turnSeconds: TURN_SECONDS_DEFAULT });
    games.set(chatId, g);
  }
  return g;
}
function createNewGame({ chatId, mode = 'team', turnSeconds = TURN_SECONDS_DEFAULT, starterLetter = null }) {
  const now = Date.now();
  const startLetter = starterLetter || randomStartLetter();
  const g = {
    id: `g_${chatId}_${now}`,
    chatId,
    mode,
    round: 1,
    currentLetter: startLetter,
    turnSeconds,
    startedAt: now,
    expiresAt: now + turnSeconds * 1000,
    currentPlayerId: null,
    players: [],
    scores: {},
    history: []
  };
  games.set(chatId, g);
  usedWordsByChat.set(chatId, new Set());
  return g;
}
function joinGame({ chatId, userId, displayName }) {
  const g = getGame(chatId);
  if (!users.has(userId)) users.set(userId, { id: userId, name: displayName || `کاربر ${userId}`, score: 0 });
  if (!g.players.includes(userId)) {
    g.players.push(userId);
    g.scores[userId] = g.scores[userId] || 0;
  }
  if (!g.currentPlayerId) {
    g.currentPlayerId = userId;
    g.expiresAt = Date.now() + g.turnSeconds * 1000;
  }
  return g;
}
function advanceTurn(g, nextPlayerId = null) {
  if (!g || g.players.length === 0) return;
  const idx = g.players.indexOf(g.currentPlayerId);
  const nextIdx = (idx + 1) % g.players.length;
  g.currentPlayerId = nextPlayerId || g.players[nextIdx];
  g.round += 1;
  g.expiresAt = Date.now() + g.turnSeconds * 1000;
}
function validateWord({ word, requiredStart, chatId }) {
  const norm = normalizeFa(word);
  const start = firstLetter(norm);
  const end = lastLetter(norm);
  const usedSet = usedWordsByChat.get(chatId) || new Set();

  if (!norm || norm.length < MIN_WORD_LEN) return { ok: false, reason: 'کلمه خیلی کوتاه است', norm };
  if (!start || start !== requiredStart) return { ok: false, reason: `باید با «${requiredStart}» شروع شود`, norm };
  if (!DICT.has(norm)) return { ok: false, reason: 'در فرهنگ لغت نیست', norm };
  if (usedSet.has(norm)) return { ok: false, reason: 'این کلمه قبلاً استفاده شده', norm };

  const score = 1 + (norm.length >= 6 ? 1 : 0);
  return { ok: true, norm, end, score };
}
function submitWord({ chatId, userId, word }) {
  const g = getGame(chatId);
  const now = Date.now();

  if (now > g.expiresAt) {
    advanceTurn(g);
    return { error: 'زمان نوبت تمام شد. نوبت بعدی آغاز شد.' };
  }
  if (g.currentPlayerId && g.currentPlayerId !== userId) {
    return { error: 'الان نوبت شما نیست.' };
  }

  const result = validateWord({ word, requiredStart: g.currentLetter, chatId });
  const entry = {
    userId, word, normalized: result.norm, valid: !!result.ok,
    score: result.ok ? result.score : 0,
    nextLetter: result.ok ? result.end : g.currentLetter,
    ts: now
  };
  g.history.push(entry);

  if (!result.ok) {
    advanceTurn(g);
    return { ok: false, reason: result.reason, game: g, entry };
  }

  usedWordsByChat.get(chatId).add(result.norm);
  g.scores[userId] = (g.scores[userId] || 0) + result.score;
  const u = users.get(userId); if (u) u.score = g.scores[userId];
  g.currentLetter = result.end;

  if (g.mode === 'solo') {
    const recent = g.history.slice(-3);
    if (recent.length === 3 && recent.every(h => h.valid && h.userId === userId)) {
      g.scores[userId] += 1; if (u) u.score = g.scores[userId];
    }
  }

  advanceTurn(g);
  return { ok: true, game: g, entry };
}

// ------------------------------- HTTP helpers
function sendJSON(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}
function servePublic(req, res) {
  const parsed = url.parse(req.url);
  let pathname = parsed.pathname;

  // Map root to /public/index.html
  if (pathname === '/' || pathname === '/index.html') {
    const iPath = path.join(PUBLIC_DIR, 'index.html');
    try {
      const html = fs.readFileSync(iPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('public/index.html پیدا نشد');
    }
    return true;
  }

  // Serve anything under /public/*
  if (pathname.startsWith('/public/')) {
    const filePath = path.join(__dirname, pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const map = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.json': 'application/json; charset=utf-8',
        '.woff2': 'font/woff2'
      };
      res.writeHead(200, { 'Content-Type': map[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
      return true;
    }
  }

  return false;
}
function parseBody(req) {
  return new Promise((resolve) => {
    let data = ''; req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

// ------------------------------- REST API
async function router(req, res) {
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;

  if (pathname === '/api/newgame' && req.method === 'POST') {
    const body = await parseBody(req);
    const chatId = String(body.chatId || 'local');
    const g = createNewGame({
      chatId,
      mode: body.mode || 'team',
      turnSeconds: Math.max(5, Math.min(60, body.turnSeconds || TURN_SECONDS_DEFAULT)),
      starterLetter: body.starterLetter || null
    });
    return sendJSON(res, 200, { ok: true, game: g });
  }

  if (pathname === '/api/join' && req.method === 'POST') {
    const body = await parseBody(req);
    const chatId = String(body.chatId || 'local');
    const userId = String(body.userId || '').trim();
    const name = String(body.displayName || '').trim();
    if (!userId) return sendJSON(res, 400, { ok: false, error: 'userId لازم است' });
    const g = joinGame({ chatId, userId, displayName: name });
    return sendJSON(res, 200, { ok: true, game: g, user: users.get(userId) });
  }

  if (pathname === '/api/submit' && req.method === 'POST') {
    const body = await parseBody(req);
    const chatId = String(body.chatId || 'local');
    const userId = String(body.userId || '').trim();
    const word = String(body.word || '').trim();
    if (!userId || !word) return sendJSON(res, 400, { ok: false, error: 'userId و word لازم است' });
    const result = submitWord({ chatId, userId, word });
    return sendJSON(res, 200, result);
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const chatId = String(query.chatId || 'local');
    const g = games.get(chatId) || null;
    return sendJSON(res, 200, { ok: true, game: g, users: Array.from(users.values()), now: Date.now() });
  }

  const served = servePublic(req, res);
  if (served) return;

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

// ------------------------------- Telegram Bot (Long Polling)
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
let offset = 0;

function tg(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = https.request(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username || `کاربر ${userId}`;
  const text = (msg.text || '').trim();

  // /start -> welcome + web_app button + auto-join
  if (/^\/start/.test(text)) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'به «زنجیرواژه» خوش آمدید! دکمه زیر را بزنید تا وب‌اپ باز شود.',
      reply_markup: {
        inline_keyboard: [[{
          text: 'بازکردن وب‌اپ',
          web_app: { url: WEBAPP_URL + `?chatId=${chatId}` }
        }]]
      }
    });
    await tg('sendMessage', { chat_id: chatId, text: 'برای شروع سریع: /new — سپس کلمه بفرستید.' });
    await apiJoin(chatId, userId, name);
    return;
  }

  // /new -> start a team game
  if (/^\/new/.test(text)) {
    await apiNew(chatId, 'team', 20);
    await tg('sendMessage', { chat_id: chatId, text: 'بازی جدید آغاز شد. با /join بپیوندید یا کلمه بفرستید.' });
    return;
  }

  // /join -> add player
  if (/^\/join/.test(text)) {
    await apiJoin(chatId, userId, name);
    await tg('sendMessage', { chat_id: chatId, text: `پیوستی، ${name}. حرف شروع را با /state ببین.` });
    return;
  }

  // /state -> show state
  if (/^\/state/.test(text)) {
    const s = await apiState(chatId);
    const g = s.game;
    const letter = g?.currentLetter || '—';
    const current = g?.currentPlayerId ? g.currentPlayerId : '—';
    const left = g ? Math.max(0, Math.floor((g.expiresAt - s.now) / 1000)) : 0;
    await tg('sendMessage', {
      chat_id: chatId,
      text: `حرف: ${letter}\nنوبت: ${current}\nزمان: ${left}s`
    });
    return;
  }

  // word submission
  if (text && /^[آاآبپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی]/.test(text)) {
    const r = await apiSubmit(chatId, userId, text);
    if (r.error) {
      await tg('sendMessage', { chat_id: chatId, text: r.error }); return;
    }
    if (!r.ok) {
      await tg('sendMessage', { chat_id: chatId, text: `نادرست: ${r.reason}` }); return;
    }
    const entry = r.entry;
    await tg('sendMessage', {
      chat_id: chatId,
      text: `درست! +${entry.score} امتیاز\nحرف بعد: ${entry.nextLetter}\nنوبت بازیکن بعدی.`
    });
    return;
  }
}

async function poll() {
  try {
    const r = await tg('getUpdates', { timeout: 50, offset });
    if (!r.ok) return;
    for (const upd of r.result) {
      offset = upd.update_id + 1;
      if (upd.message) await handleMessage(upd.message);
      if (upd.callback_query) {
        await tg('answerCallbackQuery', { callback_query_id: upd.callback_query.id, text: 'باز می‌شویم...' });
      }
    }
  } catch (e) {
    console.error('poll error', e);
  } finally {
    setTimeout(poll, 600);
  }
}

// ------------------------------- Local server bridge for bot
const SERVER = `http://127.0.0.1:${PORT}`;
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(`${SERVER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${SERVER}${path}`, res => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
function apiNew(chatId, mode, turnSeconds) { return post('/api/newgame', { chatId, mode, turnSeconds }); }
function apiJoin(chatId, userId, displayName) { return post('/api/join', { chatId, userId, displayName }); }
function apiSubmit(chatId, userId, word) { return post('/api/submit', { chatId, userId, word }); }
function apiState(chatId) { return get(`/api/state?chatId=${chatId}`); }

// ------------------------------- Boot
const server = http.createServer(router);
server.listen(PORT, HOST, () => {
  console.log(`Server on http://${HOST}:${PORT}`);
  console.log(`WebApp URL: ${WEBAPP_URL}`);
  poll(); // start bot
});
