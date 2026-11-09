/**
 * 크린토피아 주문 배정 문자(메일) → 감탄 캘린더 자동 등록
 *
 * endrmsakdmf@gmail.com 계정의 Google Apps Script(script.google.com)에 붙여넣어 사용한다.
 *  1) 10분마다 "[크린토피아 주문 배정]" 메일을 찾아 감탄 캘린더에 일정을 만든다.
 *     제목: [크린토피아] 동래구 23평 아파트 (오후)   ← 감탄 정산 페이지가 읽는 형식
 *     시간: 오전 08–13시 / 오후 14–19시
 *  2) 작업이 끝나면(종료 시각 이후) "몇 명이서 했는지" 묻는 메일을 나에게 보낸다.
 *     그 메일에 "3" 또는 "3명 추가 50000" 처럼 답장하면 일정 메모에
 *     "작업인원: 3명", "추가금: 50,000원" 줄을 넣는다. (정산 페이지가 이 줄을 읽는다)
 *  3) 형식을 못 읽은 크린토피아 메일(변경/취소 등)은 일정을 만들지 않고
 *     "감탄/확인필요" 라벨을 붙인 뒤 알림 메일을 보낸다.
 */

// ▼ 감탄 정산 페이지가 읽는 캘린더 ID (구글 캘린더 → 설정 → 해당 캘린더 → 캘린더 통합 → 캘린더 ID)
//   이 계정의 기본 캘린더라면 "primary" 그대로 두면 된다.
var CAL_ID = "primary";

var LABEL_DONE = "감탄/등록완료";
var LABEL_CHECK = "감탄/확인필요";
var LABEL_ASK = "감탄/인원질문";
var LABEL_ANSWERED = "감탄/인원반영";
var SLOT = { "오전": ["08:00", "13:00"], "오후": ["14:00", "19:00"] };

/* ───────────── 설치: 처음 한 번만 실행 ───────────── */
function setup() {
  [LABEL_DONE, LABEL_CHECK, LABEL_ASK, LABEL_ANSWERED].forEach(function (n) {
    if (!GmailApp.getUserLabelByName(n)) GmailApp.createLabel(n);
  });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "run") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("run").timeBased().everyMinutes(10).create();
  if (!CalendarApp.getCalendarById(CAL_ID)) throw new Error("캘린더를 찾을 수 없음: " + CAL_ID + " (ID 또는 공유 권한 확인)");
  run();
}

/* ───────────── 10분마다 실행 ───────────── */
function run() {
  importOrders_();
  askCrew_();
  readAnswers_();
}

/* ───────────── 순수 파싱 (테스트 가능) ───────────── */
function parseOrder(text) {
  var t = String(text || "").replace(/\r/g, "");
  if (t.indexOf("크린토피아 주문 배정") < 0) return null;
  var g = function (re) { var m = t.match(re); return m ? m[1].trim() : ""; };
  var order = g(/주문번호\s*[:：]\s*(\d+)/);
  var dm = t.match(/일시\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s*\/\s*(오전|오후)/);
  var addr = g(/주소\s*[:：]\s*([^\n]+)/);
  var kind = g(/종류\s*[:：]\s*([^\n]+)/);
  var py = (kind.match(/(\d+)\s*평/) || [])[1];
  if (!order || !dm || !addr || !py) return null;
  var parts = kind.split(",").map(function (s) { return s.trim(); });
  var type = parts.filter(function (s) { return /아파트|빌라|주택|오피스텔|상가|사무실/.test(s); })[0] || "";
  var gu = (addr.match(/(\S+[구군시])\s/) || [])[1] || "";
  var options = g(/포함옵션\s*[:：]?\s*\n([\s\S]*?)\n\s*●/);
  var note = g(/특이사항\s*[:：]?\s*\n?([\s\S]*?)\n\s*-{3,}/);
  return {
    order: order, date: dm[1], ampm: dm[2], py: +py, gu: gu, type: type,
    addr: addr, kind: kind, phone: g(/연락처\s*[:：]\s*([\d-]+)/), options: options, note: note,
    title: "[크린토피아] " + [gu, py + "평", type].filter(String).join(" ") + " (" + dm[2] + ")"
  };
}

function eventTimes(o) {
  var s = SLOT[o.ampm];
  return { start: new Date(o.date + "T" + s[0] + ":00+09:00"), end: new Date(o.date + "T" + s[1] + ":00+09:00") };
}

function describe(o) {
  return [
    "주문번호: " + o.order,
    "연락처: " + o.phone,
    "주소: " + o.addr,
    "종류: " + o.kind,
    o.options ? "포함옵션: " + o.options.replace(/\n+/g, ", ") : "",
    o.note ? "특이사항: " + o.note.replace(/\n+/g, " ") : ""
  ].filter(String).join("\n");
}

// 답장 "3", "3명", "3명 추가 50000", "2명 추가금 5만", "추가 0" → {crew, extra}
function parseAnswer(text) {
  var first = String(text || "").replace(/\r/g, "").split(/\n\s*\n|\nOn .*wrote:|\n20\d\d.*작성:|\n-+ ?Original/)[0];
  var crew = (first.match(/(?:^|[^\d,])([1-9])\s*(?:명|인)?(?![\d,만])/) || [])[1];
  var em = first.match(/추가\S*\s*[:：]?\s*([\d,.]+)\s*(만)?/);
  var extra = em ? Math.round(parseFloat(em[1].replace(/,/g, "")) * (em[2] ? 10000 : 1)) : null;
  if (!crew && extra == null) return null;
  return { crew: crew ? +crew : null, extra: extra };
}

function setLine(desc, key, value) {
  var line = key + ": " + value, re = new RegExp("^" + key + "\\s*[:：].*$", "m");
  return re.test(desc) ? desc.replace(re, line) : (desc ? desc + "\n" : "") + line;
}

/* ───────────── 1) 메일 → 일정 ───────────── */
function importOrders_() {
  var cal = CalendarApp.getCalendarById(CAL_ID);
  // 같은 제목의 메일은 한 스레드로 묶이므로, 처리 여부는 메일(메시지) ID 단위로 기록한다.
  var seen = JSON.parse(PropertiesService.getScriptProperties().getProperty("seen") || "{}");
  var threads = GmailApp.search('"크린토피아" -subject:"[감탄]" newer_than:14d', 0, 50);
  threads.forEach(function (th) {
    th.getMessages().forEach(function (m) {
      var mid = m.getId();
      if (seen[mid]) return;
      var body = m.getPlainBody();
      if (body.indexOf("크린토피아") < 0) { seen[mid] = Date.now(); return; }
      var o = parseOrder(body);
      if (!o) {
        th.addLabel(label_(LABEL_CHECK));
        notify_("[감탄] 확인 필요: 읽지 못한 크린토피아 메일", "형식을 읽지 못해 일정을 만들지 않았습니다. 변경/취소 문자라면 캘린더에서 직접 고쳐 주세요.\n\n" + body.slice(0, 600) + "\n\n" + th.getPermalink());
      } else {
        var p = props_();
        if (!p[o.order]) {
          var tm = eventTimes(o);
          var dup = cal.getEvents(tm.start, tm.end, { search: o.order })[0];
          var ev = dup || cal.createEvent(o.title, tm.start, tm.end, { description: describe(o), location: o.addr });
          p[o.order] = { id: ev.getId(), end: tm.end.getTime(), title: o.title, date: o.date, ampm: o.ampm };
          saveProps_(p);
        }
        th.addLabel(label_(LABEL_DONE));
      }
      seen[mid] = Date.now();
    });
  });
  var cut = Date.now() - 30 * 864e5;
  Object.keys(seen).forEach(function (k) { if (seen[k] < cut) delete seen[k]; });
  PropertiesService.getScriptProperties().setProperty("seen", JSON.stringify(seen));
}

/* ───────────── 2) 작업 끝난 건 인원 질문 ───────────── */
function askCrew_() {
  var p = props_(), now = Date.now(), changed = false;
  Object.keys(p).forEach(function (order) {
    var x = p[order];
    if (x.asked || x.answered || now < x.end) return;
    var subj = "[감탄] 작업인원 알려주세요 · " + x.date + " " + x.ampm + " " + x.title.replace(/^\[.*?\]\s*/, "") + " #" + order;
    notify_(subj, "이 메일에 답장으로 몇 명이서 했는지 적어 주세요.\n예) 3\n예) 2명 추가 50000   (카톡방에서 확인한 추가금이 있으면 함께)\n\n주문번호: " + order);
    x.asked = now; changed = true;
  });
  if (changed) saveProps_(p);
}

/* ───────────── 3) 답장 읽어 일정 메모에 반영 ───────────── */
function readAnswers_() {
  var cal = CalendarApp.getCalendarById(CAL_ID), p = props_(), changed = false;
  var threads = GmailApp.search('subject:"[감탄] 작업인원 알려주세요" -label:' + q_(LABEL_ANSWERED) + " newer_than:60d", 0, 50);
  threads.forEach(function (th) {
    var msgs = th.getMessages();
    th.addLabel(label_(LABEL_ASK));
    if (msgs.length < 2) return;
    var order = (th.getFirstMessageSubject().match(/#(\d+)/) || [])[1];
    var ans = parseAnswer(msgs[msgs.length - 1].getPlainBody());
    if (!order || !ans || !p[order]) return;
    var ev = cal.getEventById(p[order].id);
    if (!ev) return;
    var d = ev.getDescription() || "";
    if (ans.crew) d = setLine(d, "작업인원", ans.crew + "명");
    if (ans.extra != null) d = setLine(d, "추가금", ans.extra.toLocaleString("ko-KR") + "원");
    ev.setDescription(d);
    th.addLabel(label_(LABEL_ANSWERED));
    th.reply("반영했습니다: " + (ans.crew ? "작업인원 " + ans.crew + "명 " : "") + (ans.extra != null ? "추가금 " + ans.extra.toLocaleString("ko-KR") + "원" : ""));
    p[order].answered = Date.now(); changed = true;
  });
  if (changed) saveProps_(p);
}

/* ───────────── 유틸 ───────────── */
function q_(n) { return '"' + n.replace(/\//g, "-") + '"'; }
function label_(n) { return GmailApp.getUserLabelByName(n) || GmailApp.createLabel(n); }
function notify_(subject, body) { GmailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body); }
function props_() { return JSON.parse(PropertiesService.getScriptProperties().getProperty("orders") || "{}"); }
function saveProps_(p) {
  var cut = Date.now() - 90 * 864e5; // 90일 지난 건 정리
  Object.keys(p).forEach(function (k) { if (p[k].end < cut) delete p[k]; });
  PropertiesService.getScriptProperties().setProperty("orders", JSON.stringify(p));
}
