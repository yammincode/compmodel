'use strict';
/* =========================================================
   原岩攀岩比賽系統（Supabase 版）
   設定值（Supabase 網址與 anon key）放在 config.js，由 Netlify 建置時自動產生。
   ========================================================= */
const CFG = window.APP_CONFIG || {};
const BUCKET = 'route-photos';

const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const $ = id => document.getElementById(id);
const MIN = 60000;
const PREF_KEY = 'origin-climb-portal-prefs';
const DEFAULT_TIMER = {round:1,running:false,elapsed:0,startedAt:0};

/* ---------- 狀態 ---------- */
let sb=null, myId=null, myEmail=null, isAnon=true;
let readOnly=true, isAdmin=false, isSuper=false, coAdmin=false, compKey=null, entryBlocked=false;
let page='portal';           // portal | setup | comp
let compId=null;
let comps={};                // 所有比賽清單 {id: comp}
const M={ climbers:{}, results:{}, photos:{}, entries:{} };
Object.defineProperty(M,'comp',{ get:()=>compId?comps[compId]||null:null });
let compChannel=null, compsLoaded=false, compDataLoaded=false;

let prefs={ div:null, view:'total', selected:null, sound:true };
try{ prefs.sound = JSON.parse(localStorage.getItem(PREF_KEY)||'{}').sound!==false; }catch(e){}
function savePrefs(){ try{ localStorage.setItem(PREF_KEY, JSON.stringify({sound:prefs.sound})); }catch(e){} }

/* ---------- 時鐘校正：用伺服器時間，各手機的計時器才會一致 ---------- */
let clockOffset=0;
const now=()=>Date.now()+clockOffset;
async function syncClock(){
  let best=null;
  for(let i=0;i<3;i++){
    const t0=Date.now(); const {data,error}=await sb.rpc('server_now_ms'); const t1=Date.now();
    if(error||data==null) return;
    if(!best||t1-t0<best.rtt) best={rtt:t1-t0, off:Number(data)-(t0+t1)/2};
  }
  clockOffset=Math.round(best.off);
}

/* ---------- 資料轉換（資料庫欄位 ↔ 畫面用的格式） ---------- */
const ms=t=>t?Date.parse(t):0;
const iso=v=>new Date(v||Date.now()).toISOString();
const rKey=(cid,rid)=>cid+'__'+rid;
function compFromRow(r){
  return { id:r.id, title:r.title, ownerId:r.owner_id, divisions:Array.isArray(r.divisions)?r.divisions:[],
    config:r.config||{climbMin:4,restMin:0}, timer:r.timer||DEFAULT_TIMER, selfScoring:r.self_scoring!==false, createdAt:ms(r.created_at),
    expiresAt:r.expires_at===undefined?undefined:(r.expires_at?ms(r.expires_at):null) };   // null = 永久保留；undefined = 舊版資料庫沒有這個欄位
}
const climberFromRow=r=>({ name:r.name, division:r.division, createdAt:ms(r.created_at) });
const resultFromRow=r=>({ attempts:r.attempts||[] });
const entryFromRow=r=>({ name:r.name, division:r.division, joinedAt:ms(r.joined_at), results:r.results||{} });
const publicUrl=p=>sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
const photoFromRow=r=>({ path:r.image_path, url:publicUrl(r.image_path), w:r.w, h:r.h, marks:r.marks||[], at:ms(r.updated_at) });

/* ---------- 十天自動刪除 ---------- */
const DAY=86400000;
function isExpired(c){ return !!(c&&c.expiresAt&&c.expiresAt<now()); }
function expiryText(c, long){
  if(!c||c.expiresAt===undefined) return '';
  if(c.expiresAt===null) return long?'📌 系統管理員已設定永久保留，不會自動刪除':'永久保留';
  const d=Math.ceil((c.expiresAt-now())/DAY), dt=new Date(c.expiresAt), md=`${dt.getMonth()+1}/${dt.getDate()}`;
  const left=d<=1?'明天前':`${d} 天後`;
  return long?`🗓 這場比賽會在 ${md}（${left}）自動刪除，需要保留請找系統管理員`:`${left}自動刪除`;
}

/* ---------- 寫入與錯誤處理 ---------- */
let warned=false;
// 錯誤的技術細節（小字附在提示最後，截圖給開發者看用）
function errDetail(e){
  const code=e&&e.code, msg=String((e&&e.message)||e||'').slice(0,160);
  return msg?`\n\n（錯誤代碼：${code||'-'}・${msg}）`:'';
}
function writeFailed(error){
  console.warn('write failed', error);
  const msg=(error&&error.message)||'';
  if(msg.includes('自行記分')) alert('主辦已關閉自行記分，這筆成績沒有存到。');
  else if(error&&(error.code==='42501'||/row-level security|permission/i.test(msg)))
    alert('你沒有權限做這件事。\n\n如果這是不應該被擋的操作（例如選手報名），請主辦到 Supabase 的 SQL Editor 執行健康檢查 supabase/check-setup.sql。'+errDetail(error));
  else if(!warned){ warned=true; alert('資料沒有存成功，請檢查網路後再試一次。'+errDetail(error)); setTimeout(()=>warned=false,5000); }
  resync();
}
// 執行一個 Supabase 寫入，失敗就提示並重新同步資料
async function run(q){
  try{ const {error}=await q; if(error){ writeFailed(error); return false; } return true; }
  catch(e){ writeFailed(e); return false; }
}
// 讀一整張表（超過 1000 筆會分批讀）
async function fetchAll(table, cid, order){
  const out=[];
  for(let from=0;;from+=1000){
    let q=sb.from(table).select('*');
    if(cid) q=q.eq('comp_id',cid);
    order.forEach(o=>q=q.order(o));
    const {data,error}=await q.range(from,from+999);
    if(error) throw error;
    out.push(...data);
    if(data.length<1000) return out;
  }
}

/* ---------- 讀取與即時同步 ---------- */
// 比賽被自動刪除後照片檔會留在 Storage，系統管理員登入時順手清掉（每次開網站最多一次）
let photosCleaned=false;
async function cleanOrphanPhotos(){
  if(!isSuper||photosCleaned||!compsLoaded) return;
  photosCleaned=true;
  try{
    const {data:folders}=await sb.storage.from(BUCKET).list('',{limit:1000});
    for(const f of folders||[]){
      if(f.id||comps[f.name]) continue;     // f.id 有值代表是檔案不是資料夾
      const {data:files}=await sb.storage.from(BUCKET).list(f.name,{limit:1000});
      if(files&&files.length) await sb.storage.from(BUCKET).remove(files.map(x=>`${f.name}/${x.name}`));
    }
  }catch(e){ console.warn('clean photos failed',e); }
}
async function loadComps(){
  try{
    const rows=await fetchAll('comps',null,['id']);
    const o={}; rows.forEach(r=>o[r.id]=compFromRow(r)); comps=o; compsLoaded=true;
    setProblem('comps', null);
    cleanOrphanPhotos();
    if(compId&&!comps[compId]) leaveComp();
    render();
  }catch(e){ setProblem('comps', e); }
}
let entriesLoadedFor=null;
async function loadCompData(id){
  try{
    const [cl,rs,en,ph]=await Promise.all([
      fetchAll('climbers',id,['id']), fetchAll('results',id,['climber_id','route_id']),
      fetchAll('entries',id,['user_id']), fetchAll('photos',id,['route_id'])]);
    if(compId!==id) return;
    M.climbers={}; cl.forEach(r=>M.climbers[r.id]=climberFromRow(r));
    M.results={};  rs.forEach(r=>M.results[rKey(r.climber_id,r.route_id)]=resultFromRow(r));
    M.entries={};  en.forEach(r=>M.entries[r.user_id]=entryFromRow(r));
    M.photos={};   ph.forEach(r=>M.photos[r.route_id]=photoFromRow(r));
    compDataLoaded=true;
    if(entriesLoadedFor!==id){ entriesLoadedFor=id; const me=myId&&M.entries[myId]; if(me) prefs.div=me.division; }
    render();
  }catch(e){ console.warn('load comp failed',e); }
}
async function loadRole(id){
  coAdmin=false; compKey=null;
  if(myId){
    const {data}=await sb.from('comp_admins').select('user_id').eq('comp_id',id).eq('user_id',myId);
    if(compId!==id) return;
    coAdmin=!!(data&&data.length);
  }
  loadKey(); render();
}
async function loadKey(){
  refreshRole();
  if(!isAdmin||compKey||!compId) return;
  const id=compId;
  const {data}=await sb.from('comp_keys').select('key').eq('comp_id',id);
  if(compId===id&&data&&data[0]){ compKey=data[0].key; render(); }
}
function resync(){ loadComps(); if(compId) loadCompData(compId); }

let compsChannel=null;
function startCompsChannel(){
  if(compsChannel) return;
  compsChannel=sb.channel('comps-all')
    .on('postgres_changes',{event:'*',schema:'public',table:'comps'},p=>{
      if(p.eventType==='DELETE'){ const id=p.old&&p.old.id; delete comps[id]; if(id&&id===compId) leaveComp(); }
      else comps[p.new.id]=compFromRow(p.new);
      render();
    })
    .subscribe(s=>{ if(s==='SUBSCRIBED') loadComps(); });
}
// 每張表：新增／修改只收這場比賽的；刪除事件 Supabase 不能篩選，所以全收再自己比對
const TABLES={
  climbers:{ key:r=>r.id, map:climberFromRow },
  results: { key:r=>rKey(r.climber_id,r.route_id), map:resultFromRow },
  entries: { key:r=>r.user_id, map:entryFromRow },
  photos:  { key:r=>r.route_id, map:photoFromRow },
};
function startCompChannel(id){
  let ch=sb.channel('comp-'+id);
  for(const [t,d] of Object.entries(TABLES)){
    const up=p=>{ if(compId!==id||!p.new||p.new.comp_id!==id) return; M[t][d.key(p.new)]=d.map(p.new); render(); };
    const filter='comp_id=eq.'+id;
    ch=ch.on('postgres_changes',{event:'INSERT',schema:'public',table:t,filter},up)
         .on('postgres_changes',{event:'UPDATE',schema:'public',table:t,filter},up)
         .on('postgres_changes',{event:'DELETE',schema:'public',table:t},p=>{
           const o=p.old||{}; if(compId!==id||(o.comp_id&&o.comp_id!==id)) return;
           const k=d.key(o); if(k in M[t]){ delete M[t][k]; render(); }
         });
  }
  compChannel=ch.subscribe(s=>{ if(s==='SUBSCRIBED') loadCompData(id); });
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&started){ syncClock(); resync(); }
});

/* ---------- 連線問題說明：把 Supabase 的錯誤翻成白話，告訴主辦哪裡設定錯 ---------- */
let setupProblems={};   // {comps: '...', anon: '...'}
function explainError(e){
  const msg=String((e&&(e.message||e.msg||e.error_description))||e||'');
  const code=String((e&&(e.code||e.error_code))||'');
  if(/secret API key|service_role/i.test(msg)) return 'Netlify 的 SUPABASE_ANON_KEY 填成了 secret / service_role key。請改成 anon public key 或 Publishable key，然後重新部署。';
  if(/Invalid API key|No API key|apikey|JWS|JWT|Unauthorized/i.test(msg)||code==='401') return 'Netlify 的 SUPABASE_ANON_KEY 不正確（可能少複製了一段）。請到 Supabase → Project Settings → API Keys 重新複製，然後重新部署。';
  if(/anonymous sign-ins are disabled/i.test(msg)||code==='anonymous_provider_disabled') return '匿名登入還沒打開：Supabase → Authentication → Sign In / Providers → 打開 Allow anonymous sign-ins。';
  if(/rate limit|too many/i.test(msg)||code==='over_request_rate_limit') return '匿名登入次數超過上限：Supabase → Authentication → Rate Limits，把匿名登入上限調高（例如 300）。';
  if(/does not exist|Could not find the table|schema cache/i.test(msg)||code==='42P01'||code==='PGRST205') return '資料庫還沒建立：請到 Supabase → SQL Editor 貼上整份 supabase/schema.sql 並按 Run。';
  if(/permission denied/i.test(msg)||code==='42501') return '資料庫權限沒設好：請到 Supabase → SQL Editor 重新執行整份 supabase/schema.sql。';
  if(/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return `連不到 Supabase（${CFG.supabaseUrl}）。請確認 Netlify 的 SUPABASE_URL 是 https://xxxx.supabase.co 這種格式，以及 Supabase 專案沒有被暫停（Paused）。`;
  return '連線發生問題：'+msg;
}
function setProblem(key, e){
  if(e) console.warn(key, e);
  const next=e?explainError(e):null;
  if(next===(setupProblems[key]||null)) return;
  if(next) setupProblems[key]=next; else delete setupProblems[key];
  if(started) render();
}

/* ---------- 登入 ---------- */
let started=false, signingIn=false;
async function init(){
  if(!window.supabase||!CFG.supabaseUrl||!CFG.supabaseAnonKey){
    $('loadingView').textContent=!window.supabase
      ? '載入 Supabase 程式失敗，請檢查網路後重新整理。'
      : '尚未設定 Supabase：請在 Netlify 設定 SUPABASE_URL 與 SUPABASE_ANON_KEY（本機測試請建立 config.js）。';
    return;
  }
  try{ sb=window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey); }
  catch(e){ $('loadingView').textContent='Supabase 設定錯誤：'+explainError(e); return; }
  syncClock();
  // 注意：這個 callback 裡不能直接 await Supabase，所以用 setTimeout 移出去
  sb.auth.onAuthStateChange((event,session)=>{ setTimeout(()=>onSession(session),0); });
}
async function onSession(session){
  const user=session&&session.user;
  if(!user){
    if(signingIn) return;
    signingIn=true;
    const {error}=await sb.auth.signInAnonymously();
    signingIn=false;
    if(error){ setProblem('anon', error); myId=null; isSuper=false; isAnon=true; boot(); }
    else setProblem('anon', null);
    return;
  }
  if(user.id===myId){ boot(); return; }
  const changed=!!myId;
  myId=user.id; myEmail=user.email||null; isAnon=!!user.is_anonymous||!user.email;
  isSuper=false;
  if(!isAnon){
    const {data}=await sb.from('app_admins').select('user_id').eq('user_id',myId);
    isSuper=!!(data&&data.length);
    if(isSuper) setTimeout(cleanOrphanPhotos,0);
  }
  if(changed&&compId) openComp(compId,true);
  boot();
}
function refreshRole(){
  isAdmin = !!(myId && (isSuper || (M.comp && M.comp.ownerId===myId) || coAdmin));
  readOnly = !isAdmin;
}
function boot(){
  if(!started){
    started=true; loadComps(); startCompsChannel();
    const id=new URLSearchParams(location.search).get('c');
    if(id) openComp(id,true);
  }
  render();
}
$('loginBtn').onclick=async()=>{
  if(myId&&!isAnon){ if(confirm('登出管理員？')){ await sb.auth.signOut(); } return; }
  const email=prompt('管理員 Email'); if(!email) return;
  const pw=prompt('密碼'); if(!pw) return;
  const {error}=await sb.auth.signInWithPassword({email:email.trim(), password:pw});
  if(!error) return;
  console.warn('admin login failed', error);
  const m=String(error.message||'');
  if(/invalid login credentials/i.test(m)) alert('登入失敗：Email 或密碼錯誤。\n\n（如果忘記密碼，可以到 Supabase → Authentication → Users 重設。）');
  else if(/email not confirmed/i.test(m)) alert('登入失敗：這個帳號還沒確認。\n\n請到 Supabase → Authentication → Users，刪掉這個帳號重建，建立時勾選 Auto Confirm User。');
  else alert('登入失敗：'+explainError(error));
};

/* ---------- 匯出／匯入（系統管理員） ---------- */
function blobToDataUrl(b){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(b); }); }
$('exportBtn').onclick=async()=>{
  $('exportBtn').textContent='匯出中…';
  try{
    const docs={};
    const [cs,keys,cl,rs,en,ph]=await Promise.all([
      fetchAll('comps',null,['id']), fetchAll('comp_keys',null,['comp_id']), fetchAll('climbers',null,['id']),
      fetchAll('results',null,['climber_id','route_id']), fetchAll('entries',null,['comp_id','user_id']), fetchAll('photos',null,['comp_id','route_id'])]);
    cs.forEach(r=>{ const c=compFromRow(r); docs['comps/'+r.id]={title:c.title, ownerId:c.ownerId, divisions:c.divisions, config:c.config, timer:c.timer,
      selfScoring:c.selfScoring, createdAt:c.createdAt, expiresAt:c.expiresAt, setupDone:true, photoRoutes:ph.filter(p=>p.comp_id===r.id).map(p=>p.route_id)}; });
    keys.forEach(r=>docs['compKeys/'+r.comp_id]={key:r.key});
    cl.forEach(r=>docs[`comps/${r.comp_id}/climbers/${r.id}`]=climberFromRow(r));
    rs.forEach(r=>docs[`comps/${r.comp_id}/results/${rKey(r.climber_id,r.route_id)}`]={climberId:r.climber_id, routeId:r.route_id, attempts:r.attempts});
    en.forEach(r=>docs[`comps/${r.comp_id}/entries/${r.user_id}`]=entryFromRow(r));
    let i=0;
    for(const r of ph){
      $('exportBtn').textContent=`匯出照片 ${++i}/${ph.length}`;
      let data=null;
      try{ const res=await fetch(publicUrl(r.image_path)); if(res.ok) data=await blobToDataUrl(await res.blob()); }catch(e){}
      docs[`comps/${r.comp_id}/photos/${r.route_id}`]={data, w:r.w, h:r.h, marks:r.marks, at:ms(r.updated_at)};
    }
    const blob=new Blob([JSON.stringify({app:'origin-climb',version:2,docs})],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    const t=new Date(); a.download=`原岩比賽備份-${t.getFullYear()}${String(t.getMonth()+1).padStart(2,'0')}${String(t.getDate()).padStart(2,'0')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  }catch(e){ alert('匯出失敗：'+(e.message||e.code||e)); }
  $('exportBtn').textContent='匯出備份';
};
$('importBtn').onclick=()=>$('importInput').click();
$('importInput').onchange=async e=>{
  const f=e.target.files[0]; e.target.value=''; if(!f) return;
  let data; try{ data=JSON.parse(await f.text()); }catch(err){ alert('這不是正確的資料檔。'); return; }
  if(!data||data.app!=='origin-climb'||!data.docs){ alert('這不是原岩比賽的資料檔。'); return; }
  const ids=Object.keys(data.docs).filter(p=>/^comps\/[^/]+$/.test(p)).map(p=>p.split('/')[1]);
  if(!ids.length){ alert('檔案裡沒有比賽資料。'); return; }
  if(!confirm(`要匯入 ${ids.length} 場比賽嗎？同一場比賽會被覆蓋。`)) return;
  const btn=$('importBtn'); let fail=0;
  try{
    for(const [n,cid] of ids.entries()){
      btn.textContent=`匯入中 ${n+1}/${ids.length}`;
      fail+=await importComp(cid, data.docs, msg=>btn.textContent=`匯入中 ${n+1}/${ids.length}・${msg}`);
    }
    alert(fail?`完成，但有 ${fail} 筆失敗（請確認已用管理員登入）。`:`匯入完成，共 ${ids.length} 場比賽。`);
  }catch(err){ console.warn(err); alert('匯入失敗：'+(err.message||err)+'（請確認已用管理員登入）'); }
  btn.textContent='匯入資料';
  loadComps();
};
// 匯入一場比賽（支援 Firebase 版匯出檔與本系統的備份檔），回傳失敗筆數
async function importComp(cid, docs, progress){
  const c=docs['comps/'+cid], pre=`comps/${cid}/`, sub=n=>Object.keys(docs).filter(p=>p.startsWith(pre+n+'/')).map(p=>[p.split('/')[3], docs[p]]);
  let fail=0;
  const must=async(q,what)=>{ const {error}=await q; if(error) throw new Error(what+'：'+error.message); };
  const existing=comps[cid];
  await must(sb.from('comps').upsert({ id:cid, title:(c.title||'未命名比賽').slice(0,100), owner_id:existing?existing.ownerId:myId,
    divisions:c.divisions||[], config:c.config||{climbMin:4,restMin:0}, timer:c.timer||DEFAULT_TIMER,
    self_scoring:c.selfScoring!==false, created_at:iso(c.createdAt),
    // 備份檔裡有到期日就照用（null = 永久保留）；Firebase 舊資料沒有，就從現在起算 10 天
    ...(c.expiresAt===null?{expires_at:null}:c.expiresAt>Date.now()?{expires_at:iso(c.expiresAt)}:{}) }), '比賽');
  const k=docs['compKeys/'+cid];
  if(k&&k.key) await must(sb.from('comp_keys').update({key:k.key}).eq('comp_id',cid), '管理碼');
  const climbers=sub('climbers').map(([id,d])=>({id, comp_id:cid, name:String(d.name||'?').slice(0,50), division:d.division, created_at:iso(d.createdAt)}));
  const results=sub('results').map(([id,d])=>({comp_id:cid, climber_id:d.climberId||id.split('__')[0], route_id:d.routeId||id.split('__')[1], attempts:d.attempts||[]}));
  // 選手自行報名：帳號存在就照原樣匯入；舊系統的帳號（例如 Firebase）不存在，就改成主辦新增的選手
  for(const [u,d] of sub('entries')){
    const row={comp_id:cid, user_id:u, name:String(d.name||'?').slice(0,50), division:d.division, joined_at:iso(d.joinedAt), results:d.results||{}};
    const {error}=await sb.from('entries').upsert(row);
    if(!error) continue;
    const id='u_'+u.replace(/[^A-Za-z0-9]/g,'').slice(0,24);
    climbers.push({id, comp_id:cid, name:row.name, division:row.division, created_at:row.joined_at});
    Object.entries(row.results).forEach(([rid,a])=>{ if(Array.isArray(a)&&a.length) results.push({comp_id:cid, climber_id:id, route_id:rid, attempts:a}); });
  }
  if(climbers.length) await must(sb.from('climbers').upsert(climbers), '選手');
  if(results.length) await must(sb.from('results').upsert(results), '成績');
  const photos=sub('photos');
  for(const [i,[rid,d]] of photos.entries()){
    progress(`照片 ${i+1}/${photos.length}`);
    if(!d||!d.data){ fail++; continue; }
    try{
      const blob=await (await fetch(d.data)).blob();
      const path=`${cid}/${rid}-${d.at||Date.now()}.jpg`;
      const up=await sb.storage.from(BUCKET).upload(path, blob, {contentType:blob.type||'image/jpeg', cacheControl:'31536000', upsert:true});
      if(up.error) throw up.error;
      const {error}=await sb.from('photos').upsert({comp_id:cid, route_id:rid, image_path:path, w:d.w||null, h:d.h||null, marks:d.marks||[], updated_at:iso(d.at)});
      if(error) throw error;
    }catch(err){ console.warn('photo import failed',rid,err); fail++; }
  }
  return fail;
}

/* ---------- 進出比賽 ---------- */
function openComp(id, replaceUrl){
  closeComp();
  compId=id; page='comp';
  prefs={...prefs, div:null, view:'total', selected:null};
  coAdmin=false; compKey=null; entryBlocked=false; entriesLoadedFor=null; compDataLoaded=false;
  M.climbers={}; M.results={}; M.photos={}; M.entries={};
  const url='?c='+encodeURIComponent(id);
  if(location.search!==url) history[replaceUrl?'replaceState':'pushState']({c:id},'',url);
  startCompChannel(id);
  loadCompData(id);
  loadRole(id);
  render(); window.scrollTo(0,0);
}
function closeComp(){
  if(compChannel){ sb.removeChannel(compChannel); compChannel=null; }
  compId=null; last=null; keepAwake(false);
}
function goPortal(){
  closeComp(); page='portal';
  if(location.search) history.pushState({},'',location.pathname);
  render(); window.scrollTo(0,0);
}
// 比賽被刪掉或找不到時回到入口
function leaveComp(){ if(page==='comp'){ closeComp(); page='portal'; history.replaceState({},'',location.pathname); } }
window.addEventListener('popstate',()=>{
  const id=new URLSearchParams(location.search).get('c');
  if(id&&id!==compId) openComp(id,true);
  else if(!id&&page==='comp'){ closeComp(); page='portal'; render(); }
});
$('backBtn').onclick=goPortal;
$('setupBack').onclick=()=>{ page='portal'; render(); };
$('newCompBtn').onclick=()=>{
  draft={ divs:[{name:'男子組',routes:5},{name:'女子組',routes:5}], climb:4, rest:0, timerMode:'shared' };
  $('sTitle').value='原岩模擬賽'; page='setup'; render(); window.scrollTo(0,0);
};
$('shareBtn').onclick=async()=>{
  const url=location.origin+location.pathname+'?c='+encodeURIComponent(compId);
  try{ if(navigator.share){ await navigator.share({title:M.comp.title, url}); return; } }catch(e){ if(e&&e.name==='AbortError') return; }
  try{ await navigator.clipboard.writeText(url); alert('已複製比賽連結：\n'+url); }
  catch(e){ prompt('複製這個連結傳給選手：', url); }
};

/* ---------- 選手自行報名（每人只寫自己的資料） ---------- */
function entryOf(uidv){ return M.entries[uidv]||null; }
function myEntry(){ return myId ? entryOf(myId) : null; }
let entryQueue=Promise.resolve();
function editEntry(uidv, fn){
  const id=compId;
  entryQueue=entryQueue.then(async()=>{
    if(compId!==id) return;
    const cur=M.entries[uidv]?JSON.parse(JSON.stringify(M.entries[uidv])):null;
    const next=fn(cur);
    if(next) M.entries[uidv]=next; else delete M.entries[uidv];
    render();
    const t=sb.from('entries');
    if(!next) await run(t.delete().eq('comp_id',id).eq('user_id',uidv));
    else if(!cur) await run(t.insert({comp_id:id, user_id:uidv, name:next.name, division:next.division, joined_at:iso(next.joinedAt), results:next.results||{}}));
    else await run(t.update({name:next.name, division:next.division, results:next.results||{}}).eq('comp_id',id).eq('user_id',uidv));
  });
  return entryQueue;
}

/* ---------- 組別 / 路線 ---------- */
function divisions(){ return (M.comp&&M.comp.divisions)||[]; }
function curDiv(){ const ds=divisions(); return ds.find(d=>d.id===prefs.div)||ds[0]; }

/* ---------- 計分 ---------- */
function climbersIn(divId){
  const judge=Object.entries(M.climbers).filter(([,c])=>c.division===divId)
    .map(([id,c])=>({id,name:c.name,createdAt:c.createdAt||0}));
  const self=Object.keys(M.entries).map(u=>[u,entryOf(u)]).filter(([,e])=>e&&e.division===divId)
    .map(([u,e])=>({id:'u:'+u,name:e.name,createdAt:e.joinedAt||0,self:true,uid:u}));
  return [...judge,...self].sort((a,b)=>a.createdAt-b.createdAt||(a.id<b.id?-1:1));
}
function climberById(id){
  if(id&&id.startsWith('u:')){ const e=entryOf(id.slice(2)); return e?{name:e.name,division:e.division}:null; }
  return M.climbers[id]||null;
}
function attemptsOf(cid,rid){
  if(cid&&cid.startsWith('u:')){ const e=entryOf(cid.slice(2)); const a=e&&e.results&&e.results[rid]; return Array.isArray(a)?a:[]; }
  const r=M.results[rKey(cid,rid)]; return (r&&Array.isArray(r.attempts))?r.attempts:[];
}
function setAttempts(cid,rid,arr){
  if(cid.startsWith('u:')){
    return editEntry(cid.slice(2), e=>{ if(!e) return null; e.results=e.results||{}; e.results[rid]=arr; return e; });
  }
  M.results[rKey(cid,rid)]={attempts:arr}; render();
  return run(sb.from('results').upsert({comp_id:compId, climber_id:cid, route_id:rid, attempts:arr}));
}
function calcRoute(arr){
  let zoneAt=null,topAt=null;
  arr.forEach((r,i)=>{ if((r==='z'||r==='t')&&zoneAt===null) zoneAt=i+1; if(r==='t'&&topAt===null) topAt=i+1; });
  let score=0; if(topAt) score=25-0.1*(topAt-1); else if(zoneAt) score=10-0.1*(zoneAt-1);
  return { zoneAt, topAt, score:Math.max(0,Math.round(score*10)/10), total:arr.length };
}
function calcTotal(cid,div){
  let score=0,tops=0,zones=0,attempts=0;
  const per=div.routes.map(r=>{ const s=calcRoute(attemptsOf(cid,r.id)); score+=s.score; attempts+=s.total; if(s.topAt)tops++; if(s.zoneAt)zones++; return {route:r,...s}; });
  return { score:Math.round(score*10)/10, tops, zones, attempts, per };
}
function rankList(items){ let prev=null,pr=0; return items.map((it,i)=>{ const rank=it.score===prev?pr:i+1; prev=it.score; pr=rank; return {...it,rank}; }); }
function esc(s){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* ---------- 建立比賽 ---------- */
let draft={ divs:[{name:'男子組',routes:5},{name:'女子組',routes:5}], climb:4, rest:0, timerMode:'shared' };
const LIMITS={ climb:[1,15], rest:[0,10] };
document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{
  const k=b.dataset.step,[lo,hi]=LIMITS[k];
  draft[k]=Math.min(hi,Math.max(lo,draft[k]+Number(b.dataset.d))); renderSetup();
});
function renderSetup(){
  $('sClimb').textContent=draft.climb; $('sRest').textContent=draft.rest;
  renderModeSeg($('sMode'), $('sModeNote'), draft.timerMode, m=>{ draft.timerMode=m; renderSetup(); });
  const box=$('divDraft'); box.innerHTML='';
  draft.divs.forEach((d,i)=>{
    const el=document.createElement('div'); el.className='divcard';
    el.innerHTML=`<div class="row2"><input class="text" aria-label="組別名稱"><button type="button" class="link danger" ${draft.divs.length<2?'hidden':''}>移除</button></div>
      <div class="stepper"><button type="button" aria-label="減少路線">−</button><output>${d.routes}</output><button type="button" aria-label="增加路線">＋</button><span class="unit">條路線</span></div>`;
    const inp=el.querySelector('input'); inp.value=d.name; inp.oninput=()=>d.name=inp.value;
    el.querySelector('.link').onclick=()=>{ draft.divs.splice(i,1); renderSetup(); };
    const [minus,plus]=el.querySelectorAll('.stepper button');
    minus.onclick=()=>{ d.routes=Math.max(1,d.routes-1); renderSetup(); };
    plus.onclick=()=>{ d.routes=Math.min(12,d.routes+1); renderSetup(); };
    box.appendChild(el);
  });
}
$('addDiv').onclick=()=>{ draft.divs.push({name:`組別 ${draft.divs.length+1}`,routes:5}); renderSetup(); };
$('startComp').onclick=async()=>{
  $('startComp').disabled=true;
  const id=uid();
  const divs=draft.divs.map((d,i)=>({ id:uid(), name:(d.name||'').trim().slice(0,30)||`組別 ${i+1}`,
    routes:Array.from({length:d.routes},(_,k)=>({id:uid(),name:`路線 ${k+1}`})) }));
  const row={ id, title:($('sTitle').value.trim()||'模擬賽').slice(0,100), owner_id:myId, divisions:divs,
    config:{climbMin:draft.climb,restMin:draft.rest,timerMode:draft.timerMode}, timer:DEFAULT_TIMER, self_scoring:true };
  const {error}=await sb.from('comps').insert(row);
  $('startComp').disabled=false;
  if(error){ console.warn(error); alert('建立失敗，請重新整理後再試一次。'); return; }
  comps[id]=compFromRow({...row, created_at:iso(now()), expires_at:iso(now()+10*DAY)});
  openComp(id);
  const {data}=await sb.from('comp_keys').select('key').eq('comp_id',id);
  const key=data&&data[0]&&data[0].key;
  if(key&&compId===id){ compKey=key; render(); }
  alert(`比賽建立好了！\n\n管理碼：${key||'（請稍後在比賽頁查看）'}\n\n請記下來。換手機或清除瀏覽器資料後，在比賽頁按「輸入管理碼」就能拿回計時和管理權限，也可以給協助你的裁判。\n\n這場比賽會在 10 天後自動刪除。`);
};

/* ---------- 計時器 ---------- */
// 計時方式：shared 教練統一計時（存在資料庫、所有手機同步）／self 學員各自計時（存在自己手機）／both 兩種都可以切換
const TIMER_MODES=[
  ['shared','教練統一計時','教練控制計時，所有手機同步。','教練計時'],
  ['self','學員各自計時','每個人在自己的手機上開始／暫停，互不影響。','各自計時'],
  ['both','兩種都可以','預設看教練的計時，學員可以切換成自己的計時。','兩種都可'],
];
const OWN_KEY='origin-climb-own-timers';
let ownTimers={};   // {比賽id: {timer, useOwn}}，只存在這台手機
try{ ownTimers=JSON.parse(localStorage.getItem(OWN_KEY)||'{}')||{}; }catch(e){}
function saveOwn(){ try{ localStorage.setItem(OWN_KEY, JSON.stringify(ownTimers)); }catch(e){} }
function own(){ return ownTimers[compId]=ownTimers[compId]||{timer:{...DEFAULT_TIMER}, useOwn:false}; }
function cfg(){ return M.comp.config; }
function timerMode(){ const m=M.comp&&M.comp.config&&M.comp.config.timerMode; return m==='self'||m==='both'?m:'shared'; }
function modeName(m){ return (TIMER_MODES.find(x=>x[0]===m)||TIMER_MODES[0])[1]; }
function usingOwn(){ const m=timerMode(); return m==='self'||(m==='both'&&own().useOwn); }
function curTimer(){ return usingOwn()?own().timer:M.comp.timer; }
function canControlTimer(){ return usingOwn()||isAdmin; }
function renderModeSeg(box, note, cur, onPick){
  box.innerHTML='';
  TIMER_MODES.forEach(([m,,,name])=>{ const b=document.createElement('button'); b.type='button'; b.dataset.mode=m; b.className=m===cur?'on':''; b.textContent=name; b.onclick=()=>onPick(m); box.appendChild(b); });
  note.textContent=(TIMER_MODES.find(x=>x[0]===cur)||TIMER_MODES[0])[2];
}
function elapsedNow(){ const t=curTimer(); return t.running ? t.elapsed+(now()-t.startedAt) : t.elapsed; }
function timerView(){
  const t=curTimer(), c=cfg(), climb=c.climbMin*MIN, rest=c.restMin*MIN, E=Math.max(0,elapsedNow());
  if(rest>0){
    const cycle=climb+rest, n=Math.floor(E/cycle), within=E-n*cycle, inClimb=within<climb;
    return { round:t.round+n, phase:inClimb?'climb':'rest', remain:inClimb?climb-within:cycle-within, over:false, cycleStart:n*cycle };
  }
  return { round:t.round, phase:'climb', remain:Math.max(0,climb-E), over:E>=climb, cycleStart:0 };
}
function fmt(ms){ const s=Math.ceil(ms/1000),m=Math.floor(s/60),r=s%60; return `${m}:${String(r).padStart(2,'0')}`; }
// 改目前正在用的計時器（自己的就存在手機，教練的就寫進資料庫）
function setTimer(p){
  if(usingOwn()){ const o=own(); o.timer={...o.timer,...p}; saveOwn(); render(); return Promise.resolve(true); }
  return setSharedTimer(p);
}
function setSharedTimer(p){
  const id=compId, timer={...M.comp.timer,...p};
  comps[id]={...M.comp, timer}; render();
  return run(sb.from('comps').update({timer}).eq('id',id));
}
$('tToggle').onclick=()=>{
  beep(0,0.001);
  if(!canControlTimer()) return;
  const t=curTimer(), v=timerView();
  if(v.over) return setTimer({round:t.round+1,elapsed:0,running:true,startedAt:now()});
  if(t.running) setTimer({running:false,elapsed:elapsedNow()});
  else setTimer({running:true,startedAt:now()});
};
$('tNext').onclick=()=>{
  if(!canControlTimer()||!confirm('結束這個階段，跳到下一階段？')) return;
  const t=curTimer(),c=cfg(),v=timerView(),climb=c.climbMin*MIN,rest=c.restMin*MIN;
  if(rest>0) setTimer({elapsed: v.phase==='climb'? v.cycleStart+climb : v.cycleStart+climb+rest, startedAt:now()});
  else setTimer({round:t.round+1,elapsed:0,running:false});
};
$('tReset').onclick=()=>{ if(!canControlTimer()||!confirm('把這一輪的時間重設回開頭？')) return; setTimer({elapsed:timerView().cycleStart,running:false}); };
$('keepBtn').onclick=()=>{
  if(!isSuper||M.comp.expiresAt===undefined) return;
  const keep=M.comp.expiresAt!==null;
  if(!confirm(keep?'把這場比賽設成永久保留（不會自動刪除）？':'改成從現在起 10 天後自動刪除？')) return;
  const v=keep?null:now()+10*DAY;
  comps[compId]={...M.comp, expiresAt:v}; render();
  run(sb.from('comps').update({expires_at:v===null?null:iso(v)}).eq('id',compId));
};
$('tSwitch').onclick=()=>{
  if(timerMode()!=='both') return;
  const o=own(); o.useOwn=!o.useOwn; saveOwn(); last=null; render();
};
$('tSound').onclick=()=>{ prefs.sound=!prefs.sound; savePrefs(); if(prefs.sound) beep(880,0.1); renderTimer(); };

let audioCtx=null, wakeLock=null, last=null;
function beep(freq=880,dur=0.15,times=1){
  try{
    audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    if(!prefs.sound||!freq) return;
    for(let i=0;i<times;i++){
      const o=audioCtx.createOscillator(),g=audioCtx.createGain();
      o.frequency.value=freq; o.connect(g); g.connect(audioCtx.destination);
      const t=audioCtx.currentTime+i*(dur+0.12);
      g.gain.setValueAtTime(0.3,t); g.gain.exponentialRampToValueAtTime(0.001,t+dur); o.start(t); o.stop(t+dur);
    }
  }catch(e){}
  try{ if(prefs.sound&&freq&&navigator.vibrate) navigator.vibrate(dur>0.5?600:120); }catch(e){}
}
document.addEventListener('pointerdown',()=>beep(0,0.001),{once:true});
async function keepAwake(on){
  try{
    if(on&&'wakeLock' in navigator&&!wakeLock){ wakeLock=await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release',()=>wakeLock=null); }
    if(!on&&wakeLock){ await wakeLock.release(); wakeLock=null; }
  }catch(e){}
}
function tick(){
  if(page!=='comp'||!M.comp||!divisions().length) return;
  const t=curTimer(),v=timerView(),sec=Math.ceil(v.remain/1000),key=(usingOwn()?'own':'shared')+v.round+v.phase;
  if(t.running&&last){
    if(last.key!==key||(!last.over&&v.over)) beep(last.phase==='climb'?440:1040,0.8);
    else if(sec!==last.sec){
      if(v.phase==='climb'&&sec===60&&cfg().climbMin>1) beep(660,0.25,2);
      if(sec>=1&&sec<=5) beep(880,0.12);
    }
  }
  last={key,sec,over:v.over,phase:v.phase};
  keepAwake(t.running&&!v.over);
  renderTimer();
}
function renderTimer(){
  if(page!=='comp'||!M.comp||!divisions().length) return;
  const t=curTimer(),v=timerView(),el=$('timer'),mode=timerMode();
  $('tClock').textContent=v.over?'時間到':fmt(v.remain);
  $('tPhase').textContent=(mode!=='shared'&&usingOwn()?'我的計時・':'')+`第 ${v.round} 輪・`+(v.phase==='climb'?'攀爬':'休息／換場')+(t.running||v.over?'':'（暫停）');
  el.classList.toggle('rest',v.phase==='rest');
  el.classList.toggle('warn',v.phase==='climb'&&!v.over&&v.remain<=60000);
  el.classList.toggle('over',v.over);
  $('tToggle').textContent=v.over?'下一輪':t.running?'暫停':(elapsedNow()>0?'繼續':'開始');
  $('tSound').textContent=prefs.sound?'🔔':'🔕';
  const ctl=canControlTimer();
  document.querySelectorAll('.t-ctl').forEach(e=>e.style.display=ctl?'':'none');
  $('timerLine').hidden=mode==='shared';
  const ex=expiryText(M.comp,true);
  $('expiryLine').hidden=!ex; $('expiryText').textContent=ex;
  $('keepBtn').textContent=M.comp.expiresAt===null?'改回 10 天後刪除':'永久保留';
  $('tSwitch').hidden=mode!=='both';
  $('timerLineText').textContent=mode==='self'?'⏱ 各自計時：上方計時器只在你的手機上跑'
    :usingOwn()?'⏱ 目前顯示：我的計時':'⏱ 目前顯示：教練計時';
  $('tSwitch').textContent=usingOwn()?'⇄ 切換回教練計時':'⇄ 切換成我的計時';
}

/* ---------- 路線照片（壓縮到長邊 1000px JPEG 再上傳到 Storage） ---------- */
function resizeImage(file){
  return new Promise((res,rej)=>{
    const img=new Image(), url=URL.createObjectURL(file);
    img.onload=async()=>{
      let w=img.naturalWidth,h=img.naturalHeight; const max=1000, k=Math.min(1,max/Math.max(w,h));
      w=Math.round(w*k); h=Math.round(h*k);
      const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h); URL.revokeObjectURL(url);
      const toBlob=q=>new Promise(r=>cv.toBlob(r,'image/jpeg',q));
      let q=0.75, blob=await toBlob(q);
      while(blob&&blob.size>165000&&q>0.3){ q-=0.1; blob=await toBlob(q); }
      blob?res({blob,w,h}):rej();
    };
    img.onerror=()=>{ URL.revokeObjectURL(url); rej(); };
    img.src=url;
  });
}
async function savePhoto(rid, patch){
  const id=compId, cur=M.photos[rid];
  const row={comp_id:id, route_id:rid, image_path:patch.path||cur.path, w:patch.w??cur.w, h:patch.h??cur.h, marks:patch.marks??cur.marks, updated_at:iso(now())};
  M.photos[rid]=photoFromRow(row); render();
  return run(sb.from('photos').upsert(row));
}
async function deletePhoto(rid){
  const cur=M.photos[rid]; if(!cur) return;
  delete M.photos[rid]; render();
  await run(sb.from('photos').delete().eq('comp_id',compId).eq('route_id',rid));
  await sb.storage.from(BUCKET).remove([cur.path]);
}

/* ---------- 標記繪製 ---------- */
const MARK = {
  hand:{color:'#2EE65C', label:''}, foot:{color:'#2EE65C', label:'', dash:true},
  start:{color:'#3D9BFF', label:'S'}, zone:{color:'#FFC400', label:'Z'}, top:{color:'#FF4A3D', label:'T'}
};
function dims(ph, imgEl){
  const w=ph.w||(imgEl&&imgEl.naturalWidth)||1000, h=ph.h||(imgEl&&imgEl.naturalHeight)||750;
  return {w,h,VH:1000*h/w};
}
function drawMarks(svg, marks, VH, sel){
  svg.setAttribute('viewBox',`0 0 1000 ${VH}`);
  let out='';
  (marks||[]).forEach((m,i)=>{
    const t=MARK[m.type]||MARK.hand, cx=m.x*1000, cy=m.y*VH, r=m.r*1000;
    const dash=t.dash?'stroke-dasharray="14 9"':'';
    out+=`<g data-i="${i}">`;
    out+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="transparent" stroke="#000" stroke-opacity=".7" stroke-width="11" ${dash}/>`;
    out+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="transparent" stroke="${t.color}" stroke-width="6" ${dash}/>`;
    if(t.label){
      const lx=cx+r*0.78, ly=cy-r*0.78, lr=Math.max(17, r*0.42);
      out+=`<circle cx="${lx}" cy="${ly}" r="${lr}" fill="${t.color}" stroke="#000" stroke-opacity=".7" stroke-width="3"/>`;
      out+=`<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central" font-size="${lr*1.25}" font-weight="900" font-family="system-ui,sans-serif" fill="${m.type==='zone'?'#2A2000':'#fff'}">${t.label}</text>`;
    }
    if(i===sel) out+=`<circle cx="${cx}" cy="${cy}" r="${r+14}" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="8 6"/>`;
    out+=`</g>`;
  });
  svg.innerHTML=out;
}
function fitWrap(wrap, w, h, maxW, maxH){
  const width=Math.min(maxW, maxH*w/h);
  wrap.style.width=width+'px';
}
function layoutLight(){
  const ph=M.photos[prefs.view]; if(!ph||$('lightbox').hidden) return;
  const d=dims(ph,$('lightImg'));
  fitWrap($('lightWrap'), d.w, d.h, window.innerWidth, window.innerHeight-40);
  drawMarks($('lightSvg'), ph.marks, d.VH, -1);
}
function layoutPhoto(ph){
  const d=dims(ph,$('photoImg'));
  fitWrap($('photoWrap'), d.w, d.h, $('photoBox').clientWidth||600, 380);
  drawMarks($('photoSvg'), ph.marks, d.VH, -1);
}
$('photoImg').onload=()=>{ const ph=M.photos[prefs.view]; if(ph) layoutPhoto(ph); };
$('lightImg').onload=layoutLight;
window.addEventListener('resize',()=>{ const ph=M.photos[prefs.view]; if(ph&&!$('photoBox').hidden) layoutPhoto(ph); layoutLight(); if(!$('editor').hidden) layoutEditor(); });

/* ---------- 圈路線編輯器 ---------- */
const ed={rid:null, marks:[], hist:[], sel:-1, tool:'hand', size:0.035, drag:null, d:null};
function openEditor(rid){
  const ph=M.photos[rid]; if(!ph) return;
  const div=curDiv(), r=div.routes.find(x=>x.id===rid);
  ed.rid=rid; ed.marks=JSON.parse(JSON.stringify(ph.marks||[])); ed.hist=[]; ed.sel=-1; ed.drag=null;
  $('edTitle').textContent=`圈路線・${div.name} ${r?r.name:''}`;
  $('edImg').src=ph.url;
  $('editor').hidden=false; document.body.style.overflow='hidden';
  renderTools(); layoutEditor();
}
function closeEditor(){ $('editor').hidden=true; document.body.style.overflow=''; }
function layoutEditor(){
  const ph=M.photos[ed.rid]; if(!ph) return;
  ed.d=dims(ph,$('edImg'));
  const st=$('edStage');
  fitWrap($('edWrap'), ed.d.w, ed.d.h, st.clientWidth-16, st.clientHeight-16);
  drawEd();
}
$('edImg').onload=layoutEditor;
function drawEd(){
  drawMarks($('edSvg'), ed.marks, ed.d.VH, ed.sel);
  $('edUndo').disabled=!ed.hist.length;
  $('edDel').disabled=ed.sel<0;
  $('edClear').disabled=!ed.marks.length;
  $('edSize').value = ed.sel>=0 ? ed.marks[ed.sel].r : ed.size;
}
function renderTools(){
  document.querySelectorAll('#edTools button').forEach(b=>b.classList.toggle('on', b.dataset.tool===ed.tool));
}
function snapshot(){ ed.hist.push(JSON.stringify(ed.marks)); if(ed.hist.length>60) ed.hist.shift(); }
function toPt(e){
  const r=$('edSvg').getBoundingClientRect();
  return { x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)), y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height)) };
}
document.querySelectorAll('#edTools button').forEach(b=>b.onclick=()=>{
  ed.tool=b.dataset.tool; renderTools();
  if(ed.sel>=0){ snapshot(); ed.marks[ed.sel].type=ed.tool; drawEd(); }
});
$('edSvg').addEventListener('pointerdown',e=>{
  e.preventDefault();
  const g=e.target.closest('g[data-i]'), p=toPt(e);
  $('edSvg').setPointerCapture(e.pointerId);
  if(g){
    const i=Number(g.dataset.i), m=ed.marks[i];
    ed.sel=i; ed.tool=m.type; renderTools();
    ed.drag={i, ox:p.x-m.x, oy:p.y-m.y, moved:false};
  } else {
    snapshot();
    ed.marks.push({x:p.x, y:p.y, r:ed.size, type:ed.tool});
    ed.sel=ed.marks.length-1;
    ed.drag={i:ed.sel, ox:0, oy:0, moved:true};
  }
  drawEd();
});
$('edSvg').addEventListener('pointermove',e=>{
  if(!ed.drag) return;
  const p=toPt(e), m=ed.marks[ed.drag.i];
  if(!ed.drag.moved){ snapshot(); ed.drag.moved=true; }
  m.x=Math.min(1,Math.max(0,p.x-ed.drag.ox)); m.y=Math.min(1,Math.max(0,p.y-ed.drag.oy));
  drawEd();
});
const endDrag=()=>{ ed.drag=null; };
$('edSvg').addEventListener('pointerup',endDrag);
$('edSvg').addEventListener('pointercancel',endDrag);
$('edSize').addEventListener('input',e=>{
  const v=Number(e.target.value); ed.size=v;
  if(ed.sel>=0){ ed.marks[ed.sel].r=v; drawMarks($('edSvg'), ed.marks, ed.d.VH, ed.sel); }
});
$('edSize').addEventListener('pointerdown',()=>{ if(ed.sel>=0) snapshot(); });
$('edUndo').onclick=()=>{ if(!ed.hist.length) return; ed.marks=JSON.parse(ed.hist.pop()); ed.sel=-1; drawEd(); };
$('edDel').onclick=()=>{ if(ed.sel<0) return; snapshot(); ed.marks.splice(ed.sel,1); ed.sel=-1; drawEd(); };
$('edClear').onclick=()=>{ if(!confirm('清除所有標記？')) return; snapshot(); ed.marks=[]; ed.sel=-1; drawEd(); };
$('edCancel').onclick=()=>{ if(ed.hist.length && !confirm('放棄這次的修改？')) return; closeEditor(); };
$('edSave').onclick=async()=>{
  const ph=M.photos[ed.rid]; if(!ph) return closeEditor();
  $('edSave').disabled=true;
  const d=ed.d||dims(ph,$('edImg'));
  await savePhoto(ed.rid,{w:d.w, h:d.h, marks:ed.marks.map(m=>({x:+m.x.toFixed(4), y:+m.y.toFixed(4), r:+m.r.toFixed(4), type:m.type}))});
  $('edSave').disabled=false; closeEditor();
};

/* ---------- 路線照片上傳 ---------- */
$('photoBtn').onclick=()=>$('photoInput').click();
$('photoInput').onchange=async e=>{
  const f=e.target.files[0]; e.target.value=''; if(!f) return;
  const rid=prefs.view, id=compId; if(rid==='total') return;
  $('photoBtn').textContent='上傳中…'; $('photoBtn').disabled=true;
  let ok=false;
  try{
    const img=await resizeImage(f);
    const path=`${id}/${rid}-${Date.now()}.jpg`;
    const up=await sb.storage.from(BUCKET).upload(path, img.blob, {contentType:'image/jpeg', cacheControl:'31536000'});
    if(up.error) throw up.error;
    const old=M.photos[rid];
    const row={comp_id:id, route_id:rid, image_path:path, w:img.w, h:img.h, marks:[], updated_at:iso(now())};
    const {error}=await sb.from('photos').upsert(row);
    if(error) throw error;
    if(compId===id) M.photos[rid]=photoFromRow(row);
    if(old&&old.path) sb.storage.from(BUCKET).remove([old.path]);
    ok=true;
  }catch(err){ console.warn(err); alert(err&&err.message?'照片上傳失敗，請再試一次。':'這張照片讀不出來，換一張試試看。'); }
  $('photoBtn').disabled=false; render();
  if(ok) setTimeout(()=>openEditor(rid),300);
};
$('photoDelBtn').onclick=()=>{ if(confirm('刪除這條路線的照片和標記？')) deletePhoto(prefs.view); };
$('markBtn').onclick=()=>openEditor(prefs.view);
$('photoBox').onclick=()=>{ const ph=M.photos[prefs.view]; if(!ph) return; $('lightImg').src=ph.url; $('lightbox').hidden=false; layoutLight(); };
$('lightbox').onclick=()=>{ $('lightbox').hidden=true; };

/* ---------- 畫面 ---------- */
function banner(){
  if(page!=='comp') return isSuper ? '<b>系統管理員</b>：可以管理所有比賽。' : '任何人都可以建立比賽；建立的人負責計時和管理。';
  if(isAdmin) return '<b>主辦</b>：你負責計時，也可以幫任何選手記分。';
  if(!myId||entryBlocked) return '<b>觀看模式</b>：目前無法報名，請重新整理頁面再試一次。';
  return myEntry() ? '<b>選手</b>：切到路線就能記錄自己的成績。' : '<b>選手</b>：填名字報名後，就能自己記錄成績。';
}
function renderPortal(){
  const probs=[...new Set(Object.values(setupProblems))];
  $('portalBanner').classList.toggle('error', probs.length>0);
  $('portalBanner').innerHTML=probs.length
    ? '<b>⚠️ 網站設定有問題，請主辦或管理員處理：</b><br>'+probs.map(esc).join('<br>')
    : banner();
  $('loginBtn').textContent=(myId&&!isAnon)?`登出（${myEmail}）`:'管理員登入';
  const list=$('compList'); list.innerHTML='';
  const items=Object.entries(comps).filter(([,c])=>c&&Array.isArray(c.divisions)&&c.divisions.length&&!isExpired(c))
    .sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0));
  if(!items.length){ list.innerHTML=`<li class="empty">${compsLoaded?'還沒有比賽，按上面的按鈕建立第一場。':setupProblems.comps?'無法載入比賽清單。':'載入中…'}</li>`; return; }
  items.forEach(([id,c])=>{
    const li=document.createElement('li'); li.className='comp-item'; li.tabIndex=0;
    const d=c.createdAt?new Date(c.createdAt):null;
    const date=d?`${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`:'';
    const live=c.timer&&c.timer.running, mine=myId&&c.ownerId===myId;
    const exp=expiryText(c,false);
    li.innerHTML=`<div><h3></h3><p>${esc(date)}・${c.divisions.map(x=>esc(x.name)+' '+x.routes.length+' 條').join('、')}${exp?'・'+esc(exp):''}</p></div><span class="badge${live?' live':''}">${live?'進行中':mine?'我主辦':'查看'}</span>`;
    li.querySelector('h3').textContent=c.title||'未命名比賽';
    li.onclick=()=>openComp(id);
    li.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openComp(id); } };
    list.appendChild(li);
  });
}
function render(){
  if(!started) return;
  $('loadingView').hidden=true;
  refreshRole();
  document.querySelectorAll('.edit-only').forEach(e=>e.style.display=(page==='comp'&&isAdmin)?'':'none');
  document.querySelectorAll('.super-only').forEach(e=>e.style.display=isSuper?'':'none');
  if(!isSuper) $('verCard').hidden=true;
  $('newCompBtn').hidden=!myId;
  if(page==='setup'&&!myId) page='portal';
  const inComp = page==='comp' && M.comp && divisions().length;
  $('portalView').hidden = page!=='portal';
  $('setupView').hidden = page!=='setup';
  $('compView').hidden = !inComp;
  if(page==='portal'){ renderPortal(); return; }
  if(page==='setup'){ renderSetup(); return; }
  if(!inComp){ $('loadingView').hidden=false; $('loadingView').textContent='載入比賽中…'; return; }

  const ds=divisions(), div=curDiv(), c1=cfg();
  prefs.div=div.id;
  const rs=div.routes;
  if(prefs.view!=='total'&&!rs.some(r=>r.id===prefs.view)) prefs.view='total';
  if(prefs.selected&&(!climberById(prefs.selected)||climberById(prefs.selected).division!==div.id)) prefs.selected=null;
  const photoSet=new Set(Object.keys(M.photos));

  $('title').textContent=M.comp.title;
  $('ruleLine').textContent=ds.map(d=>`${d.name} ${d.routes.length} 條`).join('、')+`・每輪攀爬 ${c1.climbMin} 分鐘`+(c1.restMin?`、休息 ${c1.restMin} 分鐘`:'')+`・${modeName(timerMode())}`+'。Zone 10 分、Top 25 分，第二次起每次扣 0.1 分。';
  $('modeBanner').innerHTML=banner();
  const me=myEntry(), selfOpen=M.comp.selfScoring!==false;
  $('keyLine').hidden=!(isAdmin&&compKey);
  if(isAdmin&&compKey) $('keyLine').innerHTML=`<b>管理碼：${esc(compKey)}</b>　換手機時輸入可拿回管理權，也可以給裁判。請勿公開。`;
  $('claimLine').hidden=isAdmin||!myId;
  const canJoin=!isAdmin&&myId&&!entryBlocked;
  $('joinCard').hidden=!(canJoin&&!me);
  if(canJoin&&!me){
    const jd=$('joinDivs'); jd.innerHTML='';
    if(!ds.some(d=>d.id===joinDiv)) joinDiv=div.id;
    ds.forEach(d=>{ const b=document.createElement('button'); b.type='button'; b.className=d.id===joinDiv?'on':''; b.textContent=d.name; b.onclick=()=>{ joinDiv=d.id; render(); }; jd.appendChild(b); });
  }
  $('meLine').hidden=!(me&&!isAdmin);
  if(me&&!isAdmin){
    const md=ds.find(d=>d.id===me.division);
    $('meText').textContent=`你以「${me.name}」報名${md?md.name:''}`+(selfOpen?'':'・主辦尚未開放自行記分');
  }
  if(isAdmin) renderModeSeg($('modeSeg'), $('modeNote'), timerMode(), m=>{
    if(m===timerMode()) return;
    const config={...cfg(), timerMode:m};
    comps[compId]={...M.comp, config}; last=null; render();
    run(sb.from('comps').update({config}).eq('id',compId));
  });
  $('selfToggle').textContent=selfOpen?'選手自行記分：開放中（點此關閉）':'選手自行記分：已關閉（點此開放）';

  const dt=$('divtabs'); dt.innerHTML=''; dt.hidden=ds.length<2;
  ds.forEach(d=>{ const b=document.createElement('button'); b.className='divtab'+(d.id===div.id?' on':''); b.textContent=d.name;
    b.onclick=()=>{ prefs.div=d.id; prefs.view='total'; prefs.selected=null; render(); }; dt.appendChild(b); });
  $('nameInput').placeholder=`輸入選手名字報名${div.name}`;

  const tabs=$('tabs'); tabs.innerHTML='';
  const mk=(label,cls,on,fn)=>{ const b=document.createElement('button'); b.className='tab '+cls+(on?' on':''); b.textContent=label; b.onclick=fn; tabs.appendChild(b); };
  mk('總排行','total',prefs.view==='total',()=>{prefs.view='total';render();});
  rs.forEach(r=>mk(r.name+(photoSet.has(r.id)?' 📷':''),'',prefs.view===r.id,()=>{prefs.view=r.id;render();}));

  const board=$('board'); board.innerHTML='';
  const list=climbersIn(div.id), route=rs.find(r=>r.id===prefs.view);
  if(!list.length) board.innerHTML=`<li class="empty">${compDataLoaded?esc(div.name)+'還沒有選手。':'載入中…'}</li>`;
  const makeRow=(r,detail)=>{
    const li=document.createElement('li');
    li.className='row'+(readOnly?'':' click')+(r.c.id===prefs.selected&&!readOnly?' sel':'')+(r.c.uid&&r.c.uid===myId&&!isAdmin?' me':'');
    li.innerHTML=`<div class="rank${r.rank===1?' p1':''}">${r.rank}</div><div><div class="rname"></div>${detail}</div><div class="rscore">${r.score.toFixed(1)}</div>`;
    li.querySelector('.rname').textContent=r.c.name;
    if(!readOnly){
      li.tabIndex=0;
      const pick=()=>{ prefs.selected=r.c.id; if(prefs.view==='total') prefs.view=rs[0].id; render(); $('nowCard').scrollIntoView({behavior:'smooth',block:'nearest'}); };
      li.onclick=pick; li.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); pick(); } };
    }
    return li;
  };
  const photo=route&&M.photos[route.id];
  $('photoBox').hidden=!photo;
  if(photo){ if($('photoImg').getAttribute('src')!==photo.url) $('photoImg').src=photo.url; else layoutPhoto(photo); }
  if(!route){
    $('boardTitle').textContent=`${div.name} 總排行`;
    $('boardHint').textContent=`${rs.length} 條路線加總`;
    $('routeTools').hidden=true;
    rankList(list.map((c,idx)=>({c,idx,...calcTotal(c.id,div)})).sort((a,b)=>b.score-a.score||b.tops-a.tops||b.zones-a.zones||a.idx-b.idx))
      .forEach(r=>{
        const mini=r.per.map(p=>`<span class="${p.topAt?'t':p.zoneAt?'z':''}">${esc(p.route.name)} ${p.score.toFixed(1)}</span>`).join('');
        board.appendChild(makeRow(r,`<div class="rdetail">${r.tops}T ${r.zones}Z・共 ${r.attempts} 次</div><div class="mini">${mini}</div>`));
      });
  } else {
    $('boardTitle').textContent=`${div.name}・${route.name}`;
    $('boardHint').textContent=readOnly?'':'點選手開始記錄';
    $('routeTools').hidden=false;
    $('photoBtn').textContent=photo?'更換路線照片':'上傳路線照片';
    $('photoDelBtn').hidden=!photo; $('markBtn').hidden=!photo;
    rankList(list.map((c,idx)=>({c,idx,...calcRoute(attemptsOf(c.id,route.id))})).sort((a,b)=>b.score-a.score||a.idx-b.idx))
      .forEach(r=>{
        const d=r.topAt?`第 ${r.topAt} 次 Top`:r.zoneAt?`第 ${r.zoneAt} 次 Zone`:r.total?'尚未得分':'還沒爬';
        board.appendChild(makeRow(r,`<div class="rdetail">${d}・共 ${r.total} 次</div>`));
      });
  }

  let showCard=false;
  if(isAdmin){ showCard=!!(prefs.selected&&climberById(prefs.selected)&&route); }
  else if(me&&route&&me.division===div.id){ prefs.selected='u:'+myId; showCard=true; }
  const c=prefs.selected&&climberById(prefs.selected);
  $('nowCard').hidden=!showCard;
  $('delBtn').hidden=!isAdmin;
  const locked=!isAdmin&&!selfOpen;
  $('lockMsg').hidden=!locked;
  if(showCard&&c){
    const arr=attemptsOf(prefs.selected,route.id),s=calcRoute(arr);
    $('nowRoute').textContent=`${div.name}・${route.name}`;
    $('nowName').textContent=c.name;
    $('nowScore').textContent=s.score.toFixed(1);
    $('nowStatus').textContent=s.topAt?`已完攀（第 ${s.topAt} 次）`:s.zoneAt?`第 ${s.zoneAt} 次拿到 Zone，繼續挑戰 Top`:`目前第 ${s.total+1} 次嘗試`;
    const strip=$('strip'); strip.innerHTML='';
    arr.forEach(x=>{ const d=document.createElement('span'); d.className='chip '+x; d.textContent=x==='f'?'✕':x==='z'?'Z':'T'; strip.appendChild(d); });
    document.querySelectorAll('.act').forEach(b=>b.disabled=!!s.topAt||locked);
    $('undoBtn').disabled=!arr.length||locked;
  }
  renderTimer();
}

/* ---------- 操作 ---------- */
function addClimber(){
  const name=$('nameInput').value.trim().slice(0,50); if(!name){ $('nameInput').focus(); return; }
  const div=curDiv(), id=uid();
  M.climbers[id]={name,division:div.id,createdAt:now()};
  run(sb.from('climbers').insert({id, comp_id:compId, name, division:div.id}));
  prefs.selected=id; if(prefs.view==='total') prefs.view=div.routes[0].id;
  $('nameInput').value='';
  render();
}
$('addBtn').onclick=addClimber;
$('nameInput').onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); addClimber(); } };
function canRecord(){ return isAdmin || (M.comp.selfScoring!==false && prefs.selected==='u:'+myId); }
document.querySelectorAll('.act').forEach(b=>b.onclick=()=>{
  const cid=prefs.selected, route=curDiv().routes.find(r=>r.id===prefs.view);
  if(!cid||!route||!canRecord()) return;
  const arr=attemptsOf(cid,route.id); if(calcRoute(arr).topAt) return;
  setAttempts(cid,route.id,[...arr,b.dataset.r]);
});
$('undoBtn').onclick=()=>{
  const cid=prefs.selected,rid=prefs.view; if(!cid||!canRecord()) return;
  const arr=attemptsOf(cid,rid); if(!arr.length) return;
  setAttempts(cid,rid,arr.slice(0,-1));
};
$('delBtn').onclick=()=>{
  const cid=prefs.selected,c=climberById(cid); if(!c||!isAdmin) return;
  if(!confirm(`刪除「${c.name}」和他在所有路線的紀錄？`)) return;
  if(cid.startsWith('u:')){ editEntry(cid.slice(2), ()=>null); }
  else {
    delete M.climbers[cid];
    Object.keys(M.results).forEach(k=>{ if(k.startsWith(cid+'__')) delete M.results[k]; });
    run(sb.from('climbers').delete().eq('id',cid));   // 成績會跟著自動刪除
  }
  prefs.selected=null; render();
};
let joinDiv=null;
$('joinBtn').onclick=()=>{
  const name=$('joinName').value.trim().slice(0,50);
  if(!name){ $('joinName').focus(); $('joinMsg').textContent='請先輸入名字。'; return; }
  const div=divisions().find(d=>d.id===joinDiv)||curDiv();
  $('joinMsg').textContent='';
  editEntry(myId, ()=>({name, division:div.id, joinedAt:now(), results:{}}));
  prefs.div=div.id; prefs.view=div.routes[0].id;
};
$('leaveBtn').onclick=()=>{
  const me=myEntry(); if(!me) return;
  if(!confirm('取消報名會刪除你在這場比賽的所有成績，確定嗎？')) return;
  editEntry(myId, ()=>null); prefs.selected=null; prefs.view='total';
};
$('claimBtn').onclick=async()=>{
  const k=(prompt('輸入這場比賽的管理碼')||'').trim().toUpperCase(); if(!k) return;
  const id=compId;
  const {data,error}=await sb.rpc('claim_comp_admin',{cid:id, k});
  if(error){ alert(error.message.includes('太多次')?'嘗試太多次，請 10 分鐘後再試。':'驗證失敗，請檢查網路後再試一次。'); return; }
  if(!data){ alert('管理碼不正確。'); return; }
  if(compId===id){ coAdmin=true; loadKey(); render(); }
};
$('selfToggle').onclick=()=>{
  if(!isAdmin) return;
  const v=M.comp.selfScoring===false;
  comps[compId]={...M.comp, selfScoring:v}; render();
  run(sb.from('comps').update({self_scoring:v}).eq('id',compId));
};
$('renameRouteBtn').onclick=()=>{
  const div=curDiv(), r=div.routes.find(x=>x.id===prefs.view); if(!r) return;
  const name=prompt('路線名稱',r.name); if(!name||!name.trim()) return;
  const divs=divisions().map(d=>d.id!==div.id?d:{...d,routes:d.routes.map(x=>x.id===r.id?{...x,name:name.trim().slice(0,30)}:x)});
  comps[compId]={...M.comp, divisions:divs}; render();
  run(sb.from('comps').update({divisions:divs}).eq('id',compId));
};
$('resetBtn').onclick=async()=>{
  if(!confirm('清除這場比賽所有選手和成績？組別、路線、照片和計時設定會保留。')) return;
  const id=compId;
  M.results={}; M.climbers={}; M.entries={}; prefs.selected=null; render();
  await run(sb.from('results').delete().eq('comp_id',id));
  await run(sb.from('climbers').delete().eq('comp_id',id));
  await run(sb.from('entries').delete().eq('comp_id',id));
  if(compId===id) await setSharedTimer({...DEFAULT_TIMER});
};
$('delCompBtn').onclick=async()=>{
  if(!confirm(`刪除「${M.comp.title}」？所有選手、成績和照片都會一起刪除，無法復原。`)) return;
  const id=compId;
  goPortal();
  // 先刪照片檔，再刪比賽（選手、成績、照片紀錄會跟著自動刪除）
  const {data:files}=await sb.storage.from(BUCKET).list(id,{limit:1000});
  if(files&&files.length) await sb.storage.from(BUCKET).remove(files.map(f=>`${id}/${f.name}`));
  if(await run(sb.from('comps').delete().eq('id',id))){ delete comps[id]; render(); }
};

/* ---------- 版本資訊 ---------- */
(function(){
  // 所有人都看得到版本號；更新紀錄只有系統管理員能點開（按鈕是 super-only，由 render() 控制）
  const log=window.CHANGELOG||[], btn=$('verBtn');
  if(!log.length){ btn.hidden=true; return; }
  $('verText').textContent=log[0].version;
  $('verList').innerHTML=log.map(v=>`<h3>${esc(v.version)}<small>${esc(v.date||'')}</small></h3><ul>${(v.notes||[]).map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`).join('');
  btn.onclick=()=>{ const open=$('verCard').hidden; $('verCard').hidden=!open; btn.setAttribute('aria-expanded',String(open)); };
})();

init();
setInterval(tick,250);
