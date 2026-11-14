-- 고객 예약 (/reserve/ → /api/booking) + 은행 입금 알림 대조 (/api/deposit).
-- 서버 함수(service role)만 쓴다. 로그인 도입 후를 위해 대표 전용 정책도 둔다.
-- 설정(단가·예약금·계좌)은 app_settings key='booking_config' (JSON 문자열).

create table bookings (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                 -- 고객에게 보이는 예약번호 (MMDD-XXXXXX)
  token_sha256 text not null,                -- 고객 조회용 토큰의 sha256 (원문은 고객 링크에만)
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'expired', 'cancelled', 'conflict')),
  work_date date not null,
  ampm text not null check (ampm in ('오전', '오후')),
  slot text not null check (slot in ('day', '오전', '오후')),  -- 차지하는 칸: 하루 전체 또는 시간대
  customer_name text not null,
  depositor_name text not null,
  phone text not null,
  region text not null,
  address text not null,
  area_py smallint not null check (area_py between 1 and 200),
  building text not null,
  rooms smallint not null check (rooms between 0 and 20),
  baths smallint not null check (baths between 0 and 20),
  verandas smallint not null check (verandas between 0 and 20),
  memo text,
  quote jsonb not null,                      -- 신청 시점 견적 내역 (단가가 바뀌어도 이 금액 유지)
  promo jsonb,                               -- 신청 시점에 받은 혜택 {title, items:[{name,value}]} (없으면 null). 선착순 수를 셀 때 쓴다
  total integer not null check (total >= 0),
  deposit integer not null check (deposit >= 0),
  hold_until timestamptz not null,           -- 이때까지 입금이 없으면 expired → 날짜가 다시 열림
  paid_amount integer,
  paid_at timestamptz,
  confirmed_by text check (confirmed_by in ('deposit', 'manual')),
  gcal_event_id text,
  agreed_at timestamptz not null,            -- 개인정보 수집·이용 동의 시각
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 같은 날 같은 칸에는 입금 대기·확정 예약이 하나만 (동시에 신청해도 한 명만 들어감)
create unique index bookings_slot_active on bookings (work_date, slot) where status in ('pending', 'confirmed');
create index bookings_date_idx on bookings (work_date);
create index bookings_status_idx on bookings (status, hold_until);

create table bank_deposits (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,           -- sha256(문자 원문): 같은 알림을 여러 번 보내도 1건
  received_at timestamptz not null,
  text text not null,
  amount integer,
  state text not null default 'unmatched'
    check (state in ('matched', 'unmatched', 'ambiguous', 'conflict', 'ignored')),
  booking_id uuid references bookings (id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index bank_deposits_created_idx on bank_deposits (created_at desc);

alter table bookings enable row level security;
alter table bank_deposits enable row level security;
create policy owner_all on bookings for all to authenticated using (private.is_owner()) with check (private.is_owner());
create policy owner_all on bank_deposits for all to authenticated using (private.is_owner()) with check (private.is_owner());
