# 감탄 정산 페이지

크린토피아/홈클린마스터(자체영업) 청소 일정을 구글 캘린더에서 읽어 대표(킴)와 김한준님의 정산액을 계산하는 정적 페이지 + 서버리스 API.
기계용 인수인계: [`handoff.json`](./handoff.json) (규칙·절차·검증의 기준), 기대값 [`fixtures.json`](./fixtures.json), 자동 검증 `node verify.js [--url 배포주소]`. 사람용 설명은 [HANDOFF.md](./HANDOFF.md).

- `public/index.html` : 화면 전체 (달력, 주/월 요약, 일정 상세, 정산 기준 패널). 프레임워크 없음.
- `api/events.js` : 구글 캘린더 → 일정 JSON. 메모의 숫자(추가금·작업인원·정산·한준님 금액)만 내려보냄.
- `api/state.js` : 일정별 직접 입력값과 정산 기준을 Redis에 저장/조회.
- 환경변수: `REDIS_URL`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID` (값은 저장소에 없음)
