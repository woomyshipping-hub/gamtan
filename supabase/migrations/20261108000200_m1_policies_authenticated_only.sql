-- RLS 정책을 로그인 사용자(authenticated)에게만 적용. 익명(anon)은 이메일 클레임과 관계없이 0행.
alter policy owner_read on app_owner to authenticated;
alter policy owner_all on teams to authenticated;
alter policy owner_all on jobs to authenticated;
alter policy owner_read on job_status_log to authenticated;
alter policy owner_all on day_workers to authenticated;
alter policy owner_all on ledger_entries to authenticated;
revoke execute on function private.is_owner() from anon;
