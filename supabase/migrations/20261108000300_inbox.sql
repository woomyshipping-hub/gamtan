-- 받은 메시지함: 카톡(데스크톱 Claude 전달) 등에서 들어온 원문과 AI 추출 결과.
-- 대표가 확인한 뒤에만 jobs로 옮긴다 (state='accepted', job_id 연결).
create table inbox_messages (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('kakao', 'sms', 'channel', 'other')),
  chat text,                          -- 채팅방 이름
  sender text,
  sent_at timestamptz,
  text text not null,
  dedupe_key text not null unique,    -- sha256(source|chat|sender|sent_at|text): 같은 메시지를 여러 번 보내도 1건
  state text not null default 'new'
    check (state in ('new', 'draft', 'not_schedule', 'error', 'accepted', 'rejected')),
  parsed jsonb,                       -- AI 추출 결과 (일정 초안)
  error text,
  job_id uuid references jobs (id) on delete set null,
  created_at timestamptz not null default now()
);
create index inbox_state_idx on inbox_messages (state, created_at desc);

alter table inbox_messages enable row level security;
create policy owner_all on inbox_messages for all to authenticated
  using (private.is_owner()) with check (private.is_owner());
