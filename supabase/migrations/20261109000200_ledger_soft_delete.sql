-- 가계부에서 가져온 줄을 장부에서 지우면 표시만 지운다 (다음 동기화 때 다시 생기지 않게)
alter table ledger_entries add column deleted_at timestamptz;
