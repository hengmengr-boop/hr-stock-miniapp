'use strict';
// Runs the REAL server.js with in-memory stand-ins for express/pg/socket.io, and calls every route.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Module = require('module');

const TOKEN = '8641355153:AAFakeTokenForTestingOnly_123456789';
Object.assign(process.env, { BOT_TOKEN: TOKEN, DB_PASSWORD: 'x', PORT: '0', NOTIFY_CHAT_ID: '-1003996807903',
  MENTIONS: 'nhoung_somalin,RA_Hengmeng', CONTACT_NAME: 'Mr. RA Hengmeng', AUTO_NOTIFY: 'true', SELF_REGISTER: 'true' });

/* ---------- in-memory database that understands the SQL server.js sends ---------- */
const depts = [{ id: 1, name: 'HR/Admin' }, { id: 2, name: 'Procurement' }], uoms = [{ id: 1, code: 'PCS' }, { id: 2, code: 'BOX' }];
const db = { users: [{ id: 1, telegram_id: 2018611029, telegram_user: 'RA_Hengmeng', full_name: 'RA Hengmeng', position: 'HR', department_id: 1, role: 'hr_admin', is_active: true }],
  requests: [], notifications: [], seq: 0 };
const view = (r) => ({ ...r, department: depts.find((d) => d.id === r.department_id).name, uom: uoms.find((u) => u.id === r.uom_id).code });
function runSql(sql, p = []) {
  const arg = (re) => { const m = sql.match(re); return m ? p[m[1] - 1] : undefined; };
  if (/^SELECT 1$/.test(sql.trim())) return { rows: [{ '?column?': 1 }] };
  if (sql.includes('FROM users WHERE telegram_id')) return { rows: db.users.filter((u) => u.telegram_id === p[0]) };
  if (sql.includes('INSERT INTO users')) { const u = { id: db.users.length + 1, telegram_id: p[0], telegram_user: p[1], full_name: p[2], position: null, department_id: 1, role: 'requester', is_active: true }; db.users.push(u); return { rows: [u] }; }
  if (sql.includes('UPDATE users SET telegram_user')) { db.users.find((u) => u.id === p[0]).telegram_user = p[1]; return { rows: [] }; }
  if (sql.includes('FROM departments')) return { rows: depts };
  if (sql.includes('FROM uoms')) return { rows: uoms };
  const inScope = (r) => r.request_date.startsWith(p[0].slice(0, 7)) && (!/requester_id = \$/.test(sql) || r.requester_id === arg(/requester_id = \$(\d+)/));
  if (sql.includes('COUNT(*)::int AS total')) { const x = db.requests.filter(inScope); return { rows: [{ total: x.length, open: x.filter((r) => r.status === 'Open').length, closed: x.filter((r) => r.status === 'Close').length }] }; }
  if (sql.includes('FROM v_requests WHERE id')) return { rows: db.requests.filter((r) => r.id === Number(p[0])).map(view) };
  if (sql.includes('FROM v_requests WHERE')) {
    const st = arg(/status = \$(\d+)/), like = (arg(/item ILIKE \$(\d+)/) || '').replace(/[%\\]/g, '').toLowerCase();
    return { rows: db.requests.filter((r) => inScope(r) && (!st || r.status === st) && (!like || r.item.toLowerCase().includes(like))).map(view) };
  }
  if (sql.includes('INSERT INTO requests')) {
    const id = ++db.seq; db.requests.unshift({ id, request_no: '1026-' + id, requester_id: p[0], requester_name: p[1], position: p[2], department_id: p[3], item: p[4], qty: p[5], uom_id: p[6], total: p[7], request_date: p[8], request_time: '08:41:00', status: p[9], remark: p[10] });
    return { rows: [{ id }] };
  }
  if (sql.includes('UPDATE requests SET')) { Object.assign(db.requests.find((r) => r.id === Number(p[0])), { requester_name: p[1], department_id: p[2], item: p[3], qty: p[4], uom_id: p[5], total: p[6], request_date: p[7], status: p[8], remark: p[9] }); return { rows: [] }; }
  if (sql.includes('DELETE FROM requests')) { db.requests = db.requests.filter((r) => r.id !== Number(p[0])); return { rows: [] }; }
  if (sql.includes('INSERT INTO notifications')) { db.notifications.push({ request_id: p[0], success: p[3], error_text: p[4] }); return { rows: [] }; }
  throw new Error('Unhandled SQL in test: ' + sql.slice(0, 80));
}

/* ---------- stand-ins for npm packages ---------- */
const routes = [], errHandlers = [], emitted = [], ioMw = [];
const fakeExpress = () => { const a = {}; for (const m of ['get', 'post', 'put', 'delete']) a[m] = (path, ...h) => routes.push({ m: m.toUpperCase(), path, h });
  a.use = (...x) => { const f = x[x.length - 1]; if (typeof f === 'function' && f.length === 4) errHandlers.push(f); }; a.set = () => {}; return a; };
fakeExpress.json = fakeExpress.static = () => () => {};
const stubs = {
  express: fakeExpress, helmet: () => () => {}, compression: () => () => {}, 'express-rate-limit': () => () => {}, dotenv: { config() {} },
  pg: { types: { setTypeParser() {} }, Pool: class { query(s, p) { return Promise.resolve(runSql(s, p)); } end() { return Promise.resolve(); } } },
  'socket.io': { Server: class { use(f) { ioMw.push(f); } emit(e, d) { emitted.push([e, d]); } close() {} } },
};
const origLoad = Module._load;
Module._load = function (req, ...r) { return stubs[req] !== undefined ? stubs[req] : origLoad.call(this, req, ...r); };
let telegramCalls = [], telegramOk = true;
global.fetch = async (url, opt) => { telegramCalls.push({ url, body: JSON.parse(opt.body) }); return { json: async () => (telegramOk ? { ok: true, result: { message_id: 99 } } : { ok: false, description: 'chat not found' }) }; };
require('../server.js');
Module._load = origLoad;

/* ---------- request driver ---------- */
const sign = (u) => { const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(u) });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n'); const s = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', s).update(dcs).digest('hex')); return p.toString(); };
async function call(method, url, user, body) {
  const [pathname, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const route = routes.find((r) => { if (r.m !== method) return false; const re = new RegExp('^' + r.path.replace(/:\w+/g, '([^/]+)').replace(/\//g, '\\/') + '$'); const m = pathname.match(re); if (m) r.params = m; return !!m; });
  assert.ok(route, `no route ${method} ${pathname}`);
  const names = [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1]); const params = {}; names.forEach((n, i) => (params[n] = route.params[i + 1]));
  const req = { headers: user ? { authorization: 'tma ' + (typeof user === 'string' ? user : sign(user)) } : {}, query, params, body: body || {} };
  const out = { status: 200, json: null };
  const res = { status(c) { out.status = c; return this; }, json(o) { out.json = o; return this; } };
  const run = async (i, err) => {
    if (err) return errHandlers[0](err, req, res, () => {});
    const h = route.h[i]; if (!h || out.json) return;
    await new Promise((resolve) => { let done = false; const next = (e) => { if (done) return; done = true; (e ? run(i, e) : run(i + 1)).then(resolve); };
      Promise.resolve(h(req, res, next)).then(() => { if (!done) { done = true; resolve(); } }); });
  };
  await run(0); return out;
}
const admin = { id: 2018611029, first_name: 'RA', last_name: 'Hengmeng', username: 'RA_Hengmeng' };
const staff = { id: 777, first_name: 'Ngy', last_name: 'Sreynuch', username: 'ngy' };
const staff2 = { id: 888, first_name: 'Other', username: 'other' };
const body = { requester_name: 'Ngy Sreynuch', department_id: 2, item: 'Scotch tape', qty: 4, uom_id: 1, total: 4, request_date: '2026-10-06', status: 'Open', remark: 'ស្កុតថ្លា' };

test('health + auth gate', async () => {
  assert.equal((await call('GET', '/health')).json.ok, true);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', 'user=%7B%22id%22%3A1%7D&hash=bad')).status, 401);
});
test('/api/me: seeded admin and auto-registered requester', async () => {
  const a = await call('GET', '/api/me', admin); assert.equal(a.json.user.role, 'hr_admin'); assert.equal(a.json.departments.length, 2);
  const s = await call('GET', '/api/me', staff); assert.equal(s.json.user.role, 'requester'); assert.equal(s.json.user.full_name, 'Ngy Sreynuch');
});
test('requester creates request: forced Open and numbered; Save sends notification separately', async () => {
  const r = await call('POST', '/api/requests', staff, { ...body, status: 'Close' });
  assert.equal(r.status, 201); assert.equal(r.json.row.status, 'Open'); assert.equal(r.json.row.request_no, '1026-1');
  assert.equal(telegramCalls.length, 0);
  assert.deepEqual(emitted.at(-1), ['requests:changed', { action: 'created', id: 1 }]);
});
test('validation errors return 400', async () => {
  const r = await call('POST', '/api/requests', staff, { ...body, item: '', qty: 0 });
  assert.equal(r.status, 400); assert.ok(r.json.error.includes('item') && r.json.error.includes('qty'));
});
test('admin creates a Close request; lists + stats respect roles', async () => {
  assert.equal((await call('POST', '/api/requests', admin, { ...body, requester_name: 'Admin', item: 'Pens', status: 'Close' })).json.row.status, 'Close');
  const adm = await call('GET', '/api/requests?month=2026-10', admin); assert.equal(adm.json.rows.length, 2);
  const stf = await call('GET', '/api/requests?month=2026-10', staff); assert.equal(stf.json.rows.length, 1);
  assert.deepEqual(await call('GET', '/api/stats?month=2026-10', admin).then((x) => x.json), { total: 2, open: 1, closed: 1 });
  assert.equal((await call('GET', '/api/requests?month=2026-10&status=Close', admin)).json.rows.length, 1);
  assert.equal((await call('GET', '/api/requests?month=2026-10&q=pens', admin)).json.rows.length, 1);
  assert.equal((await call('GET', '/api/requests?month=2026-09', admin)).json.rows.length, 0);
});
test('permissions on edit/delete/notify', async () => {
  assert.equal((await call('PUT', '/api/requests/1', staff2, body)).status, 403);           // someone else's
  assert.equal((await call('PUT', '/api/requests/2', staff, body)).status, 403);            // closed, not theirs
  const ok = await call('PUT', '/api/requests/1', staff, { ...body, item: 'Scotch tape 2', status: 'Close' });
  assert.equal(ok.status, 200); assert.equal(ok.json.row.item, 'Scotch tape 2'); assert.equal(ok.json.row.status, 'Open');
  assert.equal((await call('PUT', '/api/requests/1', admin, { ...body, status: 'Close' })).json.row.status, 'Close');
  assert.equal((await call('DELETE', '/api/requests/1', staff)).status, 403);                // now Close -> requester cannot delete
  assert.equal((await call('POST', '/api/requests/1/notify', staff2)).status, 403);
});
test('notify endpoint: success and Telegram failure message', async () => {
  telegramCalls = []; assert.equal((await call('POST', '/api/requests/2/notify', admin)).json.ok, true); assert.equal(telegramCalls.length, 1);
  telegramOk = false; const bad = await call('POST', '/api/requests/2/notify', admin);
  assert.equal(bad.status, 500); assert.ok(bad.json.error.includes('chat not found')); assert.equal(db.notifications.at(-1).success, false); telegramOk = true;
});
test('admin deletes; missing request gives 404', async () => {
  assert.equal((await call('DELETE', '/api/requests/1', admin)).json.ok, true);
  assert.deepEqual(emitted.at(-1), ['requests:changed', { action: 'deleted', id: 1 }]);
  assert.equal((await call('DELETE', '/api/requests/1', admin)).status, 404);
});
test('socket.io auth middleware accepts valid and rejects forged', async () => {
  const run = (initData) => new Promise((res) => ioMw[0]({ handshake: { auth: { initData } }, data: {} }, (e) => res(e ? e.message : 'ok')));
  assert.equal(await run(sign(admin)), 'ok'); assert.equal(await run('hash=bad&user=%7B%7D'), 'unauthorized'); assert.equal(await run(''), 'unauthorized');
});
test.after(() => setTimeout(() => process.exit(0), 50));
