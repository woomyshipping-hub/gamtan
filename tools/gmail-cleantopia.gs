/**
 * 감탄: 크린토피아 문자 메일 → 감탄 서버(/api/inbox) 전달.  (Google Apps Script, endrmsakdmf@gmail.com 계정에서 실행)
 *
 * 흐름: 크린토피아 문자 → 아이폰 자동화가 이 메일함으로 메일 전송 → 이 스크립트(5분마다) → 감탄 서버 → 정산 캘린더
 * 설치 (한 번만):
 *   1) https://script.google.com 에서 endrmsakdmf 계정으로 "새 프로젝트" → 이 파일 내용을 붙여넣고 저장
 *   2) 왼쪽 ⚙ 프로젝트 설정 → 스크립트 속성 → 속성 추가: INBOX_TOKEN = (Netlify의 INBOX_TOKEN과 같은 값)
 *   3) 위쪽 함수 선택에서 setup 을 고르고 ▶ 실행 → 권한 허용 (Gmail 읽기·라벨, 외부 서비스 연결)
 *   4) 실행 로그에 "설치 완료"가 나오면 끝. 이후 5분마다 run 이 자동 실행됨
 * 처리한 메일에는 "감탄처리" 라벨이 붙는다. 다시 보내도 서버가 중복을 무시한다.
 */
const INBOX_URL = "https://gamtan-kr.netlify.app/api/inbox";
const LABEL = "감탄처리";
const SEARCH = '크린토피아 newer_than:3d -label:' + LABEL;

function run() {
  const token = PropertiesService.getScriptProperties().getProperty("INBOX_TOKEN");
  if (!token) throw new Error("스크립트 속성 INBOX_TOKEN이 없습니다");
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const threads = GmailApp.search(SEARCH, 0, 20);
  for (const th of threads) {
    const msgs = th.getMessages()
      .map((m) => ({ sender: "크린토피아", sent_at: m.getDate().toISOString(), text: m.getPlainBody().slice(0, 3900) }))
      .filter((m) => m.text.indexOf("[크린토피아") >= 0); // 문자 원문이 든 메일만
    let ok = true;
    for (let i = 0; i < msgs.length; i += 5) {
      const res = UrlFetchApp.fetch(INBOX_URL, {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + token },
        payload: JSON.stringify({ source: "sms", chat: "크린토피아", messages: msgs.slice(i, i + 5) }),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      console.log(code + " " + res.getContentText().slice(0, 300));
      if (code !== 200) ok = false;
    }
    if (ok) th.addLabel(label); // 실패하면 라벨을 안 붙여 다음 실행에서 다시 보낸다
  }
}

function setup() {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === "run") ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger("run").timeBased().everyMinutes(5).create();
  run();
  console.log("설치 완료: 5분마다 크린토피아 메일을 감탄 서버로 보냅니다");
}
