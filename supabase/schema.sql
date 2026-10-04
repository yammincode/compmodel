-- =========================================================
-- 原岩攀岩比賽系統 Supabase 資料庫結構
-- 用法：Supabase 後台 → SQL Editor → 貼上整份 → Run
-- 這份可以重複執行（已存在的東西會略過或更新），不會刪掉資料。
-- 已在本機 Supabase 實測，權限測試見 supabase/tests/rls-test.sql
-- 執行前請先在 Authentication → Sign In / Providers 開啟 Anonymous Sign-ins
-- =========================================================

-- ---------- 資料表 ----------

-- 系統管理員（Yam），可管理所有比賽
create table if not exists app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- 比賽
create table if not exists comps (
  id            text primary key default replace(gen_random_uuid()::text,'-',''),
  title         text not null check (char_length(title) between 1 and 100),
  owner_id      uuid references auth.users(id) on delete set null,
  divisions     jsonb not null,          -- [{id,name,routes:[{id,name}]}]
  config        jsonb not null,          -- {climbMin, restMin}
  timer         jsonb not null default '{"round":1,"running":false,"elapsed":0,"startedAt":0}',
  self_scoring  boolean not null default true,
  created_at    timestamptz not null default now(),
  check (octet_length(divisions::text) < 20000)
);

-- 管理碼（只有主辦看得到）
create table if not exists comp_keys (
  comp_id text primary key references comps(id) on delete cascade,
  key     text not null
);

-- 協同主辦（輸入正確管理碼的人）
create table if not exists comp_admins (
  comp_id text references comps(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  primary key (comp_id, user_id)
);

-- 管理碼輸入錯誤紀錄（防止有人一直亂猜）
create table if not exists claim_failures (
  comp_id text not null references comps(id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists claim_failures_comp_at on claim_failures(comp_id, at);

-- 主辦／裁判手動新增的選手
create table if not exists climbers (
  id         text primary key default replace(gen_random_uuid()::text,'-',''),
  comp_id    text not null references comps(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 50),
  division   text not null,
  created_at timestamptz not null default now()
);
create index if not exists climbers_comp on climbers(comp_id);

-- 主辦／裁判記的成績
create table if not exists results (
  comp_id    text not null references comps(id) on delete cascade,
  climber_id text not null references climbers(id) on delete cascade,
  route_id   text not null,
  attempts   text[] not null default '{}',   -- 'f' 失敗 / 'z' Zone / 't' Top
  primary key (climber_id, route_id)
);
create index if not exists results_comp on results(comp_id);

-- 選手自行報名與記分（每個人只能改自己這一筆）
create table if not exists entries (
  comp_id   text not null references comps(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  name      text not null check (char_length(name) between 1 and 50),
  division  text not null,
  joined_at timestamptz not null default now(),
  results   jsonb not null default '{}',    -- {routeId: ['f','z','t']}
  primary key (comp_id, user_id),
  check (octet_length(results::text) < 20000)
);

-- 路線照片與圈路線標記（照片檔放在 Storage 的 route-photos，這裡只存路徑）
create table if not exists photos (
  comp_id    text not null references comps(id) on delete cascade,
  route_id   text not null,
  image_path text not null,                -- Storage 路徑：<比賽id>/<路線id>-<時間>.jpg
  w int, h int,
  marks      jsonb not null default '[]',  -- [{x,y,r,type}] x,y,r 為 0~1 比例
  updated_at timestamptz not null default now(),
  primary key (comp_id, route_id),
  check (octet_length(marks::text) < 50000)
);

-- ---------- 權限判斷 ----------
create or replace function is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from app_admins where user_id = auth.uid());
$$;

create or replace function is_comp_admin(cid text) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    is_super()
    or exists(select 1 from comps where id = cid and owner_id = auth.uid())
    or exists(select 1 from comp_admins where comp_id = cid and user_id = auth.uid())
  );
$$;

-- 伺服器時間（毫秒）。各手機用它校正時鐘，計時器才會一致
create or replace function server_now_ms() returns bigint
language sql stable as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

-- 產生 6 碼管理碼（不含容易看錯的 O 0 I 1）
create or replace function new_comp_key() returns text
language sql volatile set search_path = public, extensions as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (get_byte(b, i) % 32) + 1, 1), '')
  from (select extensions.gen_random_bytes(6) as b) r, generate_series(0, 5) as i;
$$;

-- 用管理碼成為協同主辦（比對在伺服器端做，管理碼不外流）
-- 同一場比賽 10 分鐘內錯 30 次就暫時鎖住，防止亂猜
create or replace function claim_comp_admin(cid text, k text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if (select count(*) from claim_failures
      where comp_id = cid and at > now() - interval '10 minutes') >= 30 then
    raise exception '嘗試太多次，請 10 分鐘後再試';
  end if;
  if exists(select 1 from comp_keys where comp_id = cid and key = upper(trim(k))) then
    insert into comp_admins(comp_id, user_id) values (cid, auth.uid()) on conflict do nothing;
    return true;
  end if;
  if exists(select 1 from comps where id = cid) then
    insert into claim_failures(comp_id) values (cid);
  end if;
  return false;
end $$;

-- 建立比賽時自動產生管理碼
create or replace function create_comp_key() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into comp_keys(comp_id, key) values (new.id, new_comp_key()) on conflict do nothing;
  return new;
end $$;
drop trigger if exists trg_comp_key on comps;
create trigger trg_comp_key after insert on comps for each row execute function create_comp_key();

-- 選手報名的保護：
-- 1. 主辦關閉自行記分時，選手不能改成績（主辦本人例外）
-- 2. 報名不能被搬到別的比賽或別人名下
create or replace function guard_entry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_comp_admin(new.comp_id) then return new; end if;
  if tg_op = 'UPDATE' and (new.comp_id is distinct from old.comp_id or new.user_id is distinct from old.user_id) then
    raise exception '不能變更報名的比賽或選手';
  end if;
  if (select self_scoring from comps where id = new.comp_id) = false
     and new.results is distinct from (case when tg_op = 'UPDATE' then old.results else '{}'::jsonb end) then
    raise exception '主辦已關閉自行記分';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_entry on entries;
create trigger trg_guard_entry before insert or update on entries for each row execute function guard_entry();

-- 不能把比賽轉給別人、不能改比賽 id
create or replace function guard_comp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.id is distinct from old.id then
    raise exception '不能變更比賽 id';
  end if;
  if new.owner_id is distinct from old.owner_id and not is_super() then
    raise exception '不能變更主辦';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_owner on comps;
drop trigger if exists trg_guard_comp on comps;
create trigger trg_guard_comp before update on comps for each row execute function guard_comp();

-- 舊版草稿留下的函式（已被 guard_entry / guard_comp 取代）
drop function if exists guard_entry_results();
drop function if exists guard_comp_owner();

-- ---------- Row Level Security（資料庫層的權限） ----------
alter table app_admins     enable row level security;
alter table comps          enable row level security;
alter table comp_keys      enable row level security;
alter table comp_admins    enable row level security;
alter table claim_failures enable row level security;  -- 沒有任何 policy = 前端完全碰不到
alter table climbers       enable row level security;
alter table results        enable row level security;
alter table entries        enable row level security;
alter table photos         enable row level security;

drop policy if exists "admins self" on app_admins;
create policy "admins self" on app_admins for select using (user_id = auth.uid());

drop policy if exists "comps read"   on comps;
drop policy if exists "comps create" on comps;
drop policy if exists "comps update" on comps;
drop policy if exists "comps delete" on comps;
create policy "comps read"   on comps for select using (true);
create policy "comps create" on comps for insert with check (auth.uid() is not null and (owner_id = auth.uid() or is_super()));
create policy "comps update" on comps for update using (is_comp_admin(id)) with check (is_comp_admin(id));
create policy "comps delete" on comps for delete using (is_comp_admin(id));

drop policy if exists "keys read"   on comp_keys;
drop policy if exists "keys update" on comp_keys;
create policy "keys read"   on comp_keys for select using (is_comp_admin(comp_id));
create policy "keys update" on comp_keys for update using (is_comp_admin(comp_id)) with check (is_comp_admin(comp_id) and char_length(key) = 6);

drop policy if exists "co-admin read own" on comp_admins;
drop policy if exists "co-admin delete"   on comp_admins;
create policy "co-admin read own" on comp_admins for select using (user_id = auth.uid() or is_comp_admin(comp_id));
create policy "co-admin delete"   on comp_admins for delete using (is_super());

drop policy if exists "climbers read"  on climbers;
drop policy if exists "climbers write" on climbers;
create policy "climbers read"  on climbers for select using (true);
create policy "climbers write" on climbers for all using (is_comp_admin(comp_id)) with check (is_comp_admin(comp_id));

drop policy if exists "results read"  on results;
drop policy if exists "results write" on results;
create policy "results read"  on results for select using (true);
create policy "results write" on results for all using (is_comp_admin(comp_id)) with check (is_comp_admin(comp_id));

drop policy if exists "photos read"  on photos;
drop policy if exists "photos write" on photos;
create policy "photos read"  on photos for select using (true);
create policy "photos write" on photos for all using (is_comp_admin(comp_id)) with check (is_comp_admin(comp_id));

drop policy if exists "entries read"   on entries;
drop policy if exists "entries insert" on entries;
drop policy if exists "entries update" on entries;
drop policy if exists "entries delete" on entries;
create policy "entries read"   on entries for select using (true);
create policy "entries insert" on entries for insert with check (user_id = auth.uid() or is_comp_admin(comp_id));
create policy "entries update" on entries for update using (user_id = auth.uid() or is_comp_admin(comp_id))
                                                     with check (user_id = auth.uid() or is_comp_admin(comp_id));
create policy "entries delete" on entries for delete using (user_id = auth.uid() or is_comp_admin(comp_id));

-- 讓網站（anon / authenticated 角色）可以存取，實際能做什麼由上面的 policy 決定
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on app_admins, comps, comp_keys, comp_admins, climbers, results, entries, photos to anon, authenticated;
revoke all on claim_failures from anon, authenticated;
grant execute on function is_super(), is_comp_admin(text), server_now_ms(), claim_comp_admin(text, text) to anon, authenticated;
revoke execute on function new_comp_key() from public, anon, authenticated;

-- ---------- 照片儲存（Storage） ----------
-- 公開讀取的 route-photos 桶子，只收 2MB 以下的圖片
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('route-photos', 'route-photos', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 檔名第一層資料夾 = 比賽 id，只有該比賽的主辦能上傳／刪除
drop policy if exists "route photos read"   on storage.objects;
drop policy if exists "route photos insert" on storage.objects;
drop policy if exists "route photos update" on storage.objects;
drop policy if exists "route photos delete" on storage.objects;
create policy "route photos read" on storage.objects for select
  using (bucket_id = 'route-photos');
create policy "route photos insert" on storage.objects for insert
  with check (bucket_id = 'route-photos' and public.is_comp_admin(split_part(name, '/', 1)));
create policy "route photos update" on storage.objects for update
  using (bucket_id = 'route-photos' and public.is_comp_admin(split_part(name, '/', 1)))
  with check (bucket_id = 'route-photos' and public.is_comp_admin(split_part(name, '/', 1)));
create policy "route photos delete" on storage.objects for delete
  using (bucket_id = 'route-photos' and public.is_comp_admin(split_part(name, '/', 1)));

-- ---------- 即時同步（Realtime） ----------
do $$
declare t text;
begin
  foreach t in array array['comps','climbers','results','entries','photos'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- 設定系統管理員 ----------
-- 先在 Authentication → Users → Add user 建立 Yam 的 Email 帳號，再把下面這行的 email 換掉、取消註解後執行：
-- insert into app_admins(user_id) select id from auth.users where email = 'YOUR_EMAIL' on conflict do nothing;
