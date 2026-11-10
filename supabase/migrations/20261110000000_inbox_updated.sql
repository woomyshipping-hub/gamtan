-- 크린토피아 주문 변경·취소·2일전 알림으로 기존 일정을 고친 경우 state='updated'
alter table inbox_messages drop constraint inbox_messages_state_check;
alter table inbox_messages add constraint inbox_messages_state_check
  check (state in ('new', 'created', 'updated', 'duplicate', 'extra_applied', 'unmatched', 'ignored', 'error'));
