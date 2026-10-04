// Netlify 建置時執行：把環境變數 SUPABASE_URL 與 SUPABASE_ANON_KEY 寫進 web/config.js
// 本機測試也可以這樣用：SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/build-config.mjs
import { writeFileSync } from 'node:fs';

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!url || !key) {
  console.error('❌ 缺少環境變數 SUPABASE_URL 或 SUPABASE_ANON_KEY，請到 Netlify → Site configuration → Environment variables 設定。');
  process.exit(1);
}
const fail = msg => { console.error('❌ ' + msg); process.exit(1); };
if (/supabase\.com\/dashboard/.test(url)) fail('SUPABASE_URL 填成了 Supabase 後台的網址。請改成 Project URL，長得像 https://xxxx.supabase.co（在 Supabase → Project Settings → Data API）。');
if (!/^https?:\/\/[^/\s]+$/.test(url)) fail('SUPABASE_URL 格式不對，應該長得像 https://xxxx.supabase.co（後面不要有 /rest/v1 之類的路徑）。目前是：' + url);
if (/\s/.test(key)) fail('SUPABASE_ANON_KEY 中間有空白或換行，請重新複製貼上。');
if (key.startsWith('sb_secret_')) fail('SUPABASE_ANON_KEY 填成了 secret key（不能放在網站上）。請改成 Publishable key（sb_publishable_ 開頭）或 anon public key。');
if (key.startsWith('eyJ')) {
  let role = '';
  try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch (e) { fail('SUPABASE_ANON_KEY 看起來不完整（可能少複製了一段），請重新複製。'); }
  if (role === 'service_role') fail('SUPABASE_ANON_KEY 填成了 service_role key（不能放在網站上）。請改成 anon public key。');
  if (role !== 'anon') fail('SUPABASE_ANON_KEY 不是 anon key（role=' + role + '），請重新複製 anon public key。');
} else if (!key.startsWith('sb_publishable_')) {
  fail('SUPABASE_ANON_KEY 看起來不對。應該是 anon public key（eyJ 開頭的一長串）或 Publishable key（sb_publishable_ 開頭）。');
}
const out = `// 這個檔案由 scripts/build-config.mjs 自動產生，請不要手動修改或提交到 GitHub\nwindow.APP_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key }, null, 2)};\n`;
writeFileSync(new URL('../web/config.js', import.meta.url), out);
console.log('✅ 已產生 web/config.js（' + url + '）');
