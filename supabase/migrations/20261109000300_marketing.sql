-- 마케팅 기획 관리: 콘텐츠 달력 + 주별·채널별 광고비·문의·수주 (PRD 기능 7·9)
-- 서버 함수(/api/marketing, 장부와 같은 비밀 키)만 쓴다. 로그인 도입 후를 위해 대표 전용 정책도 둔다.
create table marketing_posts (
  id uuid primary key default gen_random_uuid(),
  post_date date not null,
  channel text not null check (channel in ('네이버플레이스', '블로그', '인스타그램', '당근', '숨고', '미소', '카카오채널', '기타')),
  title text not null,
  status text not null default '아이디어' check (status in ('아이디어', '작성중', '예약', '게시')),
  url text,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index marketing_posts_date_idx on marketing_posts (post_date);

create table marketing_stats (
  week_start date not null check (extract(isodow from week_start) = 1),  -- 그 주 월요일
  channel text not null check (channel in ('네이버플레이스', '블로그', '인스타그램', '당근', '숨고', '미소', '카카오채널', '기타')),
  ad_spend integer not null default 0 check (ad_spend >= 0),
  inquiries integer not null default 0 check (inquiries >= 0),
  orders integer not null default 0 check (orders >= 0),
  updated_at timestamptz not null default now(),
  primary key (week_start, channel)
);

alter table marketing_posts enable row level security;
alter table marketing_stats enable row level security;
create policy owner_all on marketing_posts for all to authenticated using (private.is_owner()) with check (private.is_owner());
create policy owner_all on marketing_stats for all to authenticated using (private.is_owner()) with check (private.is_owner());
