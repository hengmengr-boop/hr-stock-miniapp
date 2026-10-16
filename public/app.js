(() => {
'use strict';
const tg = window.Telegram?.WebApp;
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const S = { me: null, depts: [], uoms: [], month: today().slice(0, 7), filter: 'Open', q: '',
  rows: [], sel: null, edit: true, status: 'Open', totalTouched: false, busy: false };

/* ---------- Telegram SDK ---------- */
if (tg) {
  tg.ready(); tg.expand();
  try { tg.setHeaderColor('#0f1b29'); tg.setBackgroundColor('#0f1b29'); tg.disableVerticalSwipes?.(); } catch {}
}
const haptic = (t) => { try { tg.HapticFeedback.notificationOccurred(t); } catch {} };

/* ---------- helpers ---------- */
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
let toastT;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 2600);
  haptic(err ? 'error' : 'success');
}
async function api(path, opt = {}) {
  const r = await fetch('/api' + path, {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'tma ' + (tg?.initData || '') },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed (' + r.status + ')');
  return j;
}
const confirmBox = (msg) => new Promise((res) => (tg?.showConfirm ? tg.showConfirm(msg, res) : res(confirm(msg))));
const isAdmin = () => S.me && (S.me.role === 'hr_admin' || S.me.role === 'admin');
const canModify = (r) => r && (isAdmin() || (r.requester_id === S.me.id && r.status === 'Open'));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- connection chip ---------- */
function setOnline(v) {
  $('#conn').classList.toggle('on', v);
  $('#conn b').textContent = v ? 'Online' : 'Offline';
}

/* ---------- form ---------- */
function setStatus(v) {
  S.status = v;
  document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}
function syncButtons() {
  $('#formSet').disabled = !S.edit;
  document.querySelectorAll('#seg button').forEach((b) => (b.disabled = !isAdmin()));
  $('#btnSave').disabled = !S.edit || S.busy;
  $('#btnSave').textContent = '💾 Save + Send';
  $('#btnSave').title = 'Save request and send Telegram notification';
  $('#btnEdit').disabled = !S.sel || S.edit || !canModify(S.sel);
  $('#btnDelete').disabled = !S.sel || !canModify(S.sel);
  $('#btnNotify').hidden = !S.sel;
  $('#formTitle').textContent = S.sel ? S.sel.request_no : 'New';
}
function resetForm() {
  S.sel = null; S.edit = true; S.totalTouched = false;
  $('#fName').value = S.me.full_name; $('#fDept').value = S.me.department_id || S.depts[0]?.id;
  $('#fItem').value = ''; $('#fQty').value = 1; $('#fTotal').value = 1;
  $('#fUom').value = S.uoms[0]?.id; $('#fDate').value = today(); $('#fRemark').value = 'N/A';
  setStatus('Open'); renderList(); syncButtons();
}
function fillForm(r) {
  S.sel = r; S.edit = false; S.totalTouched = true;
  $('#fName').value = r.requester_name; $('#fDept').value = r.department_id;
  $('#fItem').value = r.item; $('#fQty').value = r.qty; $('#fTotal').value = r.total;
  $('#fUom').value = r.uom_id; $('#fDate').value = r.request_date; $('#fRemark').value = r.remark;
  setStatus(r.status); renderList(); syncButtons();
}
function readForm() {
  return {
    requester_name: $('#fName').value, department_id: $('#fDept').value, item: $('#fItem').value,
    qty: $('#fQty').value, uom_id: $('#fUom').value, total: $('#fTotal').value,
    request_date: $('#fDate').value, status: S.status, remark: $('#fRemark').value,
  };
}

/* ---------- data ---------- */
async function loadStats() {
  const s = await api('/stats?month=' + S.month);
  $('#sTotal').textContent = s.total; $('#sOpen').textContent = s.open; $('#sClosed').textContent = s.closed;
}
async function loadList() {
  const p = new URLSearchParams({ month: S.month, q: S.q });
  if (S.filter !== 'all') p.set('status', S.filter);
  S.rows = (await api('/requests?' + p)).rows;
  if (S.sel) {
    const fresh = S.rows.find((r) => r.id === S.sel.id) || (await api('/requests?month=' + S.month).then((j) => j.rows.find((r) => r.id === S.sel.id)).catch(() => null));
    if (fresh && !S.edit) fillForm(fresh);
  }
  renderList();
}
async function loadAll() {
  try {
    await Promise.all([loadStats(), loadList()]);
    $('#offline').hidden = true;
  } catch (e) {
    $('#items').replaceChildren(); $('#offline').hidden = false;
    if (/Telegram|Access/.test(e.message)) $('#offline p').textContent = e.message;
  }
}
const loadAllSoon = debounce(loadAll, 250);

function renderList() {
  $('#count').textContent = S.rows.length + ' results';
  document.querySelectorAll('.stat').forEach((b) => b.classList.toggle('on', b.dataset.f === S.filter));
  document.querySelectorAll('#pills button').forEach((b) => b.classList.toggle('on', b.dataset.f === S.filter));
  const box = $('#items'); box.replaceChildren();
  if (!S.rows.length) { box.append(el('div', 'empty', 'No requests found.')); return; }
  for (const r of S.rows) {
    const it = el('div', 'item' + (S.sel?.id === r.id ? ' sel' : ''));
    const t = el('div', 't'); t.append(el('span', '', r.item), el('span', 'badge' + (r.status === 'Close' ? ' c' : ''), r.status));
    it.append(t, el('div', 'm', `${r.request_no} · ${r.requester_name} · ${r.department} · ${r.qty} ${r.uom} · ${r.request_date}`));
    it.onclick = () => fillForm(r);
    box.append(it);
  }
}

/* ---------- actions ---------- */
async function save() {
  if (S.busy) return;
  S.busy = true; syncButtons();
  try {
    const wasEditing = Boolean(S.sel);
    const body = readForm();
    const j = S.sel
      ? await api('/requests/' + S.sel.id, { method: 'PUT', body })
      : await api('/requests', { method: 'POST', body });
    S.sel = j.row;
    fillForm(j.row);
    await loadAll();

    try {
      await api(`/requests/${j.row.id}/notify`, { method: 'POST' });
      toast(`${wasEditing ? 'Updated' : 'Saved ' + j.row.request_no} · Telegram notification sent`);
    } catch (e) {
      toast(`${wasEditing ? 'Updated' : 'Saved'} ${j.row.request_no}, but Telegram failed: ${e.message}`, true);
    }
  } catch (e) { toast(e.message, true); }
  S.busy = false; syncButtons();
}
async function del() {
  if (!S.sel || !(await confirmBox('Delete request ' + S.sel.request_no + '?'))) return;
  try { await api('/requests/' + S.sel.id, { method: 'DELETE' }); toast('Deleted'); resetForm(); await loadAll(); }
  catch (e) { toast(e.message, true); }
}
async function notify() {
  if (!S.sel) return toast('Select or save a request first', true);
  try { await api(`/requests/${S.sel.id}/notify`, { method: 'POST' }); toast('Notification sent'); }
  catch (e) { toast(e.message, true); }
}

/* ---------- realtime ---------- */
function connectSocket() {
  const sock = io({ auth: { initData: tg?.initData || '' }, reconnectionDelayMax: 5000 });
  sock.on('connect', () => { setOnline(true); loadAll(); });
  sock.on('disconnect', () => setOnline(false));
  sock.on('connect_error', () => setOnline(false));
  sock.on('requests:changed', (d) => {
    if (d.action === 'deleted' && S.sel?.id === d.id) { toast('This request was deleted by someone else', true); resetForm(); }
    loadAllSoon();
  });
}

/* ---------- init ---------- */
async function init() {
  if (!tg?.initData) { $('#meName').textContent = 'Open this app from Telegram'; return; }
  try {
    const me = await api('/me');
    S.me = me.user; S.depts = me.departments; S.uoms = me.uoms;
  } catch (e) { $('#meName').textContent = e.message; $('#offline').hidden = false; $('#offline p').textContent = e.message; return; }

  $('#meName').textContent = S.me.full_name;
  $('#avatar').textContent = S.me.full_name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  for (const d of S.depts) $('#fDept').append(new Option(d.name, d.id));
  for (const u of S.uoms) $('#fUom').append(new Option(u.code, u.id));
  $('#month').value = S.month;
  resetForm(); connectSocket(); loadAll();
}

/* ---------- events ---------- */
$('#qMinus').onclick = () => { $('#fQty').value = Math.max(1, (+$('#fQty').value || 1) - 1); $('#fQty').dispatchEvent(new Event('input')); };
$('#qPlus').onclick = () => { $('#fQty').value = (+$('#fQty').value || 0) + 1; $('#fQty').dispatchEvent(new Event('input')); };
$('#fQty').oninput = () => { if (!S.totalTouched) $('#fTotal').value = $('#fQty').value; };
$('#fTotal').oninput = () => (S.totalTouched = true);
document.querySelectorAll('#seg button').forEach((b) => (b.onclick = () => setStatus(b.dataset.v)));
document.querySelectorAll('.stat, #pills button').forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; loadAll(); }));
$('#search').oninput = debounce((e) => { S.q = e.target.value.trim(); loadAll(); }, 300);
$('#month').onchange = (e) => { if (e.target.value) { S.month = e.target.value; loadAll(); } };
$('#btnRefresh').onclick = $('#btnRetry').onclick = loadAll;
$('#btnNew').onclick = resetForm;
$('#btnEdit').onclick = () => { S.edit = true; S.totalTouched = true; syncButtons(); };
$('#btnDelete').onclick = del;
$('#btnSave').onclick = save;
$('#btnNotify').onclick = notify;

init();
})();
