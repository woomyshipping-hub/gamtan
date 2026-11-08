-- 로그인 없이 비밀 주소로 여는 화면(장부 등)의 접근 키. 원문 대신 sha256만 저장한다.
-- 정책 없음 + RLS 켜짐 → API(anon/authenticated)로는 못 읽고 서버 함수(service role)만 읽는다.
create table access_keys (
  name text primary key,              -- 예: 'ledger'
  key_sha256 text not null,
  created_at timestamptz not null default now()
);
alter table access_keys enable row level security;

-- 일용직 이름 중복 입력 방지용 (같은 이름+주민번호 앞자리)
create index day_workers_name_idx on day_workers (name);
