-- =========================================================
-- 原岩攀岩比賽系統 Supabase 資料庫結構（草稿，待在 Claude Code 中測試）
-- 對應 reference/firestore.rules 的權限設計
-- 需先在 Supabase 後台啟用 Anonymous Sign-ins
-- =========================================================

-- 系統管理員（Yam），可管理所有比賽
create table if not exists app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- 比賽
create table if not exists comps (
  id            text primary key default replace(gen_random_uuid()::text,'-',''),
  title         text not null,
  owner_id      uuid references auth.users(id),
  divisions     jsonb not null,          -- [{id,name,routes:[{id,name}]}]
  config        jsonb not null,          -- {climbMin, restMin}
  timer         jsonb not null default '{"round":1,"running":false,"elapsed":0,"startedAt":0}',
  self_scoring  boolean not null default true,
  photo_routes  text[] not null default '{}',
  created_at    timestamptz not null default now()
);

-- 管理碼（只有主辦看得到）
create table if not exists comp_keys (
  comp_id text primary key references comps(id) on delete cascade,
  key     text not null
);

-- 協同主辦（輸入管理碼的人）
create table if not exists comp_admins (
  comp_id text references comps(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  primary key (comp_id, user_id)
);

-- 主辦／裁判手動新增的選手
create table if not exists climbers (
  id         text primary key default replace(gen_random_uuid()::text,'-',''),
  comp_id    text not null references comps(id) on delete cascade,
  name       text not null,
  division   text not null,
  created_at timestamptz not null default now()
);

-- 主辦／裁判記的成績
create table if not exists results (
  comp_id    text not null references comps(id) on delete cascade,
  climber_id text not null references climbers(id) on delete cascade,
  route_id   text not null,
  attempts   text[] not null default '{}',   -- 'f' 失敗 / 'z' Zone / 't' Top
  primary key (climber_id, route_id)
);

-- 選手自行報名與記分
create table if not exists entries (
  comp_id   text not null references comps(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  name      text not null,
  division  text not null,
  joined_at timestamptz not null default now(),
  results   jsonb not null default '{}',    -- {routeId: ['f','z','t']}
  primary key (comp_id, user_id)
);

-- 路線照片與圈路線標記（照片檔建議放 Supabase Storage，這裡存路徑）
create table if not exists photos (
  comp_id    text not null references comps(id) on delete cascade,
  route_id   text not null,
  image_path text,                         -- Storage 路徑；舊資料可暫存 data URL 於 image_data
  image_data text,
  w int, h int,
  marks      jsonb not null default '[]',  -- [{x,y,r,type}] x,y,r 為 0~1 比例
  updated_at timestamptz not null default now(),
  primary key (comp_id, route_id)
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

-- 用管理碼成為協同主辦（比對在伺服器端做，管理碼不外流）
create or replace function claim_comp_admin(cid text, k text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if exists(select 1 from comp_keys where comp_id = cid and key = upper(k)) then
    insert into comp_admins(comp_id, user_id) values (cid, auth.uid()) on conflict do nothing;
    return true;
  end if;
  return false;
end $$;

-- 建立比賽時自動產生管理碼
create or replace function create_comp_key() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into comp_keys(comp_id, key)
  values (new.id, upper(substr(translate(encode(gen_random_bytes(8),'base64'),'+/=O0I1l',''),1,6)));
  return new;
end $$;
drop trigger if exists trg_comp_key on comps;
create trigger trg_comp_key after insert on comps for each row execute function create_comp_key();

-- 主辦關閉自行記分時，選手不能改成績（主辦本人例外）
create or replace function guard_entry_results() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.results is distinct from old.results
     and not is_comp_admin(new.comp_id)
     and (select self_scoring from comps where id = new.comp_id) = false then
    raise exception '主辦已關閉自行記分';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_entry on entries;
create trigger trg_guard_entry before update on entries for each row execute function guard_entry_results();

-- 不能把比賽轉給別人
create or replace function guard_comp_owner() returns trigger
language plpgsql as $$
begin
  if new.owner_id is distinct from old.owner_id and not is_super() then
    raise exception '不能變更主辦';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_owner on comps;
create trigger trg_guard_owner before update on comps for each row execute function guard_comp_owner();

-- ---------- Row Level Security ----------
alter table app_admins  enable row level security;
alter table comps       enable row level security;
alter table comp_keys   enable row level security;
alter table comp_admins enable row level security;
alter table climbers    enable row level security;
alter table results     enable row level security;
alter table entries     enable row level security;
alter table photos      enable row level security;

create policy "admins self" on app_admins for select using (user_id = auth.uid());

create policy "comps read"   on comps for select using (true);
create policy "comps create" on comps for insert with check (auth.uid() is not null and (owner_id = auth.uid() or is_super()));
create policy "comps update" on comps for update using (is_comp_admin(id));
create policy "comps delete" on comps for delete using (is_comp_admin(id));

create policy "keys read" on comp_keys for select using (is_comp_admin(comp_id));

create policy "co-admin read own" on comp_admins for select using (user_id = auth.uid() or is_comp_admin(comp_id));
create policy "co-admin delete"   on comp_admins for delete using (is_super());

create policy "climbers read"  on climbers for select using (true);
create policy "climbers write" on climbers for all using (is_comp_admin(comp_id)) with check (is_comp_admin(comp_id));

create policy "results read"  on results for select using (true);
create policy "results write" on results for all using (is_comp_admin(comp_id)) with check (is_comp_admin(comp_id));

create policy "photos read"  on photos for select using (true);
create policy "photos write" on photos for all using (is_comp_admin(comp_id)) with check (is_comp_admin(comp_id));

create policy "entries read"   on entries for select using (true);
create policy "entries insert" on entries for insert with check (user_id = auth.uid() or is_comp_admin(comp_id));
create policy "entries update" on entries for update using (user_id = auth.uid() or is_comp_admin(comp_id));
create policy "entries delete" on entries for delete using (user_id = auth.uid() or is_comp_admin(comp_id));

-- ---------- 即時同步 ----------
alter publication supabase_realtime add table comps, climbers, results, entries, photos;

-- 設定系統管理員：用 Email 註冊後執行（把 email 換成 Yam 的）
-- insert into app_admins(user_id) select id from auth.users where email = 'YOUR_EMAIL';
