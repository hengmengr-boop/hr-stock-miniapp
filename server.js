'use strict';
require('dotenv').config();
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
} = process.env;

if (!BOT_TOKEN || !hasDbConfig()) {
  console.error('Missing BOT_TOKEN or database settings in .env. Run: npm run setup');
  process.exit(1);
}

// Return DATE as 'YYYY-MM-DD' string and NUMERIC as number (avoids timezone shifts)
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, parseFloat);

const pool = new pg.Pool(poolConfig());
const q = (text, params) => pool.query(text, params);

const app = express();
app.set('trust proxy', 1);
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
app.use(express.json({ limit: '50kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

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

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

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

function monthOf(req) {
  const m = req.query.month;
  return /^\d{4}-\d{2}$/.test(m || '') ? m : new Date().toISOString().slice(0, 7);
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
    });
    const j = await res.json();
    ok = j.ok; messageId = j.result?.message_id || null; errText = j.ok ? null : j.description;
  } catch (e) { errText = e.message; }
  await q('INSERT INTO notifications (request_id, chat_id, message_id, success, error_text) VALUES ($1,$2,$3,$4,$5)',
    [r.id, NOTIFY_CHAT_ID, messageId, ok, errText]);
  if (!ok) throw new Error('Telegram: ' + errText);
}

const broadcast = (action, id) => io.emit('requests:changed', { action, id });

/* ------------------------------ REST API ------------------------------ */
app.get('/health', ah(async (_req, res) => { await q('SELECT 1'); res.json({ ok: true }); }));

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
  broadcast('created', row.id);
  if (AUTO_NOTIFY === 'true') sendNotification(row).catch((e) => console.error('auto notify:', e.message));
  res.status(201).json({ row });
}));

app.put('/api/requests/:id', auth, ah(async (req, res) => {
  const cur = await getView(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (!canModify(req.user, cur)) return res.status(403).json({ error: 'You cannot edit this request' });
  const { err, v } = validate(req.body, req.user);
  if (err.length) return res.status(400).json({ error: 'Invalid: ' + err.join(', ') });
  if (!isAdmin(req.user)) v.status = cur.status;
  await q(
    `UPDATE requests SET requester_name=$2, department_id=$3, item=$4, qty=$5, uom_id=$6, total=$7,
            request_date=$8, status=$9, remark=$10, updated_by=$11 WHERE id=$1`,
    [cur.id, v.requester_name, v.department_id, v.item, v.qty, v.uom_id, v.total,
     v.request_date, v.status, v.remark, req.user.id]);
  broadcast('updated', cur.id);
  res.json({ row: await getView(cur.id) });
}));

app.delete('/api/requests/:id', auth, ah(async (req, res) => {
  const cur = await getView(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (!canModify(req.user, cur)) return res.status(403).json({ error: 'You cannot delete this request' });
  await q('DELETE FROM requests WHERE id=$1', [cur.id]);
  broadcast('deleted', cur.id);
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
  console.error(err);
  res.status(500).json({ error: err.message?.startsWith('Telegram:') || err.message?.includes('NOTIFY') ? err.message : 'Server error' });
});

/* ------------------------------ Realtime ------------------------------ */
io.use(async (socket, next) => {
  try {
    const tg = verifyInitData(socket.handshake.auth?.initData, BOT_TOKEN);
    if (!tg) return next(new Error('unauthorized'));
    const user = await getOrCreateUser(tg);
    if (!user) return next(new Error('forbidden'));
    socket.data.user = user;
    next();
  } catch (e) { next(new Error('server')); }
});

/* ------------------------------- Startup ------------------------------ */
server.listen(PORT, () => console.log(`HR Stock Mini App listening on :${PORT}`));
const shutdown = () => { io.close(); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(1), 10_000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
   git add .