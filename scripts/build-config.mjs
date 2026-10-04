// Netlify 建置時執行：把環境變數 SUPABASE_URL 與 SUPABASE_ANON_KEY 寫進 web/config.js
// 本機測試也可以這樣用：SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/build-config.mjs
import { writeFileSync } from 'node:fs';

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!url || !key) {
  console.error('❌ 缺少環境變數 SUPABASE_URL 或 SUPABASE_ANON_KEY，請到 Netlify → Site configuration → Environment variables 設定。');
  process.exit(1);
}
if (!/^https?:\/\//.test(url)) {
  console.error('❌ SUPABASE_URL 應該長得像 https://xxxx.supabase.co');
  process.exit(1);
}
const out = `// 這個檔案由 scripts/build-config.mjs 自動產生，請不要手動修改或提交到 GitHub\nwindow.APP_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key }, null, 2)};\n`;
writeFileSync(new URL('../web/config.js', import.meta.url), out);
console.log('✅ 已產生 web/config.js（' + url + '）');
