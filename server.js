'use strict';
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const pg = require('pg');
const { Server } = require('socket.io');
const { verifyInitData, buildMessage, validate, isAdmin } = require('./lib/helpers');
const { poolConfig, hasDbConfig } = require('./lib/db');

const {
  BOT_TOKEN, PORT = 3000,
  NOTIFY_CHAT_ID, MENTIONS = '', CONTACT_NAME = '',
  AUTO_NOTIFY = 'false', SELF_REGISTER = 'true',
  TZ_NAME = 'Asia/Phnom_Penh',
} = process.env;

const BOT_USERNAME = (process.env.BOT_USERNAME || 'HR_Stock123_bot').replace(/^@/, '');
// Telegram's webhook secret is derived from the bot token, so no extra secret
// needs to be copied into Render. Telegram only accepts URL-safe characters here.
const TELEGRAM_WEBHOOK_SECRET = crypto.createHmac('sha256', BOT_TOKEN || '')
  .update('hr-stock-miniapp-webhook').digest('hex');

if (!BOT_TOKEN || !hasDbConfig()) {
  console.error('Missing BOT_TOKEN or database settings (DATABASE_URL or DB_*). Locally run: npm run setup');
  process.exit(1);
}

// Return DATE as 'YYYY-MM-DD' string and NUMERIC as number (avoids timezone shifts)
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, parseFloat);

const pool = new pg.Pool({
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ...poolConfig(),
});
// An idle client dropping its connection must never crash the server
pool.on('error', (e) => console.error('pg pool error:', e.code || e.message));
const q = (text, params) => pool.query(text, params);

let ready = false; // true once the database is reachable and the schema exists

const app = express();
app.set('trust proxy', 1); // Railway / Cloudflare / Nginx in front
const server = http.createServer(app);
const io = new Server(server);

app.use(helmet({
  frameguard: false, // Telegram embeds the app in an iframe (web/desktop clients)
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://telegram.org'],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      upgradeInsecureRequests: null,
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
    },
  },
}));
app.use(compression());
// Revalidate on every load (ETag) so Telegram never shows a stale app.js after a deploy
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));

// Health check (used by Railway/Render/Docker). Not rate limited, not behind the API gate.
app.get('/health', async (_req, res) => {
  try { await q('SELECT 1'); res.status(ready ? 200 : 503).json({ ok: ready }); }
  catch { res.status(503).json({ ok: false }); }
});

app.use(express.json({ limit: '50kb' }));

// Telegram group commands arrive here after setWebhook is configured at startup.
app.post('/telegram/webhook', async (req, res) => {
  const supplied = Buffer.from(req.get('x-telegram-bot-api-secret-token') || '');
  const expected = Buffer.from(TELEGRAM_WEBHOOK_SECRET);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.sendStatus(403);
  }

  const message = req.body?.message;
  const text = message?.text || '';
  const match = text.match(/^\/start(?:@([A-Za-z0-9_]+))?(?:\s|$)/i);
  if (!match || message.from?.is_bot) return res.sendStatus(200);
  if (match[1] && match[1].toLowerCase() !== BOT_USERNAME.toLowerCase()) return res.sendStatus(200);

  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.chat.id,
        text: '🌿 HR Stock · ស្នើសុំសម្ភារៈ\n\nបង្កើតសំណើថ្មី ឬពិនិត្យស្ថានភាពរបស់អ្នកក្នុងកម្មវិធី។ ចុចប៊ូតុងខាងក្រោមដើម្បីបើក HR Stock។',
        reply_markup: {
          inline_keyboard: [[{
            text: '📦 បើក HR Stock',
            // A Main Mini App deep link works from groups and retains Telegram auth.
            url: `https://t.me/${BOT_USERNAME}?startapp`,
          }]],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    if (!result.ok) console.error('Telegram /start reply failed:', result.description || response.status);
  } catch (e) {
    console.error('Telegram /start reply failed:', e.message);
  }
  return res.sendStatus(200);
});

// While the database is still starting, answer clearly instead of crashing or hanging
app.use('/api', (_req, res, next) =>
  ready ? next() : res.status(503).json({ error: 'Server is starting, please try again in a moment' }));
app.use('/api', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }));
// Reject bad ids (e.g. /api/requests/abc) with 400 instead of a database error
app.param('id', (_req, res, next, id) =>
  /^\d{1,9}$/.test(id) ? next() : res.status(400).json({ error: 'Invalid id' }));

/* ---------------------------- Telegram auth ---------------------------- */
async function getOrCreateUser(tg) {
  let { rows } = await q('SELECT * FROM users WHERE telegram_id=$1', [tg.id]);
  if (!rows[0]) {
    if (SELF_REGISTER === 'false') return null;
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ') || `User ${tg.id}`;
    ({ rows } = await q(
      `INSERT INTO users (telegram_id, telegram_user, full_name, department_id)
       VALUES ($1,$2,$3,(SELECT id FROM departments WHERE is_active ORDER BY id LIMIT 1))
       ON CONFLICT (telegram_id) DO UPDATE SET telegram_user=EXCLUDED.telegram_user
       RETURNING *`, [tg.id, tg.username || null, name]));
  } else if ((tg.username || null) !== rows[0].telegram_user) {
    await q('UPDATE users SET telegram_user=$2 WHERE id=$1', [rows[0].id, tg.username || null]);
  }
  return rows[0].is_active ? rows[0] : null;
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const auth = ah(async (req, res, next) => {
  const raw = (req.headers.authorization || '').replace(/^tma /, '');
  const tg = verifyInitData(raw, BOT_TOKEN);
  if (!tg) return res.status(401).json({ error: 'Open this app from Telegram' });
  const user = await getOrCreateUser(tg);
  if (!user) return res.status(403).json({ error: 'Access denied. Ask HR/Admin to add you.' });
  req.user = user;
  next();
});

/* ------------------------------ Helpers ------------------------------- */
const pub = (u) => ({ id: u.id, full_name: u.full_name, position: u.position, department_id: u.department_id, role: u.role });
const getView = async (id) => (await q('SELECT * FROM v_requests WHERE id=$1', [id])).rows[0];
const canModify = (u, r) => isAdmin(u) || (r.requester_id === u.id && r.status === 'Open');

// "Current month" in the business time zone (not UTC), so on the 1st of the
// month before 07:00 Phnom Penh time you still see the right month.
function currentMonth() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_NAME, year: 'numeric', month: '2-digit' })
      .formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}`;
  } catch { return new Date().toISOString().slice(0, 7); }
}
function monthOf(req) {
  const m = req.query.month;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '') ? m : currentMonth();
}
function scope(req) {
  const p = [monthOf(req) + '-01'];
  const w = [`request_date >= $1::date AND request_date < ($1::date + interval '1 month')`];
  if (!isAdmin(req.user)) { p.push(req.user.id); w.push(`requester_id = $${p.length}`); }
  return { p, w };
}

async function sendNotification(r) {
  if (!NOTIFY_CHAT_ID) throw new Error('NOTIFY_CHAT_ID is not configured');
  const text = buildMessage(r, { mentions: MENTIONS, contact: CONTACT_NAME });

  let ok = false, messageId = null, errText = null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: NOTIFY_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000), // never hang if Telegram is slow
    });
    const j = await res.json();
    ok = j.ok; messageId = j.result?.message_id || null; errText = j.ok ? null : j.description;
  } catch (e) { errText = e.message; }
  await q('INSERT INTO notifications (request_id, chat_id, message_id, success, error_text) VALUES ($1,$2,$3,$4,$5)',
    [r.id, NOTIFY_CHAT_ID, messageId, ok, errText]);
  if (!ok) throw new Error('Telegram: ' + errText);
}

// Send realtime events only to the people who can see the request:
// all admins + the person who owns it (not to every connected user).
const broadcast = (action, row) =>
  io.to('admins').to(`user:${row.requester_id}`).emit('requests:changed', { action, id: row.id });

/* ------------------------------ REST API ------------------------------ */
app.get('/api/me', auth, ah(async (req, res) => {
  const [d, u] = await Promise.all([
    q('SELECT id, name FROM departments WHERE is_active ORDER BY name'),
    q('SELECT id, code FROM uoms WHERE is_active ORDER BY id'),
  ]);
  res.json({ user: pub(req.user), departments: d.rows, uoms: u.rows });
}));

app.get('/api/stats', auth, ah(async (req, res) => {
  const { p, w } = scope(req);
  const { rows } = await q(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='Open')::int AS open,
            COUNT(*) FILTER (WHERE status='Close')::int AS closed
     FROM requests WHERE ${w.join(' AND ')}`, p);
  res.json(rows[0]);
}));

app.get('/api/requests', auth, ah(async (req, res) => {
  const { p, w } = scope(req);
  if (['Open', 'Close'].includes(req.query.status)) { p.push(req.query.status); w.push(`status = $${p.length}`); }
  const term = String(req.query.q || '').trim().slice(0, 100);
  if (term) {
    p.push(`%${term.replace(/[%_\\]/g, '\\$&')}%`);
    const n = p.length;
    w.push(`(item ILIKE $${n} OR requester_name ILIKE $${n} OR department ILIKE $${n} OR request_no ILIKE $${n})`);
  }
  const { rows } = await q(
    `SELECT * FROM v_requests WHERE ${w.join(' AND ')} ORDER BY request_date DESC, id DESC LIMIT 300`, p);
  res.json({ rows });
}));

app.post('/api/requests', auth, ah(async (req, res) => {
  const { err, v } = validate(req.body, req.user);
  if (err.length) return res.status(400).json({ error: 'Invalid: ' + err.join(', ') });
  const ins = await q(
    `INSERT INTO requests (requester_id, requester_name, position, department_id, item, qty, uom_id,
                           total, request_date, status, remark, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$1,$1) RETURNING id`,
    [req.user.id, v.requester_name, req.user.position, v.department_id, v.item, v.qty, v.uom_id,
     v.total, v.request_date, v.status, v.remark]);
  const row = await getView(ins.rows[0].id);
  broadcast('created', row);
  if (AUTO_NOTIFY === 'true') sendNotification(row).catch((e) => console.error('auto notify:', e.message));
  res.status(201).json({ row });
}));

app.put('/api/requests/:id', auth, ah(async (req, res) => {
  const cur = await getView(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (!canModify(req.user, cur)) return res.status(403).json({ error: 'You cannot edit this request' });
  const { err, v } = validate(req.body, req.user);
  if (err.length) return res.status(400).json({ error: 'Invalid: ' + err.join(', ') });
  if (!isAdmin(req.user)) v.status = cur.status; // only admins can open/close
  await q(
    `UPDATE requests SET requester_name=$2, department_id=$3, item=$4, qty=$5, uom_id=$6, total=$7,
            request_date=$8, status=$9, remark=$10, updated_by=$11 WHERE id=$1`,
    [cur.id, v.requester_name, v.department_id, v.item, v.qty, v.uom_id, v.total,
     v.request_date, v.status, v.remark, req.user.id]);
  broadcast('updated', cur);
  res.json({ row: await getView(cur.id) });
}));

app.delete('/api/requests/:id', auth, ah(async (req, res) => {
  const cur = await getView(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (!canModify(req.user, cur)) return res.status(403).json({ error: 'You cannot delete this request' });
  await q('DELETE FROM requests WHERE id=$1', [cur.id]);
  broadcast('deleted', cur);
  res.json({ ok: true });
}));

app.post('/api/requests/:id/notify', auth, ah(async (req, res) => {
  const cur = await getView(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && cur.requester_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  await sendNotification(cur);
  res.json({ ok: true });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  // Bad data that reached the database (wrong type, unknown department/unit, out of range)
  if (['22P02', '23503', '23514', '22003', '22007'].includes(err.code)) {
    return res.status(400).json({ error: 'Invalid data' });
  }
  console.error(err);
  const safe = err.message?.startsWith('Telegram:') || err.message?.includes('NOTIFY');
  res.status(500).json({ error: safe ? err.message : 'Server error' });
});

/* ------------------------------ Realtime ------------------------------ */
io.use(async (socket, next) => {
  try {
    if (!ready) return next(new Error('starting'));
    const tg = verifyInitData(socket.handshake.auth?.initData, BOT_TOKEN);
    if (!tg) return next(new Error('unauthorized'));
    const user = await getOrCreateUser(tg);
    if (!user) return next(new Error('forbidden'));
    socket.data.user = user;
    next();
  } catch (e) { next(new Error('server')); }
});

io.on('connection', (socket) => {
  const u = socket.data.user;
  socket.join(`user:${u.id}`);
  if (isAdmin(u)) socket.join('admins');
});

/* ------------------------------- Startup ------------------------------ */
async function waitForDb(tries = 30) {
  for (let i = 1; i <= tries; i++) {
    try { await q('SELECT 1'); return; }
    catch (e) {
      console.log(`Waiting for database (${i}/${tries}): ${e.code || e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Database is not reachable. Check DATABASE_URL / DB_* settings.');
}

// On a brand-new database (e.g. first deploy on Railway) create the tables automatically.
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)'); // safe if two instances start together
    const { rows } = await client.query(`SELECT to_regclass('public.requests') AS t`);
    if (rows[0].t) return;
    const file = path.join(__dirname, 'schema.sql');
    if (!fs.existsSync(file)) { console.warn('Tables missing and schema.sql not found - skipping'); return; }
    console.log('Empty database detected: applying schema.sql');
    await client.query(fs.readFileSync(file, 'utf8'));
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

async function registerTelegramWebhook() {
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (!publicUrl) return; // Local development does not have a public Telegram webhook URL.
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${publicUrl.replace(/\/+$/, '')}/telegram/webhook`,
      secret_token: TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message'],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || 'Telegram setWebhook failed');
  console.log('Telegram group command webhook configured');
}

// Listen immediately so the platform health check passes, then prepare the database.
server.listen(PORT, () => console.log(`HR Stock Mini App listening on :${PORT}`));
(async () => {
  try {
    await waitForDb();
    await ensureSchema();
    ready = true;
    console.log('Database ready');
    try { await registerTelegramWebhook(); }
    catch (e) { console.error('Telegram webhook setup failed:', e.message); }
  } catch (e) {
    console.error('Startup failed:', e.message);
    process.exit(1);
  }
})();

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  console.log('Shutting down...');
  io.close(() => pool.end().finally(() => process.exit(0))); // also closes the HTTP server
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
