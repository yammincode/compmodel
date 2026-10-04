-- =========================================================
-- 權限測試：模擬不同身分，確認資料庫層真的擋得住
-- 用法（本機或測試專案）：psql 執行這個檔案。全部包在交易裡，最後 rollback，不會留下資料。
-- 每一行輸出 ✅ / ❌，最後一行是總結。
-- =========================================================
begin;

-- 測試用帳號
insert into auth.users(id, aud, role, email, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a','authenticated','authenticated', null, true),  -- 主辦 host
  ('00000000-0000-0000-0000-00000000000b','authenticated','authenticated', null, true),  -- 選手 player
  ('00000000-0000-0000-0000-00000000000c','authenticated','authenticated', null, true),  -- 另一個人（之後當協同主辦）
  ('00000000-0000-0000-0000-00000000000d','authenticated','authenticated', 'yam@test', false); -- 系統管理員
insert into app_admins values ('00000000-0000-0000-0000-00000000000d');

create temp table _r(n serial, name text, pass boolean, detail text);
grant all on _r, _r_n_seq to authenticated, anon;

-- 切換身分
create function pg_temp.as_user(u text) returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  if u is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end $$;

-- 執行一段 SQL，回傳 'ok'（有影響到資料）、'0 rows'（被 RLS 默默擋掉）或錯誤訊息
create function pg_temp.try(q text) returns text language plpgsql as $$
declare n int;
begin
  execute q; get diagnostics n = row_count;
  return case when n > 0 then 'ok' else '0 rows' end;
exception when others then return 'error: ' || sqlerrm;
end $$;

create function pg_temp.expect(name text, q text, want_ok boolean) returns void language plpgsql as $$
declare r text := pg_temp.try(q);
begin
  insert into _r(name, pass, detail) values (name, (r = 'ok') = want_ok, r);
end $$;

create function pg_temp.check(name text, cond boolean, detail text default '') returns void language plpgsql as $$
begin insert into _r(name, pass, detail) values (name, coalesce(cond, false), detail); end $$;

-- ---------- 主辦建立比賽 ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect('任何人（匿名）都能建立比賽',
  $$insert into comps(id,title,owner_id,divisions,config) values ('c1','測試賽','00000000-0000-0000-0000-00000000000a',
    '[{"id":"d1","name":"男子組","routes":[{"id":"r1","name":"路線 1"}]}]','{"climbMin":4,"restMin":0}')$$, true);
select pg_temp.expect('不能用別人的名義建立比賽',
  $$insert into comps(id,title,owner_id,divisions,config) values ('c2','x','00000000-0000-0000-0000-00000000000b','[]','{}')$$, false);
select pg_temp.check('建立比賽自動產生 6 碼管理碼', (select key ~ '^[A-HJ-NP-Z2-9]{6}$' from comp_keys where comp_id='c1'),
  (select key from comp_keys where comp_id='c1'));
select pg_temp.check('主辦看得到管理碼', (select count(*) from comp_keys where comp_id='c1') = 1);
select pg_temp.expect('主辦能控制計時', $$update comps set timer='{"round":1,"running":true,"elapsed":0,"startedAt":1}' where id='c1'$$, true);
select pg_temp.expect('主辦能新增選手', $$insert into climbers(id,comp_id,name,division) values ('k1','c1','阿明','d1')$$, true);
select pg_temp.expect('主辦能記成績', $$insert into results(comp_id,climber_id,route_id,attempts) values ('c1','k1','r1','{f,t}')$$, true);
select pg_temp.expect('主辦能存照片標記', $$insert into photos(comp_id,route_id,image_path) values ('c1','r1','c1/r1.jpg')$$, true);
select pg_temp.expect('主辦不能把比賽轉給別人', $$update comps set owner_id='00000000-0000-0000-0000-00000000000b' where id='c1'$$, false);
select pg_temp.expect('主辦不能改比賽 id', $$update comps set id='zzz' where id='c1'$$, false);
select pg_temp.check('新比賽自動設定 10 天後刪除',
  (select expires_at between now() + interval '9 days 23 hours' and now() + interval '10 days 1 hour' from comps where id='c1'));
select pg_temp.expect('主辦不能延長自動刪除日期', $$update comps set expires_at=now()+interval '1 year' where id='c1'$$, false);
select pg_temp.expect('主辦不能設成永久保留', $$update comps set expires_at=null where id='c1'$$, false);
select pg_temp.expect('建立時自己指定到期日也沒用（會被改回 10 天）',
  $$insert into comps(id,title,owner_id,divisions,config,expires_at) values ('c5','x','00000000-0000-0000-0000-00000000000a','[]','{}',now()+interval '5 years')$$, true);
select pg_temp.check('自己指定的到期日被改回 10 天', (select expires_at < now() + interval '11 days' from comps where id='c5'));
select pg_temp.expect('一般人不能手動執行「刪除到期比賽」', $$select delete_expired_comps()$$, false);

-- ---------- 選手 ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check('選手讀得到比賽', (select count(*) from comps where id='c1') = 1);
select pg_temp.check('選手讀得到成績', (select count(*) from results where comp_id='c1') = 1);
select pg_temp.check('選手讀不到管理碼', (select count(*) from comp_keys) = 0);
select pg_temp.expect('選手能報名', $$insert into entries(comp_id,user_id,name,division) values ('c1','00000000-0000-0000-0000-00000000000b','小華','d1')$$, true);
select pg_temp.expect('選手能記自己成績', $$update entries set results='{"r1":["z"]}' where comp_id='c1' and user_id='00000000-0000-0000-0000-00000000000b'$$, true);
select pg_temp.expect('選手不能替別人報名', $$insert into entries(comp_id,user_id,name,division) values ('c1','00000000-0000-0000-0000-00000000000c','假的','d1')$$, false);
select pg_temp.expect('選手不能改計時', $$update comps set timer='{"round":9,"running":false,"elapsed":0,"startedAt":0}' where id='c1'$$, false);
select pg_temp.expect('選手不能刪比賽', $$delete from comps where id='c1'$$, false);
select pg_temp.expect('選手不能改裁判成績', $$update results set attempts='{t}' where comp_id='c1'$$, false);
select pg_temp.expect('選手不能新增裁判選手', $$insert into climbers(id,comp_id,name,division) values ('k9','c1','x','d1')$$, false);
select pg_temp.expect('選手不能改照片', $$update photos set marks='[]' where comp_id='c1'$$, false);
select pg_temp.expect('選手不能自己變成協同主辦', $$insert into comp_admins values ('c1','00000000-0000-0000-0000-00000000000b')$$, false);
select pg_temp.expect('選手不能把報名搬到別人名下',
  $$update entries set user_id='00000000-0000-0000-0000-00000000000c' where user_id='00000000-0000-0000-0000-00000000000b'$$, false);
select pg_temp.expect('選手不能讀管理碼錯誤紀錄', $$select * from claim_failures$$, false);

-- 主辦關閉自行記分
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect('主辦能關閉自行記分', $$update comps set self_scoring=false where id='c1'$$, true);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect('關閉後選手不能改成績', $$update entries set results='{}' where user_id='00000000-0000-0000-0000-00000000000b'$$, false);
select pg_temp.expect('關閉後選手仍可改名字', $$update entries set name='小華華' where user_id='00000000-0000-0000-0000-00000000000b'$$, true);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.expect('關閉後新報名不能夾帶成績',
  $$insert into entries(comp_id,user_id,name,division,results) values ('c1','00000000-0000-0000-0000-00000000000c','阿強','d1','{"r1":["t"]}')$$, false);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect('關閉後主辦仍能幫選手改成績', $$update entries set results='{"r1":["z","t"]}' where user_id='00000000-0000-0000-0000-00000000000b'$$, true);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect('選手能取消自己的報名', $$delete from entries where user_id='00000000-0000-0000-0000-00000000000b'$$, true);

-- ---------- 管理碼 ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check('輸入錯的管理碼被拒', not claim_comp_admin('c1', 'WRONG1'));
select pg_temp.check('錯的管理碼後仍不是主辦', not is_comp_admin('c1'));
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
create temp table _k as select key from comp_keys where comp_id='c1';
grant select on _k to authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check('輸入正確管理碼（小寫也行）變成協同主辦', claim_comp_admin('c1', lower((select key from _k))));
select pg_temp.expect('協同主辦能控制計時', $$update comps set timer='{"round":2,"running":false,"elapsed":0,"startedAt":0}' where id='c1'$$, true);
select pg_temp.check('協同主辦看得到管理碼', (select count(*) from comp_keys where comp_id='c1') = 1);
select pg_temp.expect('協同主辦也不能轉讓主辦', $$update comps set owner_id='00000000-0000-0000-0000-00000000000c' where id='c1'$$, false);

-- 亂猜管理碼會被鎖
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
-- 每次猜測都是獨立的一次呼叫（跟真實情況一樣），所以分開執行 35 次
select pg_temp.try($$select claim_comp_admin('c1','AAAAAA')$$) from generate_series(1,35);
create temp table _lock as select pg_temp.try($$select claim_comp_admin('c1', (select key from _k))$$) as r;
select pg_temp.check('一直猜錯會被暫時鎖住（正確的也不行）', (select r from _lock) like 'error:%嘗試太多次%', (select r from _lock));
select pg_temp.check('被鎖住的人沒有變成主辦', not is_comp_admin('c1'));

-- ---------- 沒登入的人 ----------
select pg_temp.as_user(null);
select pg_temp.check('沒登入也看得到比賽', (select count(*) from comps where id='c1') = 1);
select pg_temp.expect('沒登入不能建立比賽', $$insert into comps(id,title,divisions,config) values ('c3','x','[]','{}')$$, false);
select pg_temp.check('沒登入不能用管理碼', not claim_comp_admin('c1', 'AAAAAA'));

-- ---------- 系統管理員 ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.check('系統管理員是 super', is_super());
select pg_temp.expect('系統管理員能改別人的比賽', $$update comps set title='改名' where id='c1'$$, true);
select pg_temp.check('系統管理員看得到所有管理碼', (select count(*) from comp_keys) >= 1);
select pg_temp.expect('系統管理員可以替別人建立比賽（匯入用）',
  $$insert into comps(id,title,owner_id,divisions,config) values ('c4','匯入','00000000-0000-0000-0000-00000000000a','[]','{}')$$, true);
select pg_temp.expect('系統管理員能改管理碼（匯入用）', $$update comp_keys set key='ABCDEF' where comp_id='c4'$$, true);
select pg_temp.expect('系統管理員能刪比賽', $$delete from comps where id='c4'$$, true);
select pg_temp.expect('系統管理員能設成永久保留', $$update comps set expires_at=null where id='c1'$$, true);
select pg_temp.expect('系統管理員能把已到期的比賽改回來', $$update comps set expires_at=now()-interval '1 day' where id='c5'$$, true);
-- 模擬排程：用資料庫管理者身分執行刪除
select set_config('role','postgres',true);
create temp table _del as select delete_expired_comps() as n;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.check('排程只刪到期的比賽', (select count(*) from comps where id='c5') = 0 and (select count(*) from comps where id='c1') = 1);
select pg_temp.check('永久保留的比賽不會被刪', (select expires_at is null from comps where id='c1'));

-- ---------- 照片儲存 ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect('選手不能上傳照片到比賽資料夾',
  $$insert into storage.objects(bucket_id,name) values ('route-photos','c1/r1-1.jpg')$$, false);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect('主辦能上傳照片到自己比賽的資料夾',
  $$insert into storage.objects(bucket_id,name) values ('route-photos','c1/r1-1.jpg')$$, true);

-- 主辦刪除比賽，所有資料一起刪
select pg_temp.expect('主辦能刪除比賽', $$delete from comps where id='c1'$$, true);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.check('刪除比賽時選手、成績、照片紀錄一起刪掉',
  (select count(*) from climbers where comp_id='c1') + (select count(*) from results where comp_id='c1')
  + (select count(*) from photos where comp_id='c1') + (select count(*) from comp_keys where comp_id='c1') = 0);

-- ---------- 結果 ----------
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
reset role;
select (case when pass then '✅ ' else '❌ ' end) || name || case when pass then '' else '  → ' || detail end as "測試結果" from _r order by n;
select '通過 ' || count(*) filter (where pass) || ' / ' || count(*) as "總結" from _r;
rollback;
