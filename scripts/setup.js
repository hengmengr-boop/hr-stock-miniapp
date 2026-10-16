'use strict';
// One-command setup: npm run setup   (add --reset to wipe and recreate tables)
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const pg = require('pg');
const { parseEnv, buildEnv } = require('../lib/envfile');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const old = fs.existsSync(ENV_FILE) ? parseEnv(fs.readFileSync(ENV_FILE, 'utf8')) : {};
const G = (s) => `\x1b[32m${s}\x1b[0m`, R = (s) => `\x1b[31m${s}\x1b[0m`, B = (s) => `\x1b[1m${s}\x1b[0m`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const rawWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
rl._writeToOutput = (s) => { if (rl.muted) { if (/[\r\n]/.test(s)) process.stdout.write(s); } else if (rawWrite) rawWrite(s); else process.stdout.write(s); };
function ask(label, def = '', secret = false) {
  return new Promise((resolve) => {
    const shown = def ? (secret ? ' [Enter = keep saved]' : ` [${def}]`) : '';
    rl.muted = false;
    rl.question(`${label}${shown}: `, (a) => { rl.muted = false; resolve(a.trim() || def); });
    rl.muted = secret;
  });
}
const tg = async (token, method, body) => (await fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();

(async () => {
  console.log(B('\nHR Stock Mini App: setup\n'));

  // 1. Bot token
  let token, me;
  for (;;) {
    token = await ask('1) Bot token from @BotFather (typing is hidden)', old.BOT_TOKEN, true);
    if (!/^\d{6,}:[\w-]{30,}$/.test(token)) { console.log(R('   That does not look like a bot token. Format: 1234567890:AAH...')); continue; }
    try { me = await tg(token, 'getMe'); } catch (e) { console.log(R('   Cannot reach Telegram: ' + e.message + ' (check internet)')); process.exit(1); }
    if (me.ok) { console.log(G(`   ✔ Token valid: @${me.result.username}`)); break; }
    console.log(R('   Telegram rejected this token (revoked or mistyped). Copy the latest one from @BotFather.'));
  }

  // 2. Database
  const db = { DB_HOST: old.DB_HOST || 'localhost', DB_PORT: old.DB_PORT || '5432', DB_USER: old.DB_USER || 'postgres', DB_NAME: old.DB_NAME || 'hr_stock' };
  let admin;
  for (;;) {
    db.DB_PASSWORD = await ask('2) PostgreSQL password (the one you set when installing PostgreSQL)', old.DB_PASSWORD, true);
    admin = new pg.Client({ host: db.DB_HOST, port: +db.DB_PORT, user: db.DB_USER, password: db.DB_PASSWORD, database: 'postgres' });
    try { await admin.connect(); console.log(G('   ✔ Connected to PostgreSQL')); break; }
    catch (e) {
      console.log(R('   Cannot connect: ' + (e.message || e.code)));
      if (/ECONNREFUSED/.test(e.message + e.code)) console.log('   PostgreSQL is not running. Start the "postgresql-x64-16" service (Windows: Win+R -> services.msc), then run setup again.'), process.exit(1);
    }
  }

  // 3. Group + message settings
  const v = { ...db, BOT_TOKEN: token };
  v.NOTIFY_CHAT_ID = await ask('3) Group chat id', old.NOTIFY_CHAT_ID || '-1003996807903');
  v.MENTIONS = await ask('4) Usernames to @mention (comma separated, no @)', old.MENTIONS || 'nhoung_somalin,RA_Hengmeng,pheunborin');
  v.CONTACT_NAME = await ask('5) Contact name shown at the bottom of messages', old.CONTACT_NAME || 'Mr. RA Hengmeng');
  v.AUTO_NOTIFY = old.AUTO_NOTIFY || 'true'; v.SELF_REGISTER = old.SELF_REGISTER || 'true';
  fs.writeFileSync(ENV_FILE, buildEnv(v));
  console.log(G('   ✔ Saved .env'));

  // 4. Create database + tables
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [db.DB_NAME]);
  if (!exists.rowCount) {
    try { await admin.query(`CREATE DATABASE "${db.DB_NAME}" WITH ENCODING 'UTF8' TEMPLATE template0`); }
    catch { await admin.query(`CREATE DATABASE "${db.DB_NAME}"`); }
    console.log(G(`   ✔ Created database ${db.DB_NAME}`));
  } else console.log(G(`   ✔ Database ${db.DB_NAME} already exists`));
  await admin.end();

  const c = new pg.Client({ host: db.DB_HOST, port: +db.DB_PORT, user: db.DB_USER, password: db.DB_PASSWORD, database: db.DB_NAME });
  await c.connect();
  const has = (await c.query(`SELECT to_regclass('public.requests') AS t`)).rows[0].t;
  if (has && !process.argv.includes('--reset')) console.log(G('   ✔ Tables already installed (kept your data; use --reset to wipe)'));
  else {
    await c.query(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
    console.log(G('   ✔ Tables installed (admin: Telegram id 2018611029)'));
  }
  await c.end();

  rl.close();
  console.log(B('\nRunning preflight check...'));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'check.js')], { stdio: 'inherit', cwd: ROOT });
  console.log(r.status === 0 ? G('Setup complete. Next: npm run go') : R('Fix the red items above, then run: npm run setup'));
  process.exit(r.status || 0);
})().catch((e) => { console.error(R('\nSetup failed: ' + e.message)); process.exit(1); });
