'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verifyInitData, buildMessage, validate, fmtDate, fmtTime, esc } = require('../lib/helpers');

const TOKEN = '8641355153:AAFakeTokenForTestingOnly_123456789';
function sign(userObj, { authDate = Math.floor(Date.now() / 1000), token = TOKEN } = {}) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAH', user: JSON.stringify(userObj) });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const me = { id: 2018611029, first_name: 'RA', last_name: 'Hengmeng™', username: 'RA_Hengmeng' };

test('initData: valid signature accepted', () => assert.equal(verifyInitData(sign(me), TOKEN).id, 2018611029));
test('initData: wrong bot token rejected', () => assert.equal(verifyInitData(sign(me), 'other:token'), null));
test('initData: tampered user rejected', () => {
  const raw = sign(me).replace(encodeURIComponent('"id":2018611029'), encodeURIComponent('"id":1'));
  assert.equal(verifyInitData(raw, TOKEN), null);
});
test('initData: expired (>24h) rejected', () => assert.equal(verifyInitData(sign(me, { authDate: 1000 }), TOKEN), null));
test('initData: empty / missing hash rejected', () => {
  assert.equal(verifyInitData('', TOKEN), null);
  assert.equal(verifyInitData('auth_date=1&user=%7B%7D', TOKEN), null);
});

const requester = { id: 5, role: 'requester', full_name: 'Ngy Sreynuch' };
const admin = { id: 1, role: 'hr_admin', full_name: 'RA' };
const body = { requester_name: 'Ngy', department_id: '2', item: 'Scotch tape', qty: '4', uom_id: '1', total: '4',
  request_date: '2026-10-06', status: 'Close', remark: 'ស្កុតថ្លា (4 ដុំ)' };

test('validate: good body for admin keeps Close + Khmer remark', () => {
  const { err, v } = validate(body, admin);
  assert.deepEqual(err, []); assert.equal(v.status, 'Close'); assert.equal(v.remark, 'ស្កុតថ្លា (4 ដុំ)');
});
test('validate: requester cannot close', () => assert.equal(validate(body, requester).v.status, 'Open'));
test('validate: rejects bad input', () => {
  const { err } = validate({ ...body, item: '  ', qty: '0', total: '-1', request_date: '2026-13-45', department_id: 'x' }, admin);
  for (const k of ['item', 'qty', 'total', 'date', 'department']) assert.ok(err.includes(k), k);
});
test('validate: empty remark defaults to N/A', () => assert.equal(validate({ ...body, remark: '  ' }, admin).v.remark, 'N/A'));

test('formatters', () => {
  assert.equal(fmtDate('2026-10-06'), '06-Oct-2026');
  assert.equal(fmtTime('08:41:07'), '08:41 AM');
  assert.equal(fmtTime('13:05:00'), '01:05 PM');
  assert.equal(fmtTime('00:10:00'), '12:10 AM');
  assert.equal(esc('<b>&'), '&lt;b&gt;&amp;');
});

test('group message matches your format and escapes HTML', () => {
  const msg = buildMessage({ request_no: '1026-13', request_date: '2026-10-06', request_time: '08:41:00',
    requester_name: 'Ms.Ngy <x>', position: 'Procurement -IAES', item: 'Scotch tape', qty: 4, uom: 'PCS',
    remark: 'ស្កុតថ្លា', status: 'Close' }, { mentions: 'nhoung_somalin, @RA_Hengmeng', contact: 'Mr. RA Hengmeng' });
  for (const s of ['<u>STOCK NOTIFICATION</u>', 'Request No:</b> 1026-13', '@nhoung_somalin', '@RA_Hengmeng',
    'Date:</b> 06-Oct-2026', 'Time:</b> 08:41 AM', 'Ms.Ngy &lt;x&gt;', 'Qty:</b> 4 PCS', 'Status:</b> Close',
    'If you have any questions', '<pre>', 'contact:\nMr. RA Hengmeng</pre>']) assert.ok(msg.includes(s), 'missing: ' + s);
  assert.ok(!msg.includes('<x>'));
});
