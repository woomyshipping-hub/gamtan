-- M1 핵심 스키마: 팀, 일정(건) 상태, 상태 이력, 일용직, 장부.
-- 접근: 대표 1인(app_owner에 등록된 구글 이메일)만 RLS로 허용.
-- 외부 팀장님 읽기 전용 정산표는 로그인 없이 서버 함수(service role)가 teams.share_token으로 해당 팀 데이터만 조회한다.

create extension if not exists pgcrypto;

-- 대표 계정 (설치 후 1행 수동 입력: insert into app_owner(email) values ('<대표 구글 이메일>');)
create table app_owner (
  email text primary key
);

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_owner where email = (auth.jwt() ->> 'email'));
$$;

-- 팀: 1팀(대표 + 김한준 팀장님, 고정) / 2팀(외부 팀장님)
create table teams (
  id smallint primary key,
  name text not null,
  kind text not null check (kind in ('internal', 'external')),
  leader_name text,
  calendar_id text,                                        -- 팀별 구글 캘린더 ID
  share_token uuid not null unique default gen_random_uuid(), -- 읽기 전용 정산표 링크용
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into teams (id, name, kind, leader_name) values
  (1, '1팀', 'internal', '김한준'),
  (2, '2팀', 'external', null);

-- 일정 상태: 접수 → 확정 → 완료 → 정산됨
create type job_status as enum ('received', 'confirmed', 'done', 'settled');

create table jobs (
  id uuid primary key default gen_random_uuid(),
  status job_status not null default 'received',
  source text not null check (source in ('kakao', 'cleantopia', 'direct', 'miso', 'soomgo', 'danggn', 'other')),
  source_text text,                 -- 붙여넣은 원문 (AI 해석 근거)
  work_date date not null,
  ampm text check (ampm in ('오전', '오후')),
  address text,
  area_py numeric(5, 1),            -- 평수
  options text[] not null default '{}',
  customer_phone text,
  memo text,
  team_id smallint references teams (id),
  gcal_event_id text,               -- 팀 캘린더에 만든 일정 ID
  recv_amount integer,              -- 정산받을 금액 스냅샷 (규칙 계산은 handoff.json 기준, 여기서 재구현하지 않음)
  team_amount integer,              -- 팀(팀장님) 지급 금액 스냅샷
  confirmed_at timestamptz,
  done_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_work_date_idx on jobs (work_date);
create index jobs_team_date_idx on jobs (team_id, work_date);

create table job_status_log (
  id bigint generated always as identity primary key,
  job_id uuid not null references jobs (id) on delete cascade,
  from_status job_status,
  to_status job_status not null,
  changed_at timestamptz not null default now()
);

-- 상태는 한 칸씩만 앞으로(또는 정정용으로 한 칸 뒤로) 움직인다. 확정부터는 팀 배정 필수.
create or replace function jobs_status_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ord constant job_status[] := array['received', 'confirmed', 'done', 'settled']::job_status[];
  a int; b int;
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    a := array_position(ord, old.status);
    b := array_position(ord, new.status);
    if abs(b - a) <> 1 then
      raise exception 'status % -> % not allowed', old.status, new.status;
    end if;
    if new.status = 'confirmed' and old.status = 'received' then new.confirmed_at := now(); end if;
    if new.status = 'done' and old.status = 'confirmed' then new.done_at := now(); end if;
    if new.status = 'settled' and old.status = 'done' then new.settled_at := now(); end if;
    insert into job_status_log (job_id, from_status, to_status) values (new.id, old.status, new.status);
  end if;
  if new.status <> 'received' and new.team_id is null then
    raise exception 'team required from confirmed';
  end if;
  return new;
end $$;
create trigger jobs_status_guard before insert or update on jobs
  for each row execute function jobs_status_guard();

-- 일용직: 주민등록번호는 화면에서 가리고, 신고 자료 출력 때만 전체 사용 (PRD 기능 8)
create table day_workers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  rrn text,                         -- 전체 값. 화면은 day_workers_masked 뷰만 사용
  created_at timestamptz not null default now()
);
create view day_workers_masked with (security_invoker = true) as
  select id, name, phone,
         case when rrn is null then null else left(rrn, 8) || '******' end as rrn_masked,
         created_at
  from day_workers;

-- 장부: 수입·지출. 일용직 지급은 category='인건비' + worker_id
create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  kind text not null check (kind in ('income', 'expense')),
  category text not null check (category in ('매출', '인건비', '차량', '장비', '세제', '통신비', '기타')),
  amount integer not null check (amount > 0),
  job_id uuid references jobs (id) on delete set null,
  worker_id uuid references day_workers (id) on delete restrict,
  memo text,
  receipt_path text,                -- Supabase Storage 경로 (영수증 사진)
  created_at timestamptz not null default now(),
  check (kind = 'income' or category <> '매출'),
  check (kind = 'expense' or category = '매출')
);
create index ledger_date_idx on ledger_entries (entry_date);

-- RLS: 대표만
alter table app_owner enable row level security;
alter table teams enable row level security;
alter table jobs enable row level security;
alter table job_status_log enable row level security;
alter table day_workers enable row level security;
alter table ledger_entries enable row level security;

create policy owner_read on app_owner for select using (is_owner());
create policy owner_all on teams for all using (is_owner()) with check (is_owner());
create policy owner_all on jobs for all using (is_owner()) with check (is_owner());
create policy owner_read on job_status_log for select using (is_owner());
create policy owner_all on day_workers for all using (is_owner()) with check (is_owner());
create policy owner_all on ledger_entries for all using (is_owner()) with check (is_owner());
