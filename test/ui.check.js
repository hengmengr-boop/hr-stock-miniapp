'use strict';
// Browser test of the real frontend against an in-memory fake API (no DB/Telegram needed).
// Run: node test/ui.check.js   (needs `npx playwright install chromium` once)
const http = require('http'), fs = require('fs'), path = require('path');
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

const PUB = path.join(__dirname, '..', 'public');
const depts = [{ id: 1, name: 'HR/Admin' }, { id: 2, name: 'Procurement' }];
const uoms = [{ id: 1, code: 'PCS' }, { id: 2, code: 'BOX' }];
const me = { id: 1, full_name: 'RA Hengmeng', position: 'HR', department_id: 1, role: 'hr_admin' };
let rows = [], nextId = 1, notified = 0;
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const view = (b, id) => ({ id, request_no: '1026-' + id, requester_id: 1, requester_name: b.requester_name, position: 'HR',
  department_id: +b.department_id, department: depts.find((d) => d.id == b.department_id).name, item: b.item, qty: +b.qty,
  uom_id: +b.uom_id, uom: uoms.find((u) => u.id == b.uom_id).code, total: +b.total, request_date: b.request_date,
  request_time: '08:41:00', status: b.status, remark: b.remark });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/socket.io/socket.io.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('window.io=()=>({on(e,f){if(e==="connect")setTimeout(f,50)}});'); }
  if (u.pathname.startsWith('/api/')) {
    if (!(req.headers.authorization || '').startsWith('tma ')) return json(401, { error: 'no auth' });
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      const b = body ? JSON.parse(body) : {}; const m = u.pathname.match(/^\/api\/requests\/(\d+)(\/notify)?$/);
      if (u.pathname === '/api/me') return json(200, { user: me, departments: depts, uoms });
      if (u.pathname === '/api/stats') return json(200, { total: rows.length, open: rows.filter((r) => r.status === 'Open').length, closed: rows.filter((r) => r.status === 'Close').length });
      if (u.pathname === '/api/requests' && req.method === 'GET') {
        const st = u.searchParams.get('status'), q = (u.searchParams.get('q') || '').toLowerCase();
        return json(200, { rows: rows.filter((r) => (!st || r.status === st) && (!q || r.item.toLowerCase().includes(q))) });
      }
      if (u.pathname === '/api/requests' && req.method === 'POST') { if (!String(b.item || '').trim()) return json(400, { error: 'Invalid: item' }); const r = view(b, nextId++); rows.unshift(r); return json(201, { row: r }); }
      if (m && m[2]) { notified++; return json(200, { ok: true }); }
      if (m && req.method === 'PUT') { const i = rows.findIndex((r) => r.id == m[1]); rows[i] = view(b, +m[1]); return json(200, { row: rows[i] }); }
      if (m && req.method === 'DELETE') { rows = rows.filter((r) => r.id != m[1]); return json(200, { ok: true }); }
      json(404, { error: 'nf' });
    });
    return;
  }
  const f = path.join(PUB, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(PUB) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'text/plain' }); res.end(fs.readFileSync(f));
});

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  ✔ ' : '  ✘ ') + m); };

server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.addInitScript(() => { window.Telegram = { WebApp: { initData: 'user=1&hash=x', ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
    showConfirm: (m, cb) => cb(true), HapticFeedback: { notificationOccurred() {} } } }; });
  try {
    await page.goto(base); await page.waitForSelector('#fDept option', { state: 'attached' });
    ok((await page.textContent('#meName')) === 'RA Hengmeng', 'loads user from API');
    ok((await page.textContent('#conn b')) === 'Online', 'realtime chip shows Online');
    ok((await page.locator('#fDept option').count()) === 2 && (await page.locator('#fUom option').count()) === 2, 'department + UOM dropdowns filled');

    await page.fill('#fItem', 'Scotch tape'); await page.click('#qPlus'); await page.click('#qPlus');
    ok((await page.inputValue('#fQty')) === '3' && (await page.inputValue('#fTotal')) === '3', 'qty stepper updates total');
    await page.click('#seg button[data-v=Close]'); await page.fill('#fRemark', 'ស្កុតថ្លា ទំហំ 2.5cm');
    await page.click('#btnSave'); await page.waitForSelector('#toast.show');
    ok((await page.textContent('#toast')).includes('1026-1'), 'save creates request with number');
    await page.click('#pills button[data-f=Close]'); await page.waitForSelector('.item');
    ok((await page.textContent('#sTotal')) === '1' && (await page.textContent('#sClosed')) === '1', 'stats cards update');
    ok((await page.locator('.item').count()) === 1, 'request appears in list (Close filter)');
    ok((await page.inputValue('#fItem')) === '', 'form reset after save');

    await page.click('.item');
    ok((await page.inputValue('#fRemark')) === 'ស្កុតថ្លា ទំហំ 2.5cm', 'Khmer text round-trips');
    ok(await page.$eval('#formSet', (e) => e.disabled) && await page.locator('#fItem').isDisabled(), 'form read-only until Edit');
    ok(!(await page.locator('#btnEdit').isDisabled()) && !(await page.locator('#btnDelete').isDisabled()), 'Edit/Delete enabled for selected request');
    await page.click('#btnNotify'); await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Notification sent');
    ok(notified === 1, 'Send Telegram notification calls API');

    await page.click('#btnEdit'); await page.fill('#fItem', 'Scotch tape 2'); await page.click('#btnSave');
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Updated');
    ok(rows[0].item === 'Scotch tape 2', 'edit saves changes');

    await page.fill('#search', 'zzz'); await page.waitForFunction(() => document.querySelector('#count').textContent === '0 results');
    ok(true, 'search filters list'); await page.fill('#search', '');
    await page.waitForFunction(() => document.querySelector('#count').textContent === '1 results');

    await page.click('.item'); await page.click('#btnDelete');
    await page.waitForFunction(() => document.querySelector('#count').textContent === '0 results');
    ok(rows.length === 0, 'delete removes request');

    await page.fill('#fItem', ''); await page.click('#btnSave'); await page.waitForSelector('#toast.err');
    ok((await page.textContent('#toast')).length > 0, 'server errors shown as toast');
    await page.screenshot({ path: path.join(__dirname, 'screenshot.png'), fullPage: true });
  } catch (e) { fail++; console.log('  ✘ test crashed: ' + e.message); }
  ok(errors.length === 0, 'no JavaScript errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
});
