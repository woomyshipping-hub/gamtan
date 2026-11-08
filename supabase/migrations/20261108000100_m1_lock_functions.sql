-- 보안 점검(0028/0029) 대응: SECURITY DEFINER 함수를 API에 노출되지 않는 private 스키마로 옮긴다.
create schema if not exists private;
grant usage on schema private to anon, authenticated;
alter function public.is_owner() set schema private;
alter function public.jobs_status_guard() set schema private;
revoke execute on function private.jobs_status_guard() from public, anon, authenticated;
revoke execute on function private.is_owner() from public;
grant execute on function private.is_owner() to anon, authenticated;
