'use strict';
const crypto = require('crypto');

/** Verify Telegram WebApp initData. Returns the Telegram user object or null. */
function verifyInitData(raw, botToken, maxAgeSec = 86400) {
  if (!raw || !botToken) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > maxAgeSec) return null;
  try { const u = JSON.parse(params.get('user')); return u && u.id ? u : null; } catch { return null; }
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => { const [y, m, day] = d.split('-'); return `${day}-${MON[+m - 1]}-${y}`; };
function fmtTime(t) {
  let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
}

/** Group notification text (Telegram HTML parse mode). */
function buildMessage(r, { mentions = '', contact = '' } = {}) {
  const ment = mentions.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean).map((m) => '@' + m).join('\n');
  return [
    '🔔 <b>STOCK NOTIFICATION</b>', '',
    `🆔 <b>Request No:</b> ${esc(r.request_no)}`, '',
    'Dear HR/Admin Team,', ment, '',
    `📅 <b>Date:</b> ${fmtDate(r.request_date)}`,
    `🕒 <b>Time:</b> ${fmtTime(r.request_time)}`, '',
    `👤 <b>Name:</b> ${esc(r.requester_name)}`,
    `💼 <b>Position:</b> ${esc(r.position || r.department)}`, '',
    `📦 <b>Item:</b> ${esc(r.item)}`,
    `🔢 <b>Qty:</b> ${r.qty} ${esc(r.uom)}`,
    `📝 <b>Remark:</b> ${esc(r.remark)}`,
    `🔄 <b>Status:</b> ${esc(r.status)}`, '',
    'ℹ️ <b>For your information.</b>', '', 'Thank you', '',
    `If you have any questions concerning this Stock Admin Request, contact:\n${esc(contact)}`,
  ].join('\n');
}

const isAdmin = (u) => u.role === 'hr_admin' || u.role === 'admin';

function validate(b = {}, user) {
  const err = [];
  const v = {
    requester_name: String(b.requester_name || user.full_name || '').trim().slice(0, 150),
    department_id: parseInt(b.department_id, 10),
    item: String(b.item || '').trim(),
    qty: Number(b.qty),
    uom_id: parseInt(b.uom_id, 10),
    total: Number(b.total),
    request_date: String(b.request_date || ''),
    status: b.status === 'Close' ? 'Close' : 'Open',
    remark: String(b.remark || 'N/A').trim().slice(0, 2000) || 'N/A',
  };
  if (!v.requester_name) err.push('name');
  if (!Number.isInteger(v.department_id)) err.push('department');
  if (!v.item || v.item.length > 255) err.push('item');
  if (!(v.qty > 0 && v.qty <= 100000)) err.push('qty');
  if (!Number.isInteger(v.uom_id)) err.push('uom');
  if (!(v.total >= 0 && v.total <= 100000)) err.push('total');
  const d = v.request_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) err.push('date');
  if (!isAdmin(user)) v.status = 'Open'; // only HR/Admin can close
  return { err, v };
}

module.exports = { verifyInitData, esc, fmtDate, fmtTime, buildMessage, validate, isAdmin };
