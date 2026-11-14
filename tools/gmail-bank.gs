/**
 * 감탄: 은행 입금 알림 메일 → 감탄 서버(/api/deposit) 전달 → 고객 예약 자동 확정.  (Google Apps Script)
 * 아이폰 단축어가 서버로 바로 보내는 방법(docs/booking.md 1번)이 안 될 때만 쓴다.
 *
 * 흐름: 은행 입금 문자 → 아이폰 자동화가 제목 "감탄입금"으로 이 메일함에 메일 전송 → 이 스크립트(5분마다) → 감탄 서버
 * 설치 (한 번만):
 *   1) https://script.google.com 에서 그 메일함 계정으로 "새 프로젝트" → 이 파일 내용을 붙여넣고 저장
 *   2) ⚙ 프로젝트 설정 → 스크립트 속성: INBOX_TOKEN = (Netlify의 INBOX_TOKEN과 같은 값)
 *   3) 함수 선택에서 setup → ▶ 실행 → 권한 허용 (Gmail 읽기·라벨, 외부 서비스 연결)
 * 처리한 메일에는 "감탄입금처리" 라벨이 붙는다. 다시 보내도 서버가 같은 문자는 한 번만 처리한다.
 */
const DEPOSIT_URL = "https://gamtan-kr.netlify.app/api/deposit";
const LABEL = "감탄입금처리";
const SEARCH = 'subject:감탄입금 newer_than:2d -label:' + LABEL;

function run() {
  const token = PropertiesService.getScriptProperties().getProperty("INBOX_TOKEN");
  if (!token) throw new Error("스크립트 속성 INBOX_TOKEN이 없습니다");
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  for (const th of GmailApp.search(SEARCH, 0, 20)) {
    const msgs = th.getMessages()
      .map((m) => ({ sent_at: m.getDate().toISOString(), text: m.getPlainBody().slice(0, 1900) }))
      .filter((m) => m.text.indexOf("입금") >= 0);
    let ok = true;
    for (let i = 0; i < msgs.length; i += 10) {
      const res = UrlFetchApp.fetch(DEPOSIT_URL, {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + token },
        payload: JSON.stringify({ messages: msgs.slice(i, i + 10) }),
        muteHttpExceptions: true,
      });
      console.log(res.getResponseCode() + " " + res.getContentText().slice(0, 300));
      if (res.getResponseCode() !== 200) ok = false;
    }
    if (ok) th.addLabel(label); // 실패하면 다음 실행에서 다시 보낸다
  }
}

function setup() {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "run") ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger("run").timeBased().everyMinutes(5).create();
  run();
  console.log("설치 완료: 5분마다 입금 알림 메일을 감탄 서버로 보냅니다");
}
