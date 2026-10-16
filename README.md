# HR Stock Request: Telegram Mini App (real-time)
Node.js + Express + Socket.IO + PostgreSQL + Telegram WebApp SDK.

## A. Run on your Windows PC (testing, about 10 minutes)
1. Install **Node.js 20 LTS**, **PostgreSQL 16** (remember the password) and **cloudflared**
   (`winget install Cloudflare.cloudflared`). Add the bot to your group (admin if the group blocks bots).
2. In this folder (PowerShell):
```powershell
npm install
npm run setup     # asks for bot token + PostgreSQL password, creates .env, database and tables, then runs the check
npm run go        # starts server + public HTTPS tunnel + updates the bot's menu button automatically
```
3. Open your bot in Telegram, tap **Stock Request**, save a request. It appears in the group and on every open phone instantly.
Keep the `npm run go` window open while people use the app. Each restart creates a new tunnel link; `npm run go` updates the button for you.

Other commands: `npm run check` (diagnose), `npm run check:send` (post a test message to the group),
`npm test` (automated tests), `npm run setup -- --reset` (wipe data and recreate tables).

## B. Production (24/7, recommended)
Use a small VPS (Ubuntu) with a domain. Keep the PC tunnel only for testing; the quick tunnel URL changes on each restart.
```bash
cp .env.example .env && nano .env          # DB_PASSWORD is used by docker-compose too
docker compose up -d --build               # app + PostgreSQL, schema auto-loaded on first start
curl http://127.0.0.1:3000/health          # {"ok":true}
```
Nginx + HTTPS (`certbot --nginx`):
```nginx
server {
  server_name stock.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;   # realtime websockets
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```
Then: `npm run menu -- https://stock.example.com "Stock Request"` (once). Back up daily: `pg_dump hr_stock > backup.sql`.

## C. Roles
- Seeded admin: Telegram id 2018611029 (RA Hengmeng). Others register automatically as `requester`.
- requester: sees and edits only own requests while Open; cannot close.
- hr_admin / admin: sees all; edit, close, delete any.
```sql
UPDATE users SET role='hr_admin', position='HR/Admin Officer',
  department_id=(SELECT id FROM departments WHERE name='HR/Admin') WHERE telegram_id=<their id>;
```
Set a requester's position (it appears in the group message): `UPDATE users SET position='Procurement -IAES' WHERE telegram_id=<id>;`

## D. Troubleshooting
| Symptom | Fix |
|---|---|
| `npm run check` says chat not found | Bot is not in the group, or wrong NOTIFY_CHAT_ID |
| "Open this app from Telegram" | Opened in a normal browser; use the bot's button |
| Chip shows Offline / "backend offline" | Server or tunnel stopped; restart, and re-run `npm run menu` if the tunnel URL changed |
| "Access denied" | `SELF_REGISTER=false` and the user is not in `users` |
| Notification not sent | Check `notifications` table: `SELECT * FROM notifications ORDER BY id DESC LIMIT 5;` |

## E. Security
Every API call and socket is verified with Telegram initData (HMAC, 24h expiry), SQL is parameterized,
CSP + rate limiting enabled, writes are permission-checked, bot messages are HTML-escaped.
**Never share BOT_TOKEN.** If it leaks, revoke it in @BotFather and update `.env`.
