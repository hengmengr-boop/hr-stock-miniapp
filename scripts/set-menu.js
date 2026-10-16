'use strict';
// Usage: node scripts/set-menu.js https://your-domain.com "Stock Request"
require('dotenv').config();
const [url, title = 'Stock Request'] = process.argv.slice(2);
if (!url || !/^https:\/\//.test(url)) { console.error('Usage: node scripts/set-menu.js https://your-url [title]'); process.exit(1); }
(async () => {
  const r = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/setChatMenuButton`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ menu_button: { type: 'web_app', text: title, web_app: { url } } }) })).json();
  console.log(r.ok ? `Menu button set -> ${url}` : 'Failed: ' + r.description);
  process.exit(r.ok ? 0 : 1);
})();
