'use strict';
// Preflight: node scripts/check.js [--send-test]
require('dotenv').config();
const pg = require('pg');
const { poolConfig, hasDbConfig } = require('../lib/db');
const { BOT_TOKEN, NOTIFY_CHAT_ID } = process.env;
const ok = (m) => console.log('  \x1b[32m✔\x1b[0m ' + m);
const bad = (m) => { console.log('  \x1b[31m✘\x1b[0m ' + m); failed = true; };
let failed = false;
const tgApi = async (method, body) => (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();

(async () => {
  console.log('\nHR Stock Mini App: preflight check\n');
  if (!BOT_TOKEN || /PASTE|your-token/.test(BOT_TOKEN)) bad('BOT_TOKEN missing in .env (run: npm run setup)');
  if (!hasDbConfig()) bad('Database password missing in .env (run: npm run setup)');
  if (!NOTIFY_CHAT_ID) bad('NOTIFY_CHAT_ID missing in .env');
  if (failed) process.exit(1);

  try {
    const pool = new pg.Pool(poolConfig());
    const t = await pool.query(`SELECT to_regclass('public.requests') r, to_regclass('public.users') u, to_regclass('public.v_requests') v`);
    if (t.rows[0].r && t.rows[0].u && t.rows[0].v) ok('Database connected and schema installed');
    else bad('Database connected but schema is missing. Run: npm run setup');
    const a = await pool.query(`SELECT telegram_id, full_name FROM users WHERE role IN ('hr_admin','admin')`).catch(() => ({ rows: [] }));
    a.rows.length ? ok('Admins: ' + a.rows.map((x) => `${x.full_name} (${x.telegram_id})`).join(', ')) : bad('No HR admin user found');
    await pool.end();
  } catch (e) { bad('Database error: ' + e.message); }

  try {
    const me = await tgApi('getMe');
    me.ok ? ok(`Bot token valid: @${me.result.username}`) : bad('Bot token rejected by Telegram: ' + me.description);
    if (me.ok) {
      const chat = await tgApi('getChat', { chat_id: NOTIFY_CHAT_ID });
      chat.ok ? ok(`Group found: "${chat.result.title}"`) : bad(`Cannot access group ${NOTIFY_CHAT_ID}: ${chat.description} (add the bot to the group)`);
      if (chat.ok) {
        const m = await tgApi('getChatMember', { chat_id: NOTIFY_CHAT_ID, user_id: me.result.id });
        const st = m.result?.status;
        ['member', 'administrator', 'creator'].includes(st) ? ok('Bot is in the group (' + st + ')') : bad('Bot is not a member of the group');
        if (process.argv.includes('--send-test') && !failed) {
          const s = await tgApi('sendMessage', { chat_id: NOTIFY_CHAT_ID, text: '✅ HR Stock bot test message' });
          s.ok ? ok('Test message sent to the group') : bad('Could not send: ' + s.description);
        }
      }
    }
  } catch (e) { bad('Cannot reach Telegram API: ' + e.message); }

  console.log(failed ? '\n\x1b[31mFix the items above, then run again.\x1b[0m\n' : '\n\x1b[32mAll good. Start the server: npm start\x1b[0m\n');
  process.exit(failed ? 1 : 0);
})();
