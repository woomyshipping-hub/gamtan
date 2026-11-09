-- 서버 함수만 읽는 설정값 (정책 없음 + RLS → API로는 못 읽음). 예: ledger_sheet_id = 개인 가계부 시트 ID
create table app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;
