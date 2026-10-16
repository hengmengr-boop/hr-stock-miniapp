'use strict';
// npm run go : starts the server, opens a public HTTPS tunnel, and points the bot's menu button to it.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { extractTunnelUrl } = require('../lib/envfile');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const G = (s) => `\x1b[32m${s}\x1b[0m`, R = (s) => `\x1b[31m${s}\x1b[0m`;
const kids = [];
const stop = () => { kids.forEach((k) => { try { k.kill(); } catch {} }); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

function findCloudflared() {
  const cands = ['cloudflared', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')];
  return cands.find((c) => (c === 'cloudflared' ? spawnSync(c, ['--version']).status === 0 : fs.existsSync(c)));
}
async function setMenu(url) {
  const r = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/setChatMenuButton`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ menu_button: { type: 'web_app', text: 'Stock Request', web_app: { url } } }) })).json();
  return r;
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if ((await r.json()).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: 'inherit' });
  kids.push(server); server.on('exit', (c) => { console.log(R(`Server stopped (code ${c}). Run "npm run check" to find the problem.`)); stop(); });
  if (!(await waitHealthy())) { console.log(R('Server did not become healthy. Run: npm run check')); return stop(); }
  console.log(G(`✔ Server running on http://localhost:${PORT}`));

  if (process.env.PUBLIC_URL) {                       // production: fixed domain
    const r = await setMenu(process.env.PUBLIC_URL);
    console.log(r.ok ? G('✔ Bot button -> ' + process.env.PUBLIC_URL) : R('Menu button failed: ' + r.description));
    return;
  }
  const cf = findCloudflared();
  if (!cf) { console.log(R('cloudflared not found. Install it:  winget install Cloudflare.cloudflared   (then open a NEW terminal and run: npm run go)')); return; }
  const t = spawn(cf, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate']); kids.push(t);
  let done = false;
  const onData = async (d) => {
    const url = !done && extractTunnelUrl(d.toString());
    if (!url) return; done = true;
    const r = await setMenu(url);
    console.log(r.ok ? G(`✔ Public link: ${url}\n✔ Bot menu button updated.\n\nOpen @${(await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe`)).json()).result.username} in Telegram and tap "Stock Request".\nKeep this window open. Press Ctrl+C to stop.`)
                : R('Tunnel ok but menu button failed: ' + r.description));
  };
  t.stdout.on('data', onData); t.stderr.on('data', onData);
  t.on('exit', () => { console.log(R('Tunnel stopped.')); stop(); });
})();
