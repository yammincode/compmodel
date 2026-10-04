// 端對端測試：用 Playwright 開好幾個瀏覽器分頁（主辦、選手、裁判、系統管理員），連真的 Supabase 測試所有功能。
// 需要：一個「測試用」Supabase（本機自架或另開一個專案，不要用正式的），已執行 supabase/schema.sql。
//
// 用法：
//   cd tests && npm install
//   SUPABASE_URL=http://localhost:8000 SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... \
//   IMPORT_FILE=../data/firebase-export.json node e2e-supabase.mjs
//
// SUPABASE_SERVICE_KEY 只用來建立測試用的管理員帳號，絕對不要放進網站或 GitHub。
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_KEY: SERVICE, IMPORT_FILE } = process.env;
const SUPABASE_JS = process.env.SUPABASE_JS || new URL('node_modules/@supabase/supabase-js/dist/umd/supabase.js', import.meta.url).pathname;
if (!URL_ || !ANON || !SERVICE) { console.error('請設定 SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY'); process.exit(1); }

// ---------- 準備測試用系統管理員 ----------
const ADMIN = { email: `admin-${Date.now()}@test.local`, password: 'pw-' + Math.random().toString(36).slice(2) };
const svc = (path, opt = {}) => fetch(URL_ + path, { ...opt, headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
const created = await (await svc('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ ...ADMIN, email_confirm: true }) })).json();
if (!created.id) { console.error('建立測試管理員失敗', created); process.exit(1); }
const ins = await svc('/rest/v1/app_admins', { method: 'POST', body: JSON.stringify({ user_id: created.id }) });
if (!ins.ok) { console.error('設定 app_admins 失敗', await ins.text()); process.exit(1); }

// ---------- 小型網站伺服器（模擬 Netlify） ----------
const CONFIG = `window.APP_CONFIG=${JSON.stringify({ supabaseUrl: URL_, supabaseAnonKey: ANON })};`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/config.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(CONFIG); }
  const f = join(ROOT, 'web', p === '/' ? 'index.html' : p);
  if (!f.startsWith(join(ROOT, 'web')) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
}).listen(8765);
const SITE = 'http://localhost:8765/';
const SBJS = readFileSync(SUPABASE_JS, 'utf8');

const res = [];
const check = (n, c, x = '') => { res.push(!!c); console.log((c ? '✅' : '❌'), n, x); };
const alerts = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) {} await wait(150); } return false; }

const browser = await chromium.launch();
const allErrs = [];
async function phone(answers = [], url = SITE) {
  // 每支「手機」用獨立的瀏覽器環境，登入身分互不影響
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => allErrs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource/.test(m.text())) allErrs.push(m.text()); });
  page.on('dialog', d => { if (d.type() === 'prompt') d.accept(answers.shift() ?? ''); else { if (d.type() === 'alert') alerts.push(d.message()); d.accept(); } });
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('cdn.jsdelivr.net/npm/@supabase/supabase-js')) return r.fulfill({ body: SBJS, contentType: 'text/javascript' });
    if (u.includes('fonts.g')) return r.abort();
    return r.continue();
  });
  await page.goto(url);
  await until(() => page.isVisible('#portalView, #compView').catch(() => false));
  return page;
}
const vis = (p, s) => p.isVisible(s);
const text = (p, s) => p.innerText(s);

try {
  // ---------- 系統管理員：登入、匯入舊資料 ----------
  const S = await phone([ADMIN.email, ADMIN.password]);
  check('一般人看不到匯入匯出', !(await vis(S, '#importBtn')));
  check('網站最下方顯示版本號', /^v\d+\.\d+$/.test(await text(S, '#verText')), await text(S, '#verText'));
  check('一般人看不到更新紀錄', !(await vis(S, '#verBtn')) && !(await vis(S, '#verCard')));
  await S.click('#loginBtn');
  check('系統管理員登入', await until(() => vis(S, '#importBtn')));
  await S.click('#verBtn');
  check('系統管理員點開更新紀錄', await vis(S, '#verCard') && (await text(S, '#verList')).includes(await text(S, '#verText')));
  await S.click('#verBtn');
  if (IMPORT_FILE && existsSync(IMPORT_FILE)) {
    const n0 = alerts.length;
    await S.setInputFiles('#importInput', IMPORT_FILE);
    await until(() => alerts.length > n0, 60000);
    check('匯入舊資料（Firebase 匯出檔）', /匯入完成/.test(alerts.at(-1)), alerts.at(-1));
    await until(() => text(S, '#compList').then(t => t.includes('原岩模擬賽')));
    await S.click('.comp-item:has-text("原岩模擬賽")');
    await until(() => vis(S, '#compView'));
    await until(() => text(S, '#board').then(t => !t.includes('載入中')));
    const board = await text(S, '#board');
    check('舊資料選手都在', ['君欣', '語埕', '惟學'].every(n => board.includes(n)), board.split('\n').slice(0, 3).join(' '));
    // 第一個有照片的路線
    const tab = S.locator('.tab:has-text("📷")').first();
    check('路線分頁標示有照片', await tab.count() > 0);
    await tab.click();
    const imgOk = await until(() => S.evaluate(() => $('photoImg').complete && $('photoImg').naturalWidth > 0));
    check('舊照片從 Storage 顯示', imgOk, await S.evaluate(() => $('photoImg').src));
    check('舊照片的圈圈標記保留', await S.evaluate(() => $('photoSvg').querySelectorAll('g').length) > 0);
    await S.click('#backBtn');
  }

  // ---------- A：一般人（匿名）建立比賽 ----------
  const A = await phone();
  check('一般人看得到「建立新比賽」', await until(() => vis(A, '#newCompBtn')));
  await A.click('#newCompBtn'); await A.fill('#sTitle', '小明的練習賽');
  const n1 = alerts.length;
  check('建立比賽可選三種計時方式（預設教練統一計時）', await A.locator('#sMode button').count() === 3 && (await A.innerText('#sMode .on')).includes('教練計時'));
  await A.click('#startComp');
  await until(() => alerts.length > n1);
  const k = (alerts.at(-1).match(/管理碼：([A-Z0-9]{6})/) || [])[1] || '';
  check('一般人建立比賽成功並拿到管理碼', (await vis(A, '#compView')) && k.length === 6, k);
  check('主辦看到計時控制', await vis(A, '#tToggle'));
  check('主辦看到管理碼', await until(() => text(A, '#keyLine').then(t => t.includes(k))));
  check('主辦不會看到報名表', !(await vis(A, '#joinCard')));
  await A.click('#tToggle');
  check('主辦開始計時', await until(() => text(A, '#tToggle').then(t => t.includes('暫停'))));
  const compUrl = A.url();
  check('比賽有自己的網址（可以分享）', /\?c=/.test(compUrl), compUrl);
  check('比賽頁顯示 10 天後自動刪除', await until(() => text(A, '#expiryText').then(t => /10 天後.*自動刪除/.test(t))), await text(A, '#expiryText'));
  check('主辦看不到「永久保留」按鈕', !(await vis(A, '#keepBtn')));
  let rr = await A.evaluate(async () => { const { error } = await sb.from('comps').update({ expires_at: null }).eq('id', compId); return error ? 'blocked' : 'ok'; });
  check('主辦繞過畫面也不能延長／永久保留', rr !== 'ok', rr);

  // ---------- B：選手點連結進來 ----------
  const B = await phone([], compUrl);
  check('點連結直接進到比賽', await until(() => vis(B, '#compView')));
  check('別人進比賽看到報名表', await until(() => vis(B, '#joinCard')));
  check('選手不能控制計時', !(await vis(B, '#tToggle')));
  check('選手看不到管理碼', !(await vis(B, '#keyLine')));
  const cA = await text(A, '#tClock'), cB = await text(B, '#tClock');
  check('選手計時和主辦同步', cA === cB || Math.abs(toSec(cA) - toSec(cB)) <= 1, `${cA} / ${cB}`);
  const c1 = await text(B, '#tClock'); await wait(2100); const c2 = await text(B, '#tClock');
  check('選手的計時器在走', c1 !== c2, `${c1}→${c2}`);
  await B.fill('#joinName', '阿華'); await B.click('#joinBtn');
  check('選手報名成功', await until(() => vis(B, '#nowCard')));
  await B.click('.act.z'); await wait(300); await B.click('.act.t');
  check('選手自己記分 (第2次Top=24.9)', await until(() => text(B, '#nowScore').then(t => t === '24.9')), await text(B, '#nowScore'));
  check('主辦即時看到成績', await until(() => text(A, '#board').then(t => t.includes('阿華') && t.includes('24.9'))));
  await B.reload();
  check('選手重新整理後還是同一個人（成績還在）', await until(() => text(B, '#meText').then(t => t.includes('阿華'))));

  // ---------- 權限：繞過畫面直接呼叫資料庫 ----------
  let r = await B.evaluate(async () => { const { data, error } = await sb.from('comps').update({ timer: { round: 9, running: false, elapsed: 0, startedAt: 0 } }).eq('id', compId).select(); return error ? 'error' : data.length ? 'ok' : 'blocked'; });
  check('選手不能改計時', r !== 'ok', r);
  r = await B.evaluate(async () => { const { data } = await sb.from('comp_keys').select('*').eq('comp_id', compId); return data && data.length ? 'ok' : 'blocked'; });
  check('選手讀不到管理碼', r !== 'ok', r);
  r = await B.evaluate(async () => { const { error } = await sb.from('entries').insert({ comp_id: compId, user_id: '00000000-0000-0000-0000-000000000000', name: 'x', division: 'x' }); return error ? 'blocked' : 'ok'; });
  check('選手不能改別人成績', r !== 'ok', r);
  await A.click('#selfToggle');
  await until(() => B.evaluate(() => M.comp.selfScoring === false));
  r = await B.evaluate(async () => { const { error } = await sb.from('entries').update({ results: {} }).eq('comp_id', compId).eq('user_id', myId); return error ? 'blocked' : 'ok'; });
  check('關閉自行記分後，選手繞過畫面也改不了', r !== 'ok', r);
  await B.click('.tab:has-text("路線 1")');
  check('關閉後按鈕鎖住', await until(() => vis(B, '#lockMsg')) && await B.locator('.act.f').isDisabled());
  await A.click('#selfToggle');
  await until(() => B.evaluate(() => M.comp.selfScoring === true));
  if (IMPORT_FILE && existsSync(IMPORT_FILE)) {
    r = await B.evaluate(async () => { const id = Object.keys(comps).find(k => comps[k].title === '原岩模擬賽'); const { data } = await sb.from('comps').delete().eq('id', id).select(); return data && data.length ? 'ok' : 'blocked'; });
    check('選手不能刪別人的比賽', r !== 'ok', r);
  }

  // ---------- C：用管理碼成為協同主辦 ----------
  const C = await phone(['WRONG1', k.toLowerCase()], compUrl);
  await until(() => vis(C, '#claimLine'));
  check('別人進來先是一般身分', !(await vis(C, '#tToggle')) && await vis(C, '#claimLine'));
  const n2 = alerts.length;
  await C.click('#claimBtn'); await until(() => alerts.length > n2);
  check('輸入錯的管理碼被拒', !(await vis(C, '#tToggle')) && alerts.at(-1).includes('不正確'), alerts.at(-1));
  await C.click('#claimBtn');
  check('輸入正確管理碼變成主辦，可以計時', await until(() => vis(C, '#tToggle')));
  await C.click('#tToggle');
  check('協同主辦暫停，大家同步', await until(() => text(A, '#tToggle').then(t => /開始|繼續/.test(t))), await text(A, '#tToggle'));
  check('協同主辦看得到管理碼', await until(() => text(C, '#keyLine').then(t => t.includes(k))));

  // ---------- 計時方式切換 ----------
  await A.click('#modeSeg [data-mode="self"]');
  check('切成「學員各自計時」，選手可以自己控制計時', await until(() => vis(B, '#tToggle')) && (await text(B, '#tPhase')).includes('我的計時'));
  await B.click('#tToggle');
  check('選手開始自己的計時', await until(() => text(B, '#tToggle').then(t => t.includes('暫停'))));
  check('選手自己的計時不影響別人', (await text(C, '#tToggle')).includes('開始'), await text(C, '#tToggle'));
  await A.click('#modeSeg [data-mode="both"]');
  check('切成「兩種都可以」，選手預設看教練計時（不能控制）', await until(() => vis(B, '#tSwitch')) && await until(() => text(B, '#timerLineText').then(t => t.includes('教練計時'))) && !(await vis(B, '#tToggle')));
  await B.click('#tSwitch');
  check('選手按 ⇄ 切換成自己的計時（剛才的計時還在跑）', await until(() => text(B, '#timerLineText').then(t => t.includes('我的計時'))) && await vis(B, '#tToggle') && (await text(B, '#tToggle')).includes('暫停'));
  await A.click('#modeSeg [data-mode="shared"]');
  check('切回「教練統一計時」，選手不能控制、沒有切換鈕', await until(() => B.evaluate(() => $('tSwitch').hidden && $('timerLine').hidden)) && !(await vis(B, '#tToggle')) && !(await text(B, '#tPhase')).includes('我的計時'));

  // ---------- 主辦幫選手記分、刪除選手 ----------
  await A.click('.row:has-text("阿華")');
  check('主辦可以幫選手改', await until(() => vis(A, '#nowCard')) && (await text(A, '#nowName')).includes('阿華'));
  await A.fill('#nameInput', '裁判記的選手'); await A.click('#addBtn');
  await A.click('.act.f'); await wait(200); await A.click('.act.z');
  check('主辦新增選手並記分，選手端同步看到', await until(() => text(B, '#board').then(t => t.includes('裁判記的選手') && t.includes('9.9'))));
  await A.click('#delBtn');
  check('主辦刪除選手，大家同步', await until(() => text(B, '#board').then(t => !t.includes('裁判記的選手'))));

  // ---------- 路線照片 ----------
  const img = join(mkdtempSync(join(tmpdir(), 'e2e-')), 'wall.png');
  writeFileSync(img, Buffer.from(await A.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = '#8a7'; g.fillRect(0, 0, 1600, 1200); g.fillStyle = '#c33'; g.fillRect(700, 500, 200, 200); return c.toDataURL('image/png').split(',')[1]; }), 'base64'));
  await A.click('.tab:has-text("路線 1")');
  await A.setInputFiles('#photoInput', img);
  check('上傳照片後自動打開圈路線編輯器', await until(() => vis(A, '#editor'), 15000));
  const box = await A.locator('#edSvg').boundingBox();
  await A.click('#edTools [data-tool="top"]');
  await A.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await A.click('#edTools [data-tool="hand"]');
  await A.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.8);
  await A.click('#edSave');
  await B.click('.tab:has-text("路線 1")');
  check('選手看到照片', await until(() => B.evaluate(() => !$('photoBox').hidden && $('photoImg').naturalWidth > 0)));
  check('照片壓縮到長邊 1000px', await B.evaluate(() => $('photoImg').naturalWidth) === 1000, String(await B.evaluate(() => $('photoImg').naturalWidth)));
  check('選手看到圈好的路線（2 個圈）', await until(() => B.evaluate(() => $('photoSvg').querySelectorAll('g').length === 2)));
  await B.click('#photoBox');
  check('點照片可全螢幕放大', await vis(B, '#lightbox'));
  await B.click('#lightbox');

  // ---------- 系統管理員管理別人的比賽、匯出 ----------
  await S.goto(compUrl);
  check('系統管理員可以管理別人建的比賽', await until(() => vis(S, '#tToggle')));
  check('系統管理員看得到「永久保留」按鈕', await vis(S, '#keepBtn'));
  await S.click('#keepBtn');
  check('系統管理員設成永久保留，選手端同步看到', await until(() => text(B, '#expiryText').then(t => t.includes('永久保留'))));
  await S.click('#keepBtn');
  check('改回 10 天後刪除', await until(() => text(B, '#expiryText').then(t => /天後.*自動刪除/.test(t))));
  await S.click('#backBtn');
  check('入口頁列出剩幾天自動刪除', /天後自動刪除/.test(await text(S, '#compList')));
  const [dl] = await Promise.all([S.waitForEvent('download', { timeout: 60000 }), S.click('#exportBtn')]);
  const exp = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  const keys = Object.keys(exp.docs);
  check('匯出含選手報名、管理碼與照片', keys.some(x => x.includes('/entries/')) && keys.some(x => x.startsWith('compKeys/'))
    && keys.filter(x => x.includes('/photos/')).every(x => String(exp.docs[x].data).startsWith('data:image')), `${keys.length} 筆`);

  // ---------- 清除成績、刪除比賽 ----------
  await A.click('#resetBtn');
  check('清除成績後選手端也清空', await until(() => text(B, '#board').then(t => !t.includes('阿華'))));
  const cid = await A.evaluate(() => compId);
  await A.click('#delCompBtn');
  check('刪除比賽後大家回到入口', await until(() => vis(B, '#portalView')) && await until(() => vis(A, '#portalView')));
  const left = await B.evaluate(async id => { const { data } = await sb.storage.from('route-photos').list(id); return (data || []).length; }, cid);
  check('刪除比賽時照片檔也一起刪掉', left === 0, String(left));
  check('入口頁不再列出被刪的比賽', !(await text(B, '#compList')).includes('小明的練習賽'));

  // 比賽被自動刪除後留下的照片檔：系統管理員打開網站時會清掉
  const orphan = 'orphan' + Date.now();
  await fetch(`${URL_}/storage/v1/object/route-photos/${orphan}/x.jpg`, { method: 'POST', headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  const listOrphan = async () => (await (await svc('/storage/v1/object/list/route-photos', { method: 'POST', body: JSON.stringify({ prefix: orphan + '/' }) })).json()).length;
  const before = await listOrphan();
  await S.reload();
  check('系統管理員打開網站時清掉已刪除比賽的照片檔', before === 1 && await until(async () => (await listOrphan()) === 0, 15000), `前 ${before}`);
  check('沒有程式錯誤', !allErrs.length, allErrs.slice(0, 4).join(' | '));
} catch (e) {
  console.error(e); res.push(false);
} finally {
  await browser.close(); server.close();
  await svc('/auth/v1/admin/users/' + created.id, { method: 'DELETE' });
}
function toSec(t) { const [m, s] = t.split(':').map(Number); return m * 60 + s; }
console.log(`\n通過 ${res.filter(Boolean).length} / ${res.length}`);
process.exit(res.every(Boolean) ? 0 : 1);
