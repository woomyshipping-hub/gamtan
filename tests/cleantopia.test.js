// 크린토피아 문자 → 정산 캘린더 (규칙 처리, AI 없음). 형식은 2026-10 캘린더에 남은 실제 원문, 연락처·주소는 가림.
const test = require("node:test");
const assert = require("node:assert");
const { parseCrin, regionOf } = require("../netlify/lib/cleantopia");
const { makeHandler } = require("../netlify/functions/inbox");

const ASSIGN = `[Web발신]
[크린토피아 주문 배정]

관리자가 팀장님께 주문을 배정하였습니다.

○주문번호: 2026110900108
●연락처: 01000000000
●일시: 2026-12-24 / 오후
●주소: 부산 동래구 낙민동 00-0 102동000호
●종류: 이사/입주 청소, 23평, 아파트, 투룸, 반려동물(X)
●포함옵션:
거실 비확장형 베란다, 피톤치드
●특이사항:
[하이마트]
----
<청소팀 페이지>
https://hc-team.cleantopia.com`;
const CHANGE = `[Web발신]
[크린토피아 주문 변경]

기존 배정되었던 이사/입주 청소 주문의 정보가 변경되었습니다.

○주문번호: 2026110900108
●연락처: 01000000000
●일시: 2026-12-26 / 오전
●주소: 부산 동래구 낙민동 00-0 102동000호
●종류: 이사/입주 청소, 23평, 아파트, 투룸, 반려동물(X)
●포함옵션:
거실 비확장형 베란다, 피톤치드, 냉장고 청소(1개)
●특이사항:
[하이마트]`;
const REMIND = `[크린토피아 청소 2일전]
일시: 2026-12-26 / 오전
주소: 부산 동래구 낙민동 00-0 102동000호`;
const CANCEL = `[Web발신]
[크린토피아 주문 취소]
○주문번호: 2026110900108`;

test("parseCrin: 배정 문자 필드", () => {
  const p = parseCrin(ASSIGN);
  assert.equal(p.type, "assign");
  assert.equal(p.order, "2026110900108");
  assert.equal(p.date, "2026-12-24");
  assert.equal(p.ampm, "오후");
  assert.equal(p.py, 23);
  assert.equal(p.building, "아파트");
  assert.equal(p.options, "거실 비확장형 베란다, 피톤치드");
  assert.equal(p.notes, "[하이마트]");
  assert.equal(parseCrin(CHANGE).type, "change");
  assert.equal(parseCrin(REMIND).type, "remind");
  assert.equal(parseCrin(CANCEL).type, "cancel");
  assert.equal(parseCrin("11일건 주소: 창원시 …"), null); // 카톡 일정은 크린토피아 아님
});

test("regionOf: 기존 일정 제목 규칙", () => {
  assert.equal(regionOf("부산 동래구 낙민동 83-1"), "동래구");
  assert.equal(regionOf("경남 창원시 진해구 충장로 575"), "창원 진해구");
  assert.equal(regionOf("경남 양산시 호국학도병길 17"), "양산");
  assert.equal(regionOf("울산 울주군 범서읍 서사리"), "울주군");
  assert.equal(regionOf("경남 김해시 분성로134번길 7"), "김해");
});

function fakeDb() {
  const rows = new Map(); let n = 0;
  const fetchImpl = async (url, opt) => {
    if (opt.method === "POST") { const out = []; for (const r of JSON.parse(opt.body)) if (!rows.has(r.dedupe_key)) { const row = { id: `id${++n}`, state: "new", created_at: new Date().toISOString(), ...r }; rows.set(r.dedupe_key, row); out.push(row); } return { ok: true, json: async () => out }; }
    if (opt.method === "GET") return { ok: true, json: async () => [] };
    if (opt.method === "PATCH") { const id = decodeURIComponent(url.split("id=eq.")[1]); for (const r of rows.values()) if (r.id === id) Object.assign(r, JSON.parse(opt.body)); return { ok: true }; }
    throw new Error("unexpected");
  };
  return { rows, fetchImpl, last: () => [...rows.values()].pop() };
}
function fakeCal(initial = []) {
  const events = [...initial]; let n = 0;
  const day = (e) => (e.start.dateTime || e.start.date).slice(0, 10);
  return {
    events,
    async ownEventsOn(d) { return events.filter((e) => day(e) === d && /\[(자체영업|홈클린마스터)\]/.test(e.summary)); },
    async eventsOn(d) { return events.filter((e) => day(e) === d); },
    async search(t) { return events.filter((e) => JSON.stringify(e).includes(t)); },
    async insert(ev) { const e = { id: `ev${++n}`, ...ev }; events.push(e); return e; },
    async patch(id, body) { const e = events.find((x) => x.id === id); Object.assign(e, body); return e; },
    async patchDescription(id, description) { return this.patch(id, { description }); },
  };
}
const ENV = { INBOX_TOKEN: "t", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x", GOOGLE_SERVICE_ACCOUNT_JSON: "{}" };
const send = (h, text, at) => h({ httpMethod: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ source: "sms", chat: "크린토피아", messages: [{ sender: "크린토피아", sent_at: at, text }] }) }).then((r) => JSON.parse(r.body));
const noAi = async () => { throw new Error("AI가 불리면 안 됨"); };

test("배정 → 일정 생성(정산 제목 규칙), 같은 주문 재배정은 중복", async () => {
  const db = fakeDb(), cal = fakeCal();
  const h = makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: noAi, calendarImpl: cal });
  const r = await send(h, ASSIGN, "2026-11-09T17:51:00+09:00");
  assert.equal(r.created, 1);
  const e = cal.events[0];
  assert.equal(e.summary, "[크린토피아] 동래구 23평 아파트 (오후)");
  assert.equal(e.start.dateTime, "2026-12-24T14:00:00+09:00");
  assert.equal(e.end.dateTime, "2026-12-24T19:00:00+09:00");
  assert.equal(e.location, "부산 동래구 낙민동 00-0 102동000호");
  assert.match(e.description, /주문번호: 2026110900108/);
  assert.match(e.description, /포함옵션: 거실 비확장형 베란다, 피톤치드/);
  const r2 = await send(h, ASSIGN.replace("[Web발신]", "[Web발신] "), "2026-11-10T09:00:00+09:00");
  assert.equal(r2.duplicate, 1);
  assert.equal(cal.events.length, 1);
});

test("손으로 만든 같은 주문 일정이 있으면 새로 만들지 않음", async () => {
  const db = fakeDb();
  const cal = fakeCal([{ id: "m1", summary: "[크린토피아] 동래구 23평 아파트 (오후)", start: { dateTime: "2026-12-24T14:00:00+09:00" }, description: "주문번호: 2026110900108\n연락처: x" }]);
  const r = await send(makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: noAi, calendarImpl: cal }), ASSIGN, "2026-11-09T17:51:00+09:00");
  assert.equal(r.duplicate, 1);
  assert.equal(cal.events.length, 1);
});

test("변경 → 날짜·시간대 이동, 옵션 갱신, 추가금·정산 줄 유지, 변경 이력", async () => {
  const db = fakeDb();
  const cal = fakeCal([{ id: "m1", summary: "[크린토피아] 동래구 23평 아파트 (오후)", location: "부산 동래구", start: { dateTime: "2026-12-24T14:00:00+09:00" }, end: { dateTime: "2026-12-24T19:00:00+09:00" },
    description: "연락처: 01000000000\n추가금: 40,000원\n포함옵션: 거실 비확장형 베란다, 피톤치드\n주문번호: 2026110900108\n---\n[자동 등록] 원문" }]);
  const r = await send(makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: noAi, calendarImpl: cal }), CHANGE, "2026-11-20T10:00:00+09:00");
  assert.equal(r.updated, 1);
  const e = cal.events[0];
  assert.equal(e.summary, "[크린토피아] 동래구 23평 아파트 (오전)");
  assert.equal(e.start.dateTime, "2026-12-26T08:00:00+09:00");
  assert.match(e.description, /추가금: 40,000원/);
  assert.match(e.description, /포함옵션: 거실 비확장형 베란다, 피톤치드, 냉장고 청소\(1개\)/);
  assert.match(e.description, /변경 이력: 2026-12-24 오후 → 2026-12-26 오전 \(11\/20 변경 문자\)\n---/);
  assert.match(e.description, /\[변경 문자 원문 11\/20\]/);
});

test("2일전 → 받은 날 20시 고객 연락 일정 + 본 일정에 수신 표시, 취소 → 제목에 취소확인", async () => {
  const db = fakeDb();
  const cal = fakeCal([{ id: "m1", summary: "[크린토피아] 동래구 23평 아파트 (오전)", location: "부산 동래구 낙민동 00-0 102동000호", start: { dateTime: "2026-12-26T08:00:00+09:00" }, description: "주문번호: 2026110900108\n---\n원문" }]);
  const h = makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: noAi, calendarImpl: cal });
  const r = await send(h, REMIND, "2026-12-24T11:00:00+09:00");
  assert.equal(r.updated, 1);
  const call = cal.events.find((e) => e.summary.startsWith("☎️"));
  assert.equal(call.summary, "☎️ 크린토피아 고객 연락 – 동래구 23평 아파트 (12/26 오전)");
  assert.equal(call.start.dateTime, "2026-12-24T20:00:00+09:00");
  assert.match(cal.events[0].description, /☎️ 2일전 알림 수신\(12\/24\) – 고객 연락 필요\n---/);
  const r2 = await send(h, CANCEL, "2026-12-25T09:00:00+09:00");
  assert.equal(r2.updated, 1);
  assert.equal(cal.events[0].summary, "[크린토피아] 동래구 23평 아파트 (오전) 취소확인");
});

test("크린토피아와 카톡이 한 번에 와도 각각 처리 (크린토피아는 AI 안 씀)", async () => {
  const db = fakeDb(), cal = fakeCal();
  let aiCalls = 0;
  const ai = async (msgs) => { aiCalls++; return { items: msgs.map((m) => ({ index: m.index, kind: "other" })) }; };
  const h = makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: ai, calendarImpl: cal });
  const r = JSON.parse((await h({ httpMethod: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ source: "sms", chat: "크린토피아", messages: [{ sender: "a", sent_at: "2026-11-09T17:51:00+09:00", text: ASSIGN }, { sender: "a", sent_at: "2026-11-09T17:52:00+09:00", text: "광고 문자입니다" }] }) })).body);
  assert.equal(r.created, 1);
  assert.equal(r.ignored, 1);
  assert.equal(aiCalls, 1);
});
