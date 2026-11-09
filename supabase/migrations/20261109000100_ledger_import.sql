-- 가계부 시트에서 가져온 기록 표시와 중복 방지
alter table ledger_entries add column source text not null default 'manual' check (source in ('manual', 'sheet'));
alter table ledger_entries add column import_key text unique;
