// node --test tests/*.test.js  (네트워크·API 키 없이 가짜 DB/AI/캘린더로 /api/inbox 흐름 검증)
// 메시지 예시는 실제 카톡 형식을 따르되 주소·연락처는 가린 값이다.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { makeHandler, scheduleEvent } = require("../netlify/functions/inbox");
const { extract, SCHEMA } = require("../netlify/lib/extract");
const { makeCalendar, ampmOf, withExtra } = require("../netlify/lib/gcal");

const ENV = { INBOX_TOKEN: "t0ken", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x", GOOGLE_SERVICE_ACCOUNT_JSON: "{}" };

const SCHEDULE_TEXT = `6일건

주소 : 창원시 마산합포구 OO동 1길 8 300동 000호 OO아파트
(33평)
연락처 : 010-0000-0000
날짜 : 11월 6일
시간 : 오후 1시 또는 1시 반`;
const EXTRA_TEXT = "오후 추가 7만원있습니다";

function fakeDb(clock = () => new Date().toISOString()) {
  const rows = new Map();
  let n = 0;
  const fetchImpl = async (url, opt) => {
    if (opt.method === "POST") {
      const out = [];
      for (const r of JSON.parse(opt.body)) if (!rows.has(r.dedupe_key)) { const row = { id: `id${++n}`, state: "new", created_at: clock(), ...r }; rows.set(r.dedupe_key, row); out.push(row); }
      return { ok: true, json: async () => out };
    }
    if (opt.method === "GET") {
      const q = new URL(url).searchParams;
      const before = q.get("created_at").slice(3);
      const out = [...rows.values()].filter((r) => r.state === "new" && r.created_at < before).slice(0, +q.get("limit"));
      return { ok: true, json: async () => out.map((r) => ({ ...r })) };
    }
    if (opt.method === "PATCH") {
      const id = decodeURIComponent(url.split("id=eq.")[1]);
      for (const r of rows.values()) if (r.id === id) Object.assign(r, JSON.parse(opt.body));
      return { ok: true };
    }
    throw new Error("unexpected " + url);
  };
  return { rows, fetchImpl, byText: (t) => [...rows.values()].find((r) => r.text === t) };
}

function fakeCal(initial = []) {
  const events = [...initial];
  let n = 0;
  return {
    events,
    async ownEventsOn(date) { return events.filter((e) => e.start.dateTime.slice(0, 10) === date && /\[(자체영업|홈클린마스터)\]/.test(e.summary)); },
    async insert(ev) { const e = { id: `ev${++n}`, ...ev }; events.push(e); return e; },
    async patchDescription(id, description) { const e = events.find((x) => x.id === id); e.description = description; return e; },
  };
}

const P_SCHEDULE = { kind: "schedule", work_date: "2026-11-06", ampm: "오후", start_time: "13:00", address: "창원시 마산합포구 OO동 1길 8 300동 000호 OO아파트", region: "창원 마산합포구", area_py: 33, building: "아파트", customer_phone: "010-0000-0000", notes: null, extra_amount: null };
const P_EXTRA = { kind: "extra", work_date: "2026-11-06", ampm: "오후", start_time: null, address: null, region: null, area_py: null, building: null, customer_phone: null, notes: null, extra_amount: 70000 };
const P_OTHER = { kind: "other", work_date: null, ampm: null, start_time: null, address: null, region: null, area_py: null, building: null, customer_phone: null, notes: null, extra_amount: null };
const byText = { [SCHEDULE_TEXT]: P_SCHEDULE, [EXTRA_TEXT]: P_EXTRA };
const fakeExtract = async (msgs) => ({ items: msgs.map((m) => ({ index: m.index, ...(byText[m.text] || P_OTHER) })) });

const ev = (messages, token = "t0ken") => ({ httpMethod: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ source: "kakao", chat: "김동현 홈클린마스터", messages }) });
const msg = (text, at) => ({ sender: "김동현 홈클린마스터", sent_at: at, text });

test("인증·설정·형식 검사", async () => {
  const db = fakeDb();
  const h = makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: fakeExtract, calendarImpl: fakeCal() });
  const ok = [msg(SCHEDULE_TEXT, "2026-11-04T16:11:00+09:00")];
  assert.equal((await h(ev(ok, "wrong"))).statusCode, 401);
  assert.equal((await h({ ...ev(ok), headers: {} })).statusCode, 401);
  assert.equal((await makeHandler({ env: {}, fetchImpl: db.fetchImpl })(ev(ok))).statusCode, 503);
  assert.equal((await h(ev([]))).statusCode, 400);
  assert.equal((await h(ev(Array(6).fill(ok[0])))).statusCode, 400);
  assert.equal((await h({ ...ev(ok), body: "{not json" })).statusCode, 400);
  assert.equal((await h({ httpMethod: "GET", headers: {} })).statusCode, 405);
  assert.equal(db.rows.size, 0);
});

test("새 일정 → 캘린더 등록(정산 페이지 제목 형식), 잡담은 무시, 재전송은 중복 무시", async () => {
  const db = fakeDb(), cal = fakeCal();
  const h = makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: fakeExtract, calendarImpl: cal });
  const batch = [msg("5일 6일 가능,\n7일 토요일은 안되세요?", "2026-11-03T13:17:00+09:00"), msg(SCHEDULE_TEXT, "2026-11-04T16:11:00+09:00")];
  const r = JSON.parse((await h(ev(batch))).body);
  assert.equal(r.created, 1);
  assert.equal(r.ignored, 1);
  assert.equal(cal.events.length, 1);
  const e = cal.events[0];
  assert.equal(e.summary, "[자체영업] 창원 마산합포구 33평 아파트 (오후)");
  assert.equal(e.start.dateTime, "2026-11-06T13:00:00+09:00");
  assert.equal(e.end.dateTime, "2026-11-06T17:00:00+09:00");
  assert.match(e.description, /^주소: 창원시 마산합포구/);
  assert.match(e.description, /구분: 자체영업 \(홈클린마스터\)/);
  assert.equal(db.byText(SCHEDULE_TEXT).state, "created");
  assert.equal(db.byText(SCHEDULE_TEXT).gcal_event_id, e.id);

  const r2 = JSON.parse((await h(ev(batch))).body);
  assert.equal(r2.skipped_duplicates, 2);
  assert.equal(cal.events.length, 1);
});

test("같은 날·시간대에 이미 일정이 있으면 새로 만들지 않음", async () => {
  const db = fakeDb();
  const cal = fakeCal([{ id: "manual1", summary: "[자체영업] 창원 마산합포구 33평 아파트 (오후)", start: { dateTime: "2026-11-06T14:00:00+09:00" }, description: "" }]);
  const r = JSON.parse((await makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: fakeExtract, calendarImpl: cal })(ev([msg(SCHEDULE_TEXT, "2026-11-04T16:11:00+09:00")]))).body);
  assert.equal(r.duplicate, 1);
  assert.equal(cal.events.length, 1);
  assert.equal(db.byText(SCHEDULE_TEXT).gcal_event_id, "manual1");
});

test("추가금 보고 → 그날 그 시간대 일정 메모에 '추가금: 70,000원' (정산 페이지 extraOf로 읽힘)", async () => {
  const { helpers } = require("../api/events.js");
  const db = fakeDb();
  const cal = fakeCal([
    { id: "am", summary: "[자체영업] 창원 회원동 아파트 (오전)", start: { dateTime: "2026-11-06T09:00:00+09:00" }, description: "주소: x" },
    { id: "pm", summary: "[자체영업] 창원 마산합포구 33평 아파트 (오후)", start: { dateTime: "2026-11-06T13:00:00+09:00" }, description: "추가금: 10,000원\n주소: y" },
  ]);
  const r = JSON.parse((await makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: fakeExtract, calendarImpl: cal })(ev([msg(EXTRA_TEXT, "2026-11-06T18:30:00+09:00")]))).body);
  assert.equal(r.extra_applied, 1);
  const pm = cal.events.find((e) => e.id === "pm");
  assert.equal(pm.description, "추가금: 70,000원 (카톡 보고)\n주소: y");
  assert.equal(helpers.extraOf(pm.description), 70000);
  assert.equal(cal.events.find((e) => e.id === "am").description, "주소: x");
});

test("추가금: 해당 일정이 없거나 시간대가 애매하면 unmatched, 캘린더 안 건드림", async () => {
  const db = fakeDb(), cal = fakeCal();
  const r = JSON.parse((await makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: fakeExtract, calendarImpl: cal })(ev([msg(EXTRA_TEXT, "2026-11-06T18:30:00+09:00")]))).body);
  assert.equal(r.unmatched, 1);
  assert.match(db.byText(EXTRA_TEXT).error, /해당 일정 0건/);
});

test("AI 추출 실패 시 원문은 남기고 state=error, 캘린더 안 건드림", async () => {
  const db = fakeDb(), cal = fakeCal();
  const r = JSON.parse((await makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: async () => { throw new Error("boom"); }, calendarImpl: cal })(ev([msg(SCHEDULE_TEXT, null)]))).body);
  assert.equal(r.error, 1);
  assert.equal(db.byText(SCHEDULE_TEXT).state, "error");
  assert.equal(cal.events.length, 0);
});

test("캘린더 오류는 그 메시지만 error로 남김", async () => {
  const db = fakeDb();
  const cal = { ...fakeCal(), ownEventsOn: async () => { throw new Error("google calendar 403"); } };
  const r = JSON.parse((await makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: fakeExtract, calendarImpl: cal })(ev([msg(SCHEDULE_TEXT, null)]))).body);
  assert.equal(r.error, 1);
  assert.match(db.byText(SCHEDULE_TEXT).error, /403/);
});

test("scheduleEvent: 평수·시각 없으면 표시, 기본 시각 오전 09시", () => {
  const { event } = scheduleEvent({ ...P_SCHEDULE, work_date: "2026-11-09", ampm: "오전", start_time: null, area_py: null, region: "창원 회원동" }, { chat: "c", sent_at: null });
  assert.equal(event.summary, "[자체영업] 창원 회원동 아파트 (오전)");
  assert.equal(event.start.dateTime, "2026-11-09T09:00:00+09:00");
  assert.match(event.description, /평수: 확인 필요/);
});

test("ampmOf / withExtra", () => {
  assert.equal(ampmOf({ summary: "x (오후)", start: { dateTime: "2026-11-06T09:00:00+09:00" } }), "오후");
  assert.equal(ampmOf({ summary: "x", start: { dateTime: "2026-11-06T12:59:00+09:00" } }), "오전");
  assert.equal(withExtra("", 0, "검수 완료"), "추가금: 0원 (카톡 보고: 검수 완료)");
});

test("makeCalendar: 서비스 계정 토큰(calendar.events 범위) → 목록·등록·메모 수정 요청", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }), GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" };
  const calls = [];
  const fetchImpl = async (url, opt = {}) => {
    calls.push({ url, opt });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const claim = JSON.parse(Buffer.from(String(opt.body.get("assertion")).split(".")[1], "base64url"));
      assert.equal(claim.scope, "https://www.googleapis.com/auth/calendar.events");
      return { ok: true, json: async () => ({ access_token: "AT" }) };
    }
    if (!opt.method) return { ok: true, json: async () => ({ items: [{ id: "a", summary: "[자체영업] x (오전)", start: { dateTime: "2026-11-06T09:00:00+09:00" } }, { id: "b", summary: "[크린토피아] y", start: { dateTime: "2026-11-06T14:00:00+09:00" } }, { id: "c", status: "cancelled", summary: "[자체영업] z", start: {} }] }) };
    return { ok: true, json: async () => ({ id: "new" }) };
  };
  const cal = makeCalendar(env, fetchImpl);
  assert.deepEqual((await cal.ownEventsOn("2026-11-06")).map((e) => e.id), ["a"]);
  await cal.insert({ summary: "s" });
  await cal.patchDescription("a", "d");
  const api = calls.filter((c) => c.url.includes("/calendar/v3/"));
  assert.match(api[0].url, /calendars\/cal%40group\.calendar\.google\.com\/events\?timeMin=2026-11-06T00%3A00%3A00%2B09%3A00/);
  assert.equal(api[1].opt.method, "POST");
  assert.equal(api[2].opt.method, "PATCH");
  assert.match(api[2].url, /\/events\/a$/);
  assert.ok(api.every((c) => c.opt.headers.Authorization === "Bearer AT"));
  assert.equal(calls.filter((c) => c.url.includes("oauth2")).length, 1); // 토큰은 한 번만
});

test("extract: 요청 형식과 refusal 처리", async () => {
  let req;
  const client = { messages: { create: async (r) => { req = r; return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ items: [] }) }], usage: {} }; } } };
  await extract([{ index: 0, sender: "a", sent_at: "2026-11-08T01:00:00Z", text: "내일 월요일건" }], { client, now: new Date("2026-11-08T01:00:00Z") });
  assert.equal(req.model, "claude-haiku-5-5");
  assert.deepEqual(req.output_config.format, { type: "json_schema", schema: SCHEMA });
  assert.match(req.messages[0].content, /오늘\(한국 시간\): 2026-11-08/);
  assert.match(req.messages[0].content, /2026-11-08 10:00/);
  const refuse = { messages: { create: async () => ({ stop_reason: "refusal", stop_details: null, content: [] }) } };
  await assert.rejects(extract([{ index: 0, text: "x" }], { client: refuse }), /refused/);
});

test("시간이 모자라면 남은 메시지는 new로 두고(deferred), 1분 뒤 다음 호출에서 이어서 처리(resumed)", async () => {
  let clock = "2026-11-08T12:00:00.000Z";
  const db = fakeDb(() => clock), cal = fakeCal();
  const slowCal = { ...cal, insert: async (e) => { await new Promise((r) => setTimeout(r, 30)); return cal.insert(e); } };
  const h1 = makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: fakeExtract, calendarImpl: slowCal, budgetMs: 10, now: () => new Date(clock) });
  const other = msg("네 알겠습니다", "2026-11-04T16:12:00+09:00");
  const r1 = JSON.parse((await h1(ev([msg(SCHEDULE_TEXT, "2026-11-04T16:11:00+09:00"), other]))).body);
  assert.equal(r1.created, 1);
  assert.equal(r1.deferred, 1);
  assert.equal(db.byText("네 알겠습니다").state, "new");

  clock = "2026-11-08T12:02:00.000Z";
  const h2 = makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: fakeExtract, calendarImpl: cal, now: () => new Date(clock) });
  const r2 = JSON.parse((await h2(ev([msg(EXTRA_TEXT, "2026-11-06T18:30:00+09:00")]))).body);
  assert.equal(r2.resumed, 1);
  assert.equal(r2.ignored, 1);
  assert.equal(r2.extra_applied, 1);
  assert.equal(db.byText("네 알겠습니다").state, "ignored");
  assert.equal(cal.events.length, 1);
  assert.match(cal.events[0].description, /^추가금: 70,000원/);
});

test("같은 날짜 캘린더 조회는 요청당 한 번", async () => {
  const db = fakeDb(), cal = fakeCal();
  let lists = 0;
  const counted = { ...cal, ownEventsOn: async (d) => { lists++; return cal.ownEventsOn(d); } };
  const r = JSON.parse((await makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: fakeExtract, calendarImpl: counted })(ev([msg(SCHEDULE_TEXT, "2026-11-04T16:11:00+09:00"), msg(EXTRA_TEXT, "2026-11-06T18:30:00+09:00")]))).body);
  assert.equal(r.created, 1);
  assert.equal(r.extra_applied, 1);
  assert.equal(lists, 1);
  assert.match(cal.events[0].description, /^추가금: 70,000원/);
});

test("'추가 없습니다'(0원)는 이미 있는 추가금을 지우지 않음, 금액 보고는 바꿈", async () => {
  const P0 = { ...P_EXTRA, extra_amount: 0 };
  const zeroExtract = async (msgs) => ({ items: msgs.map((m) => ({ index: m.index, ...(m.text === "오후 추가 없습니다" ? P0 : P_EXTRA) })) });
  const db = fakeDb();
  const cal = fakeCal([{ id: "pm", summary: "[자체영업] x 8평 원룸 (오후)", start: { dateTime: "2026-11-06T14:00:00+09:00" }, description: "추가금: 30,000원 (카톡 보고)\n주소: y" }]);
  const h = makeHandler({ env: ENV, fetchImpl: db.fetchImpl, extractImpl: zeroExtract, calendarImpl: cal });
  await h(ev([msg("오후 추가 없습니다", "2026-11-06T18:00:00+09:00")]));
  assert.match(cal.events[0].description, /^추가금: 30,000원/);
  assert.match(db.byText("오후 추가 없습니다").error, /기존 추가금 유지/);
  await h(ev([msg(EXTRA_TEXT, "2026-11-06T18:30:00+09:00")]));
  assert.match(cal.events[0].description, /^추가금: 70,000원/);
});
