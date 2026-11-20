-- AI 비서: 할 일(감탄 업무 / 개인) + 하루 브리핑. 서버 함수(/api/assistant, 장부와 같은 비밀 키)만 쓴다.
-- 자동 할 일(정산 입금 확인·김한준님 지급·카톡 확인 필요)은 auto_key로 한 번만 만들고, 완료 표시는 유지한다.
create table assistant_tasks (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('gamtan', 'personal')),
  title text not null check (char_length(title) between 1 and 200),
  notes text check (char_length(notes) <= 4000),
  due_date date,
  parent_id uuid references assistant_tasks (id) on delete cascade,
  source text not null default 'manual' check (source in ('manual', 'ai', 'auto')),
  auto_key text unique,
  done_at timestamptz,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index assistant_tasks_open_idx on assistant_tasks (scope, due_date) where deleted_at is null;
create index assistant_tasks_parent_idx on assistant_tasks (parent_id);

create table assistant_briefs (
  brief_date date primary key,
  body jsonb not null,
  created_at timestamptz not null default now()
);

alter table assistant_tasks enable row level security;
alter table assistant_briefs enable row level security;
create policy owner_all on assistant_tasks for all to authenticated using (private.is_owner()) with check (private.is_owner());
create policy owner_all on assistant_briefs for all to authenticated using (private.is_owner()) with check (private.is_owner());
