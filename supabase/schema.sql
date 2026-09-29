-- =====================================================================
-- 출석·주간보고 사이트 — Supabase 설정
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여넣고 Run 하세요.
-- 이미 예전 버전을 실행했어도 다시 실행하면 최신 상태로 바뀝니다.
-- =====================================================================

-- ---------- 0. 예전 버전 정리 (수정 기록·출석 기능 제거) ----------
drop trigger if exists attendance_log on public.attendance;
drop trigger if exists attendance_mark on public.attendance;
drop trigger if exists profiles_log on public.profiles;
drop function if exists public.attendance_log();
drop function if exists public.attendance_mark();
drop function if exists public.profiles_log();
drop table if exists public.edit_log cascade;
drop function if exists public.punch(text);
drop table if exists public.attendance cascade;
alter table if exists public.reports      drop column if exists date_edited;
alter table if exists public.report_files drop column if exists date_edited;

-- ---------- 1. 테이블 ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  login_id    text not null unique,
  role        text not null default 'staff' check (role in ('staff','admin')),
  approved    boolean not null default false,
  created_at  timestamptz not null default now()
);



create table if not exists public.reports (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  title         text not null default '',
  report_date   date not null default ((now() at time zone 'Asia/Seoul')::date),  -- 직원이 지정하는 보고 날짜
  content       text not null default '',                                          -- 이번 주 한 일
  submitted_at  timestamptz not null default now(),  -- 제출일 (대표가 수정 가능)
  updated_at    timestamptz not null default now()
);

create table if not exists public.report_files (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  report_id    bigint not null references public.reports(id) on delete cascade,
  name         text not null,                        -- 원래 파일 이름
  size         bigint not null default 0,
  path         text not null unique,                 -- 스토리지 경로
  uploaded_at  timestamptz not null default now()    -- 올린 날짜 (대표가 수정 가능)
);

create index if not exists reports_user_idx on public.reports (user_id);
create index if not exists reports_submitted_idx on public.reports (submitted_at desc);
create index if not exists files_report_idx on public.report_files (report_id);
create index if not exists files_user_idx on public.report_files (user_id);

-- ---------- 2. 권한 확인 함수 ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and (approved or role = 'admin'));
$$;

-- ---------- 3. 회원가입 시 프로필 자동 생성 ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, login_id)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'name', ''), '이름없음'),
    coalesce(nullif(new.raw_user_meta_data->>'login_id', ''), split_part(new.email, '@', 1))
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------- 5. 보고서: 직원은 제출일을 못 바꿈 (대표는 자유롭게 수정) ----------
create or replace function public.reports_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not is_admin() then
      new.user_id := auth.uid();
      new.submitted_at := now();
    end if;
    new.updated_at := now();
  else
    if not is_admin() then
      new.user_id := old.user_id;
      new.submitted_at := old.submitted_at;
    end if;
    if (new.title, new.content, new.report_date) is distinct from (old.title, old.content, old.report_date) then
      new.updated_at := now();
    end if;
  end if;
  return new;
end $$;

drop trigger if exists reports_guard on public.reports;
create trigger reports_guard before insert or update on public.reports
  for each row execute function public.reports_guard();

-- ---------- 6. 파일: 직원이 올린 날짜는 서버 시각으로 고정 (대표는 자유롭게 수정) ----------
create or replace function public.files_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    new.user_id := auth.uid();
    new.uploaded_at := now();
  end if;
  return new;
end $$;

drop trigger if exists files_guard on public.report_files;
create trigger files_guard before insert on public.report_files
  for each row execute function public.files_guard();

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.reports_guard() from public, anon, authenticated;
revoke execute on function public.files_guard() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_active() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_active() to authenticated;

-- 일시정지 방지용 (GitHub Actions가 매일 호출)
create or replace function public.ping() returns text
language sql stable as $$ select 'ok' $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;

-- ---------- 7. 보안 규칙 (RLS) ----------
alter table public.profiles     enable row level security;
alter table public.reports      enable row level security;
alter table public.report_files enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.reports, public.report_files to authenticated;
revoke all on public.profiles, public.reports, public.report_files from anon;

-- profiles: 본인과 대표만 조회, 승인은 대표만
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or is_admin());
drop policy if exists "profiles_admin_update" on public.profiles;
create policy "profiles_admin_update" on public.profiles for update to authenticated
  using (is_admin()) with check (is_admin());

-- reports: 직원은 본인 것만 작성·수정·삭제, 대표는 전부
drop policy if exists "rep_select" on public.reports;
create policy "rep_select" on public.reports for select to authenticated
  using ((user_id = (select auth.uid()) and is_active()) or is_admin());
drop policy if exists "rep_insert" on public.reports;
create policy "rep_insert" on public.reports for insert to authenticated
  with check ((user_id = (select auth.uid()) and is_active()) or is_admin());
drop policy if exists "rep_update" on public.reports;
create policy "rep_update" on public.reports for update to authenticated
  using ((user_id = (select auth.uid()) and is_active()) or is_admin())
  with check ((user_id = (select auth.uid()) and is_active()) or is_admin());
drop policy if exists "rep_admin_delete" on public.reports;
drop policy if exists "rep_delete" on public.reports;
create policy "rep_delete" on public.reports for delete to authenticated
  using ((user_id = (select auth.uid()) and is_active()) or is_admin());

-- report_files: 직원은 본인 것 올리기·삭제, 날짜 수정은 대표만
drop policy if exists "files_select" on public.report_files;
create policy "files_select" on public.report_files for select to authenticated
  using ((user_id = (select auth.uid()) and is_active()) or is_admin());
drop policy if exists "files_insert" on public.report_files;
create policy "files_insert" on public.report_files for insert to authenticated
  with check (user_id = (select auth.uid()) and is_active()
              and exists (select 1 from public.reports r where r.id = report_id and r.user_id = (select auth.uid())));
drop policy if exists "files_admin_update" on public.report_files;
create policy "files_admin_update" on public.report_files for update to authenticated
  using (is_admin()) with check (is_admin());
drop policy if exists "files_delete" on public.report_files;
create policy "files_delete" on public.report_files for delete to authenticated
  using ((user_id = (select auth.uid()) and is_active()) or is_admin());

-- ---------- 8. 파일 저장소 ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('report-files', 'report-files', false, 52428800)   -- 파일당 50MB
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "rf_insert_own" on storage.objects;
create policy "rf_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'report-files'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.is_active());
drop policy if exists "rf_select" on storage.objects;
create policy "rf_select" on storage.objects for select to authenticated
  using (bucket_id = 'report-files'
         and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));
drop policy if exists "rf_delete" on storage.objects;
create policy "rf_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'report-files'
         and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));


-- ---------- 9. 게시판 ----------
create table if not exists public.posts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  content     text not null default '',
  is_notice   boolean not null default false,        -- 대표만 켤 수 있음 (상단 고정)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.comments (
  id          bigint generated always as identity primary key,
  post_id     bigint not null references public.posts(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists posts_created_idx on public.posts (created_at desc);
create index if not exists posts_user_idx on public.posts (user_id);
create index if not exists comments_post_idx on public.comments (post_id);
create index if not exists comments_user_idx on public.comments (user_id);

create or replace function public.posts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not is_admin() then new.user_id := auth.uid(); new.is_notice := false; new.created_at := now(); end if;
    new.updated_at := now();
  else
    new.user_id := old.user_id;
    if not is_admin() then new.is_notice := old.is_notice; new.created_at := old.created_at; end if;   -- 대표는 쓴 날짜 수정 가능
    if (new.title, new.content) is distinct from (old.title, old.content) then new.updated_at := now(); end if;
  end if;
  return new;
end $$;
drop trigger if exists posts_guard on public.posts;
create trigger posts_guard before insert or update on public.posts for each row execute function public.posts_guard();

create or replace function public.comments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not is_admin() then new.user_id := auth.uid(); new.created_at := now(); end if;
  else
    new.user_id := old.user_id; new.post_id := old.post_id;
    if not is_admin() then new.created_at := old.created_at; end if;   -- 대표는 쓴 날짜 수정 가능
  end if;
  return new;
end $$;
drop trigger if exists comments_guard on public.comments;
create trigger comments_guard before insert or update on public.comments for each row execute function public.comments_guard();
revoke execute on function public.posts_guard(), public.comments_guard() from public, anon, authenticated;

-- 글쓴이 이름 표시용 (승인된 사람만, 이름·구분만 나감)
create or replace function public.staff_directory() returns table (id uuid, name text, role text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.role from profiles p where is_active()
$$;
revoke all on function public.staff_directory() from public, anon;
grant execute on function public.staff_directory() to authenticated;

alter table public.posts enable row level security;
alter table public.comments enable row level security;
grant select, insert, update, delete on public.posts, public.comments to authenticated;
revoke all on public.posts, public.comments from anon;

drop policy if exists "posts_select" on public.posts;
create policy "posts_select" on public.posts for select to authenticated using (is_active());
drop policy if exists "posts_insert" on public.posts;
create policy "posts_insert" on public.posts for insert to authenticated with check ((user_id = (select auth.uid()) and is_active()) or is_admin());
drop policy if exists "posts_update" on public.posts;
create policy "posts_update" on public.posts for update to authenticated
  using ((user_id = (select auth.uid()) and is_active()) or is_admin()) with check ((user_id = (select auth.uid()) and is_active()) or is_admin());
drop policy if exists "posts_delete" on public.posts;
create policy "posts_delete" on public.posts for delete to authenticated using ((user_id = (select auth.uid()) and is_active()) or is_admin());
drop policy if exists "comments_select" on public.comments;
create policy "comments_select" on public.comments for select to authenticated using (is_active());
drop policy if exists "comments_insert" on public.comments;
create policy "comments_insert" on public.comments for insert to authenticated with check ((user_id = (select auth.uid()) and is_active()) or is_admin());
drop policy if exists "comments_update" on public.comments;
create policy "comments_update" on public.comments for update to authenticated using (is_admin()) with check (is_admin());
drop policy if exists "comments_delete" on public.comments;
create policy "comments_delete" on public.comments for delete to authenticated using ((user_id = (select auth.uid()) and is_active()) or is_admin());


-- 게시판 첨부 파일 (글 또는 댓글에 붙음)
create table if not exists public.board_files (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  post_id     bigint references public.posts(id) on delete cascade,
  comment_id  bigint references public.comments(id) on delete cascade,
  name        text not null,
  size        bigint not null default 0,
  path        text not null unique,
  created_at  timestamptz not null default now(),
  check (((post_id is not null)::int + (comment_id is not null)::int) = 1)
);
create index if not exists board_files_post_idx on public.board_files (post_id);
create index if not exists board_files_comment_idx on public.board_files (comment_id);
create or replace function public.board_files_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then new.user_id := auth.uid(); end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists board_files_guard on public.board_files;
create trigger board_files_guard before insert on public.board_files for each row execute function public.board_files_guard();
revoke execute on function public.board_files_guard() from public, anon, authenticated;
alter table public.board_files enable row level security;
grant select, insert, delete on public.board_files to authenticated;
revoke all on public.board_files from anon;
drop policy if exists "bf_select" on public.board_files;
create policy "bf_select" on public.board_files for select to authenticated using (is_active());
drop policy if exists "bf_insert" on public.board_files;
create policy "bf_insert" on public.board_files for insert to authenticated
  with check (is_admin() or (user_id = (select auth.uid()) and is_active() and (
      (post_id is not null and exists (select 1 from public.posts p where p.id = post_id and p.user_id = (select auth.uid())))
   or (comment_id is not null and exists (select 1 from public.comments c where c.id = comment_id and c.user_id = (select auth.uid()))))));
drop policy if exists "bf_delete" on public.board_files;
create policy "bf_delete" on public.board_files for delete to authenticated
  using ((user_id = (select auth.uid()) and is_active()) or is_admin());

-- 게시판 파일 저장소: 승인된 직원은 모두 볼 수 있음, 올리기는 본인 폴더에만
insert into storage.buckets (id, name, public, file_size_limit)
values ('board-files', 'board-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;
drop policy if exists "bf_st_insert" on storage.objects;
create policy "bf_st_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'board-files' and (storage.foldername(name))[1] = (select auth.uid())::text and public.is_active());
drop policy if exists "bf_st_select" on storage.objects;
create policy "bf_st_select" on storage.objects for select to authenticated
  using (bucket_id = 'board-files' and public.is_active());
drop policy if exists "bf_st_delete" on storage.objects;
create policy "bf_st_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'board-files' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));

-- =====================================================================
-- 대표 계정 지정 (사이트에서 대표님이 먼저 회원가입한 뒤 실행)
--   update public.profiles set role = 'admin', approved = true
--   where login_id = '대표님아이디';
-- =====================================================================
