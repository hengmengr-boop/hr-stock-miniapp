'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEnv, buildEnv, extractTunnelUrl } = require('../lib/envfile');
const { poolConfig, hasDbConfig } = require('../lib/db');

test('.env round-trip keeps symbols in passwords and Khmer-safe values', () => {
  const v = { BOT_TOKEN: '1:abc', DB_HOST: 'localhost', DB_PORT: '5432', DB_USER: 'postgres', DB_PASSWORD: 'p@ss#w/rd:1!', DB_NAME: 'hr_stock',
    NOTIFY_CHAT_ID: '-1003996807903', MENTIONS: 'a,b', CONTACT_NAME: 'Mr. RA Hengmeng' };
  const back = parseEnv(buildEnv(v));
  for (const k of Object.keys(v)) assert.equal(back[k], v[k], k);
  assert.equal(back.AUTO_NOTIFY, 'true');
});
test('pool config uses DB_* (no URL encoding needed) or DATABASE_URL', () => {
  const c = poolConfig({ DB_PASSWORD: 'p@ss#w/rd', TZ_NAME: 'Asia/Phnom_Penh' });
  assert.equal(c.password, 'p@ss#w/rd'); assert.equal(c.database, 'hr_stock'); assert.equal(c.host, 'localhost'); assert.ok(c.options.includes('Phnom_Penh'));
  assert.equal(poolConfig({ DATABASE_URL: 'postgres://u:p@h/d' }).connectionString, 'postgres://u:p@h/d');
  assert.equal(hasDbConfig({}), false); assert.equal(hasDbConfig({ DB_PASSWORD: 'x' }), true);
});
test('cloudflared output -> public url', () => {
  assert.equal(extractTunnelUrl('2026 INF |  https://quick-brown-fox-123.trycloudflare.com  |'), 'https://quick-brown-fox-123.trycloudflare.com');
  assert.equal(extractTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
});
