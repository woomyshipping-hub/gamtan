// 고객 예약·입금 자동 확정 검증 (가짜 저장소·캘린더, 네트워크 없음). 입금 문자는 실제 형식을 따르되 값은 지어낸 것.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const Q = require("../public/assets/quote.js");
const bank = require("../netlify/lib/bank");
const B = require("../netlify/lib/booking");
const booking = require("../netlify/functions/booking");
const deposit = require("../netlify/functions/deposit");

const ENV = { INBOX_TOKEN: "t0ken", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x", GOOGLE_SERVICE_ACCOUNT_JSON: "{}" };
const NOW = Date.parse("2026-11-14T10:00:00+09:00");
const CFG = { account: { bank: "테스트은행", number: "000-0000-0000", holder: "감탄" } };

function fakeStore(saved = CFG) {
  const s = { bookings: [], deposits: [], config: saved };
  const active = (b) => b.status === "pending" || b.status === "confirmed";
  const clash = (b, id) => active(b) && s.bookings.some((x) => x.id !== id && active(x) && x.work_date === b.work_date && x.slot === b.slot);
  const e409 = () => Object.assign(new Error("conflict"), { status: 409 });
  return Object.assign(s, {
    getConfig: async () => Q.merge(s.config),
    saveConfig: async (c) => { s.config = c; },
    expireStale: async (iso) => { for (const b of s.bookings) if (b.status === "pending" && b.hold_until < iso) b.status = "expired"; },
    active: async (from, to) => s.bookings.filter((b) => active(b) && b.work_date >= from && b.work_date <= to).map((b) => ({ ...b })),
    pending: async () => s.bookings.filter((b) => b.status === "pending").map((b) => ({ ...b })),
    promoUsed: async () => s.bookings.filter((b) => b.promo && (b.status === "pending" || b.status === "confirmed")).length,
    insert: async (row) => { const b = { id: crypto.randomUUID(), created_at: new Date(NOW).toISOString(), ...row }; if (clash(b)) throw e409(); s.bookings.push(b); return { ...b }; },
    byCode: async (code) => { const b = s.bookings.find((x) => x.code === code); return b ? { ...b } : null; },
    byId: async (id) => { const b = s.bookings.find((x) => x.id === id); return b ? { ...b } : null; },
    candidates: async (since) => s.bookings.filter((b) => (b.status === "pending" || b.status === "expired") && b.hold_until > since).map((b) => ({ ...b })),
    update: async (id, patch, from) => {
      const b = s.bookings.find((x) => x.id === id);
      if (!b || (from && !from.includes(b.status))) return null;
      if (clash({ ...b, ...patch }, id)) throw e409();
      Object.assign(b, patch);
      return { ...b };
    },
    insertDeposit: async (row) => { if (s.deposits.some((d) => d.dedupe_key === row.dedupe_key)) return null; const d = { id: crypto.randomUUID(), ...row }; s.deposits.push(d); return { ...d }; },
    updateDeposit: async (id, patch) => { Object.assign(s.deposits.find((d) => d.id === id), patch); },
    depositById: async (id) => s.deposits.find((d) => d.id === id) || null,
  });
}

function fakeCal(events = []) {
  const c = { events: [...events], inserted: [], patched: [] };
  const on = (d) => c.events.filter((e) => (e.start.dateTime || e.start.date || "").startsWith(d));
  return Object.assign(c, {
    eventsOn: async (d) => on(d),
    eventsBetween: async (a, z) => c.events.filter((e) => { const d = (e.start.dateTime || e.start.date).slice(0, 10); return d >= a && d <= z; }),
    insert: async (ev) => { const e = { id: "ev" + (c.inserted.length + 1), ...ev }; c.inserted.push(e); c.events.push(e); return e; },
    patch: async (id, body) => { c.patched.push({ id, body }); return { id }; },
  });
}
const hh2 = (n) => String(n).padStart(2, "0");
const timed = (summary, date, hh) => ({ summary, start: { dateTime: `${date}T${hh2(hh)}:00:00+09:00` }, end: { dateTime: `${date}T${hh2(hh + 4)}:00:00+09:00` } });

const FORM = { work_date: "2026-11-20", ampm: "오전", name: "홍길동", depositor: "홍길동", phone: "010-1234-5678", region: "창원", address: "창원시 성산구 OO로 1 101동 101호", area_py: 33, building: "아파트", rooms: 3, baths: 2, verandas: 2, agree: true };
const post = (body) => ({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
const get = (qs) => ({ httpMethod: "GET", headers: {}, queryStringParameters: qs });
const J = (r) => JSON.parse(r.body);
const dep = (text, sent_at = "2026-11-14T10:30:00+09:00") => ({ httpMethod: "POST", headers: { authorization: "Bearer t0ken" }, body: JSON.stringify({ messages: [{ text, sent_at }] }) });

function setup({ events = [], config = CFG, now = NOW } = {}) {
  const store = fakeStore(config), cal = fakeCal(events);
  const clock = { t: now };
  const opts = { env: ENV, storeImpl: store, calendarImpl: cal, now: () => clock.t };
  return { store, cal, clock, book: booking.makeHandler(opts), deposit: deposit.makeHandler(opts) };
}

// ---------- 견적 ----------

test("견적: 평수 × 단가 + 초과 방·화장실·베란다 + 출장비, 최소 금액, 올림", () => {
  const c = Q.merge({ per_py: 12000, regions: [{ name: "창원", fee: 0 }, { name: "거제", fee: 30000 }] });
  const a = Q.quote({ area_py: 33, rooms: 3, baths: 2, verandas: 2, region: "창원", building: "아파트" }, c);
  assert.equal(a.total, 396000);
  assert.equal(a.deposit, 50000);
  assert.equal(a.balance, 346000);
  const b = Q.quote({ area_py: 33, rooms: 4, baths: 3, verandas: 3, region: "거제", building: "아파트" }, c);
  assert.equal(b.total, 396000 + 20000 + 30000 + 20000 + 30000);
  assert.deepEqual(b.lines.map((l) => l.amount), [396000, 20000, 30000, 20000, 30000]);
  const small = Q.quote({ area_py: 9, rooms: 1, baths: 1, verandas: 0, region: "창원", building: "오피스텔" }, c);
  assert.equal(small.total, 150000);
  assert.equal(small.lines.at(-1).label, "최소 금액 적용");
  const odd = Q.quote({ area_py: 25, rooms: 3, baths: 2, verandas: 2, region: "창원", building: "아파트" }, Q.merge({ per_py: 12345 }));
  assert.equal(odd.total, 309000); // 308,625 → 1,000원 단위 올림
});

test("견적: 범위 밖 입력은 거절, 40평 넘는 상한은 상담", () => {
  const c = Q.merge({});
  assert.equal(Q.quote({ area_py: 61, rooms: 3, baths: 2, verandas: 2, region: "부산", building: "아파트" }, c).ok, false);
  assert.equal(Q.quote({ area_py: 33.5, rooms: 3, baths: 2, verandas: 2, region: "부산", building: "아파트" }, c).ok, false);
  assert.equal(Q.quote({ area_py: 33, rooms: 0, baths: 2, verandas: 2, region: "부산", building: "아파트" }, c).ok, false);
  assert.equal(Q.quote({ area_py: 33, rooms: 3, baths: 2, verandas: 2, region: "서울", building: "아파트" }, c).ok, false);
});

test("설정 병합: 형식이 틀린 값은 버리고 기본값 유지, 계좌는 고객 설정에서 빠짐", () => {
  const c = Q.merge({ per_py: "13000", deposit: 100000, slot_mode: "ampm", included: { rooms: 2 }, regions: [{ name: "부산", fee: -1 }], account: { bank: "은행", number: "123", holder: "감탄" }, account_match: ["12", "4567"] });
  assert.equal(c.per_py, Q.DEFAULTS.per_py);
  assert.equal(c.deposit, 100000);
  assert.equal(c.slot_mode, "ampm");
  assert.equal(c.included.rooms, 2);
  assert.deepEqual(c.regions, Q.DEFAULTS.regions);
  assert.deepEqual(c.account_match, ["4567"]);
  const p = Q.publicConfig(c);
  assert.equal(p.account, undefined);
  assert.equal(p.account_match, undefined);
});

// ---------- 입금 문자 ----------

test("입금 문자: 은행별 형식에서 금액, 출금·잔액은 무시", () => {
  const cases = [
    ["[KB]11/14 10:30\n123456**789\n홍길동\n입금\n50,000\n잔액1,234,567", 50000],
    ["신한 11/14 10:30 110-***-123456 입금 50,000 잔액 1,234,567 홍길동", 50000],
    ["홍길동님이 50,000원을 입금했어요", 50000],
    ["농협 입금50,000원 11/14 10:30 302-****-1234-11 홍길동 잔액1,234,567원", 50000],
    ["[토스뱅크] 홍길동 → 내 통장 50,000원 입금", 50000],
    ["[우리] 11/14 10:30 1002***123456 입금 100,000원 홍길동7", 100000],
  ];
  for (const [t, amt] of cases) assert.equal(bank.parseDeposit(t)?.amount, amt, t);
  assert.equal(bank.parseDeposit("[KB]11/14 10:30 123456**789 홍길동 출금 50,000 잔액1,000,000"), null);
  assert.equal(bank.parseDeposit("오늘 저녁 7시 회의"), null);
});

test("입금자명: 낱말 단위로 비교 (김민 ≠ 김민수), '님이' 꼬리 제거, 은행이 자른 이름 허용", () => {
  assert.ok(bank.nameIn("홍길동님이 50,000원을 입금했어요", "홍길동"));
  assert.ok(bank.nameIn("[KB]11/14\n홍길동\n입금\n50,000", "홍 길동"));
  assert.ok(!bank.nameIn("[KB]11/14\n김민수\n입금\n50,000", "김민"));
  assert.ok(!bank.nameIn("[우리] 입금 50,000원 홍길동7", "홍길동"));
  assert.ok(bank.nameIn("입금 50,000원 감탄입주청소", "감탄입주청소예약"));
  assert.ok(bank.accountOk("신한 110-***-123456 입금 50,000", ["123456"]));
  assert.ok(!bank.accountOk("신한 110-***-999999 입금 50,000", ["123456"]));
  assert.ok(bank.accountOk("아무 문자", []));
});

// ---------- 빈 날짜 ----------

test("빈 날짜(하루 단위): 정산 캘린더 일정·[휴무]가 있는 날은 마감, 취소확인·태그 없는 일정은 무시", async () => {
  const s = setup({ events: [
    timed("[크린토피아] 북구 34평 아파트 (오후)", "2026-11-17", 14),
    timed("[자체영업] 마산 33평 아파트 (오전)", "2026-11-18", 9),
    timed("[자체영업] 김해 24평 아파트 (오전) 취소확인", "2026-11-19", 9),
    timed("☎️ 고객 연락", "2026-11-20", 11),
    { summary: "[휴무]", start: { date: "2026-11-21" }, end: { date: "2026-11-23" } },
  ] });
  const r = J(await s.book(get({ month: "2026-11" })));
  assert.equal(r.first, "2026-11-16"); // 오늘(11/14) + 2일
  assert.equal(r.config.account, undefined);
  assert.equal(r.days["2026-11-15"], undefined);
  assert.deepEqual(r.days["2026-11-16"], ["오전", "오후"]);
  assert.equal(r.days["2026-11-17"], undefined);
  assert.equal(r.days["2026-11-18"], undefined);
  assert.deepEqual(r.days["2026-11-19"], ["오전", "오후"]);
  assert.deepEqual(r.days["2026-11-20"], ["오전", "오후"]);
  assert.equal(r.days["2026-11-21"], undefined);
  assert.equal(r.days["2026-11-22"], undefined);
  assert.deepEqual(r.days["2026-11-23"], ["오전", "오후"]);
  assert.ok(!JSON.stringify(r).includes("북구")); // 다른 일정 내용은 내려보내지 않음
});

test("빈 날짜(오전·오후 단위 설정): 오후 일정이 있으면 오전만 열림", async () => {
  const s = setup({ config: { ...CFG, slot_mode: "ampm" }, events: [timed("[크린토피아] 북구 34평 아파트 (오후)", "2026-11-17", 14)] });
  const r = J(await s.book(get({ month: "2026-11" })));
  assert.deepEqual(r.days["2026-11-17"], ["오전"]);
});

// ---------- 예약 → 입금 → 확정 ----------

test("예약 신청 → 날짜 막힘 → 입금 문자 → 자동 확정 + 캘린더 등록", async () => {
  const s = setup();
  const a = await s.book(post(FORM));
  assert.equal(a.statusCode, 201, a.body);
  const { booking: bk, token } = J(a);
  assert.equal(bk.status, "pending");
  assert.equal(bk.total, 396000);
  assert.equal(bk.deposit, 50000);
  assert.equal(bk.account.number, "000-0000-0000");
  assert.equal(s.store.bookings[0].slot, "day");
  assert.notEqual(s.store.bookings[0].token_sha256, token);

  // 대기 중인 예약이 날짜를 막는다
  assert.equal(J(await s.book(get({ month: "2026-11" }))).days["2026-11-20"], undefined);
  // 같은 날 다른 사람 신청 → 409
  assert.equal((await s.book(post({ ...FORM, ampm: "오후", name: "김철수", depositor: "김철수", phone: "010-2222-3333" }))).statusCode, 409);

  // 상관없는 입금 → unmatched, 예약은 그대로
  assert.equal(J(await s.deposit(dep("[KB]11/14 10:20\n123456**789\n크린토피아\n입금\n1,200,000\n잔액1,234,567"))).unmatched, 1);
  // 예약금 입금 → 확정
  const d = J(await s.deposit(dep("[KB]11/14 10:30\n123456**789\n홍길동\n입금\n50,000\n잔액1,284,567")));
  assert.equal(d.matched, 1);
  const saved = s.store.bookings[0];
  assert.equal(saved.status, "confirmed");
  assert.equal(saved.paid_amount, 50000);
  assert.equal(saved.confirmed_by, "deposit");
  assert.equal(saved.gcal_event_id, "ev1");
  const ev = s.cal.inserted[0];
  assert.equal(ev.summary, "[감탄예약] 창원 33평 아파트 (오전)");
  assert.equal(ev.start.dateTime, "2026-11-20T09:00:00+09:00");
  assert.match(ev.description, /견적: 396,000원 — 예약금 50,000원 입금 \(11\/14 10:30\), 잔금 346,000원/);
  assert.ok(!/추가금\s*[:：]|정산\s*[:：]/.test(ev.description)); // 정산 페이지가 읽는 줄은 쓰지 않음

  // 같은 문자를 다시 보내도 1번만
  assert.equal(J(await s.deposit(dep("[KB]11/14 10:30\n123456**789\n홍길동\n입금\n50,000\n잔액1,284,567"))).duplicate, 1);
  // 고객 조회: 토큰이 맞아야만, 확정 후에는 계좌를 보이지 않음
  const v = J(await s.book(get({ r: bk.code, t: token })));
  assert.equal(v.booking.status, "confirmed");
  assert.equal(v.booking.account, null);
  assert.equal((await s.book(get({ r: bk.code, t: "x" + token.slice(1) }))).statusCode, 404);
});

test("입금 대기 시간이 지나면 날짜가 다시 열리고, 늦은 입금은 날짜가 비어 있으면 확정·찼으면 conflict", async () => {
  const s = setup();
  J(await s.book(post(FORM)));
  s.clock.t += 121 * 60e3; // 2시간 1분 뒤
  assert.deepEqual(J(await s.book(get({ month: "2026-11" }))).days["2026-11-20"], ["오전", "오후"]);
  assert.equal(s.store.bookings[0].status, "expired");
  // 늦은 입금, 날짜 비어 있음 → 확정
  assert.equal(J(await s.deposit(dep("홍길동님이 50,000원을 입금했어요", "2026-11-14T12:05:00+09:00"))).matched, 1);
  assert.equal(s.store.bookings[0].status, "confirmed");

  const s2 = setup();
  J(await s2.book(post(FORM)));
  s2.clock.t += 121 * 60e3;
  s2.cal.events.push(timed("[크린토피아] 성산구 30평 아파트 (오후)", "2026-11-20", 14)); // 그사이 크린토피아 배정
  const r = J(await s2.deposit(dep("홍길동님이 50,000원을 입금했어요", "2026-11-14T12:05:00+09:00")));
  assert.equal(r.conflict, 1);
  assert.equal(s2.store.bookings[0].status, "conflict");
  assert.equal(s2.store.deposits[0].state, "conflict");
  assert.equal(s2.cal.inserted.length, 0);
});

test("예약 신청 검증: 동의·날짜 범위·같은 연락처·같은 입금자명·계좌 미설정", async () => {
  const s = setup();
  assert.equal((await s.book(post({ ...FORM, agree: false }))).statusCode, 400);
  assert.equal((await s.book(post({ ...FORM, website: "spam" }))).statusCode, 400);
  assert.equal((await s.book(post({ ...FORM, work_date: "2026-11-15" }))).statusCode, 409); // lead_days 2
  assert.equal((await s.book(post({ ...FORM, work_date: "2027-02-01" }))).statusCode, 409); // max_days 60
  assert.equal((await s.book(post({ ...FORM, phone: "02-123-4567" }))).statusCode, 400);
  assert.equal((await s.book(post(FORM))).statusCode, 201);
  assert.equal((await s.book(post({ ...FORM, work_date: "2026-11-21" }))).statusCode, 409); // 같은 연락처 대기 중
  const same = await s.book(post({ ...FORM, work_date: "2026-11-21", phone: "010-9999-8888" }));
  assert.equal(same.statusCode, 409);
  assert.match(J(same).error, /입금자명 뒤에 숫자/);
  assert.equal((await s.book(post({ ...FORM, work_date: "2026-11-21", phone: "010-9999-8888", depositor: "홍길동2" }))).statusCode, 201);

  const noAcct = setup({ config: {} });
  assert.equal((await noAcct.book(post(FORM))).statusCode, 503);
});

test("입금 대조: 계좌 끝자리 불일치는 무시, 입금자·금액이 같은 예약이 둘이면 판단 안 함", async () => {
  const s = setup({ config: { ...CFG, account_match: ["123456"] } });
  J(await s.book(post(FORM)));
  assert.equal(J(await s.deposit(dep("신한 11/14 10:30 110-***-999999 입금 50,000 잔액 1,234,567 홍길동"))).ignored, 1);
  assert.equal(s.store.bookings[0].status, "pending");
  assert.equal(J(await s.deposit(dep("신한 11/14 10:31 110-***-123456 입금 50,000 잔액 1,284,567 홍길동"))).matched, 1);

  const s2 = setup();
  s2.store.bookings.push(
    { id: crypto.randomUUID(), status: "pending", depositor_name: "홍길동", deposit: 50000, total: 300000, hold_until: new Date(NOW + 3600e3).toISOString(), work_date: "2026-11-20", slot: "day" },
    { id: crypto.randomUUID(), status: "pending", depositor_name: "홍길동", deposit: 50000, total: 300000, hold_until: new Date(NOW + 3600e3).toISOString(), work_date: "2026-11-21", slot: "day" },
  );
  assert.equal(J(await s2.deposit(dep("홍길동님이 50,000원을 입금했어요"))).ambiguous, 1);
  assert.ok(s2.store.bookings.every((b) => b.status === "pending"));
});

test("입금 API: 토큰 없으면 401, 단축어가 보낸 맨 텍스트 본문도 받음", async () => {
  const s = setup();
  assert.equal((await s.deposit({ httpMethod: "POST", headers: {}, body: "{}" })).statusCode, 401);
  J(await s.book(post(FORM)));
  const r = await s.deposit({ httpMethod: "POST", headers: { authorization: "Bearer t0ken" }, body: "[KB]11/14 10:30\n123456**789\n홍길동\n입금\n50,000\n잔액1,284,567" });
  assert.equal(J(r).matched, 1);
});

test("취소: 캘린더 일정 제목에 '취소확인' (정산 페이지·빈 날짜 계산에서 빠짐)", async () => {
  const s = setup();
  J(await s.book(post(FORM)));
  await s.deposit(dep("홍길동님이 50,000원을 입금했어요"));
  const b = s.store.bookings[0];
  const r = await B.cancel({ store: s.store, cal: s.cal, now: NOW }, b);
  assert.equal(r.state, "cancelled");
  assert.deepEqual(s.cal.patched[0], { id: "ev1", body: { summary: "[감탄예약] 창원 33평 아파트 (오전) 취소확인" } });
  assert.equal(B.eventSlots({ ...s.cal.inserted[0], summary: s.cal.patched[0].body.summary }).length, 0);
});

test("관리 API: 설정 저장 시 빈 칸·틀린 값은 지금 값 유지, 키 틀리면 401", async () => {
  const admin = require("../netlify/functions/booking-admin");
  const KEY = "k".repeat(40);
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify([{ key_sha256: crypto.createHash("sha256").update(KEY).digest("hex") }]) });
  const store = fakeStore({ ...CFG, per_py: 11000, deposit: 70000 });
  const h = admin.makeHandler({ env: ENV, fetchImpl, storeImpl: store, calendarImpl: fakeCal(), now: () => NOW });
  assert.equal((await h({ httpMethod: "GET", headers: { "x-ledger-key": "x" } })).statusCode, 401);
  const r = await h({ httpMethod: "PUT", headers: { "x-ledger-key": KEY }, body: JSON.stringify({ type: "config", data: { per_py: 13000, deposit: null, included: { rooms: 2 }, account: { bank: "농협" } } }) });
  const c = J(r).config;
  assert.equal(c.per_py, 13000);
  assert.equal(c.deposit, 70000);
  assert.deepEqual(c.included, { rooms: 2, baths: 2, verandas: 2 });
  assert.deepEqual(c.account, { bank: "농협", number: "000-0000-0000", holder: "감탄" });
});

test("혜택: 신청 순간 적용되면 예약·캘린더 메모에 남고, 선착순·마감일이 지나면 빠짐", async () => {
  const promo = { enabled: true, title: "온라인 예약 혜택", until: "2026-12-31", limit: 2, items: [{ name: "피톤치드 연무 시공", value: 50000 }, { name: "7일 무료 재방문", value: 0 }] };
  const s = setup({ config: { ...CFG, promo } });
  const g = J(await s.book(get({ month: "2026-11" })));
  assert.equal(g.promo.active, true);
  assert.equal(g.promo.left, 2);
  assert.equal(g.promo.worth, 50000);
  const a = J(await s.book(post(FORM)));
  assert.deepEqual(a.booking.promo, { title: "온라인 예약 혜택", items: promo.items });
  await s.deposit(dep("홍길동님이 50,000원을 입금했어요"));
  assert.match(s.cal.inserted[0].description, /혜택: 피톤치드 연무 시공, 7일 무료 재방문 \(온라인 예약 혜택\)/);
  assert.equal(J(await s.book(get({ month: "2026-11" }))).promo.left, 1);
  J(await s.book(post({ ...FORM, work_date: "2026-11-21", name: "김철수", depositor: "김철수", phone: "010-2222-3333" })));
  const full = J(await s.book(get({ month: "2026-11" }))).promo;
  assert.equal(full.active, false); // 선착순 2건 끝
  const third = J(await s.book(post({ ...FORM, work_date: "2026-11-23", name: "이영희", depositor: "이영희", phone: "010-4444-5555" })));
  assert.equal(third.booking.promo, null);

  const late = setup({ config: { ...CFG, promo: { ...promo, until: "2026-11-13" } } });
  assert.equal(J(await late.book(get({ month: "2026-11" }))).promo.active, false);
  assert.equal(J(await late.book(post(FORM))).booking.promo, null);
});
