-- 받은 메시지 처리 결과를 캘린더 자동 반영 기준으로 바꾼다 (텔레그램 알림·수동 확인 단계 제거).
--   created: 캘린더에 새 일정 등록 / duplicate: 같은 날·시간대 일정이 이미 있어 건너뜀
--   extra_applied: 일정 메모에 추가금 반영 / unmatched: 날짜·시간대·일정을 찾지 못함
--   ignored: 일정·추가금이 아닌 메시지 / error: 처리 실패 (원문은 남음)
alter table inbox_messages drop constraint inbox_messages_state_check;
update inbox_messages set state = 'ignored' where state = 'not_schedule';
update inbox_messages set state = 'new' where state in ('draft', 'accepted', 'rejected');
alter table inbox_messages add constraint inbox_messages_state_check
  check (state in ('new', 'created', 'duplicate', 'extra_applied', 'unmatched', 'ignored', 'error'));
alter table inbox_messages add column gcal_event_id text;
