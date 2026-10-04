-- =========================================================
-- 健康檢查：確認 Supabase 的資料庫設定正確
-- 用法：Supabase → SQL Editor → 貼上整份 → Run
-- 結果會是一張表，每一項 ✅ 正常／❌ 有問題／⚠️ 提醒。只會讀取，不會改到任何資料。
-- =========================================================
drop table if exists _check;
create temp table _check(n serial, 項目 text, 結果 text, 說明 text);

do $$
declare
  t text; f text; ok boolean; v text;
  tables text[] := array['app_admins','comps','comp_keys','comp_admins','claim_failures','climbers','results','entries','photos'];
begin
  -- 1. 資料表
  foreach t in array tables loop
    ok := to_regclass('public.'||t) is not null;
    insert into _check(項目,結果,說明) values ('資料表 '||t, case when ok then '✅' else '❌' end,
      case when ok then '' else '缺少這張表：請重新執行最新的 supabase/schema.sql' end);
  end loop;

  -- 2. 是不是最新版 schema
  foreach f in array array['is_super','is_comp_admin','server_now_ms','new_comp_key','claim_comp_admin','guard_entry','guard_comp'] loop
    ok := exists(select 1 from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname=f);
    insert into _check(項目,結果,說明) values ('函式 '||f, case when ok then '✅' else '❌' end,
      case when ok then '' else '缺少：資料庫是舊版，請重新執行最新的 supabase/schema.sql' end);
  end loop;
  if exists(select 1 from pg_proc where proname in ('guard_entry_results','guard_comp_owner')) then
    insert into _check(項目,結果,說明) values ('舊版草稿殘留','❌','資料庫還是舊的草稿版本：請從 GitHub 複製最新的 supabase/schema.sql 整份重新執行');
  end if;

  -- 3. 權限規則（RLS）
  foreach t in array tables loop
    if to_regclass('public.'||t) is null then continue; end if;
    ok := (select relrowsecurity from pg_class where oid=('public.'||t)::regclass);
    if not ok then
      insert into _check(項目,結果,說明) values ('權限保護 '||t,'❌','沒有開啟 Row Level Security：請重新執行 supabase/schema.sql');
    end if;
  end loop;
  foreach v in array array['entries insert','entries update','entries delete','entries read','comps create','comps read','comps update'] loop
    ok := exists(select 1 from pg_policies where schemaname='public' and policyname=v);
    insert into _check(項目,結果,說明) values ('權限規則「'||v||'」', case when ok then '✅' else '❌' end,
      case when ok then '' else '缺少：請重新執行 supabase/schema.sql' end);
  end loop;
  if exists(select 1 from pg_policies where schemaname='public' and tablename='entries'
            and policyname not in ('entries insert','entries update','entries delete','entries read')) then
    insert into _check(項目,結果,說明) select '多出來的規則「'||policyname||'」（'||tablename||'）','⚠️','不是 schema.sql 建的，可能會擋住報名；如果不是你自己加的，可以到 Authentication → Policies 刪掉'
      from pg_policies where schemaname='public' and tablename='entries'
      and policyname not in ('entries insert','entries update','entries delete','entries read');
  end if;

  -- 4. 網站使用者的存取權
  foreach t in array array['comps','entries','climbers','results','photos'] loop
    if to_regclass('public.'||t) is null then continue; end if;
    ok := has_table_privilege('authenticated','public.'||t,'SELECT') and has_table_privilege('authenticated','public.'||t,'INSERT')
       and has_table_privilege('authenticated','public.'||t,'UPDATE') and has_table_privilege('authenticated','public.'||t,'DELETE');
    insert into _check(項目,結果,說明) values ('存取權 '||t, case when ok then '✅' else '❌' end,
      case when ok then '' else '網站沒有權限寫入這張表：請重新執行 supabase/schema.sql（最後面有 grant 設定）' end);
  end loop;

  -- 5. 即時同步、照片儲存
  foreach t in array array['comps','climbers','results','entries','photos'] loop
    ok := exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t);
    if not ok then insert into _check(項目,結果,說明) values ('即時同步 '||t,'❌','沒有加入 Realtime：請重新執行 supabase/schema.sql'); end if;
  end loop;
  ok := exists(select 1 from storage.buckets where id='route-photos' and public);
  insert into _check(項目,結果,說明) values ('照片儲存桶 route-photos', case when ok then '✅' else '❌' end,
    case when ok then '' else '缺少：請重新執行 supabase/schema.sql' end);

  -- 5b. 十天自動刪除
  ok := exists(select 1 from information_schema.columns where table_schema='public' and table_name='comps' and column_name='expires_at');
  insert into _check(項目,結果,說明) values ('比賽自動刪除日期欄位', case when ok then '✅' else '❌' end,
    case when ok then '' else '缺少：請重新執行最新的 supabase/schema.sql' end);
  ok := false;
  if to_regclass('cron.job') is not null then
    execute 'select exists(select 1 from cron.job where jobname=''delete-expired-comps'' and active)' into ok;
  end if;
  insert into _check(項目,結果,說明) values ('每天自動刪除到期比賽的排程', case when ok then '✅' else '❌' end,
    case when ok then '每天台灣時間凌晨 3:00 執行' else '缺少：請重新執行最新的 supabase/schema.sql（會自動開啟 pg_cron 排程）' end);

  -- 6. 帳號
  insert into _check(項目,結果,說明) select '匿名登入（選手）',
    case when count(*)>0 then '✅' else '⚠️' end,
    case when count(*)>0 then '已經有 '||count(*)||' 個匿名使用者' else '還沒有人匿名登入過：請確認 Authentication → Sign In / Providers 有打開 Allow anonymous sign-ins' end
    from auth.users where is_anonymous;
  if to_regclass('public.app_admins') is not null then
    insert into _check(項目,結果,說明) select '系統管理員',
      case when count(*)>0 then '✅' else '❌' end,
      case when count(*)>0 then string_agg(u.email, '、') else '還沒設定：請照上線步驟第 4 步執行 insert into app_admins …' end
      from public.app_admins a left join auth.users u on u.id=a.user_id;
  end if;
end $$;

-- 7. 實際模擬：用最近一位匿名使用者的身分報名最新的比賽（模擬完會自動復原，不會留下資料）
do $$
declare u uuid; c text; d text; r text;
begin
  if to_regclass('public.entries') is null or to_regclass('public.comps') is null then return; end if;
  select id, divisions->0->>'id' into c, d from public.comps order by created_at desc limit 1;
  select a.id into u from auth.users a
    where a.is_anonymous and not exists(select 1 from public.entries e where e.comp_id=c and e.user_id=a.id)
    order by a.created_at desc limit 1;
  if c is null or u is null then
    insert into _check(項目,結果,說明) values ('模擬選手報名','⚠️','略過：需要至少一場比賽和一位還沒報名的匿名使用者');
    return;
  end if;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated','is_anonymous',true)::text, true);
    perform set_config('role','authenticated', true);
    insert into public.entries(comp_id,user_id,name,division) values (c,u,'健康檢查',coalesce(d,'x'));
    raise exception using errcode='HC000', message='ok';
  exception when others then
    r := case when sqlstate='HC000' then null else sqlerrm||'（代碼 '||sqlstate||'）' end;
  end;
  insert into _check(項目,結果,說明) values ('模擬選手報名', case when r is null then '✅' else '❌' end,
    coalesce('被擋下：'||r, '選手可以正常報名'));
end $$;

select 項目, 結果, 說明 from _check order by (結果='✅'), n;
