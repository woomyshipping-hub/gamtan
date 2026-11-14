// /api/booking : 고객 예약 페이지(/reserve/)용. 로그인 없음.
//   GET  ?month=YYYY-MM         → { config, today, first, last, days: { "YYYY-MM-DD": ["오전","오후"] } }  (예약 가능한 날짜만)
//   GET  ?r=<예약번호>&t=<토큰>  → { booking }  (예약 신청 때 받은 토큰으로만 조회)
//   POST { work_date, ampm, name, depositor, phone, region, address, area_py, building, rooms, baths, verandas, memo?, agree:true }
//        → 201 { booking, token }  (견적은 서버가 다시 계산. 입금 계좌는 이 응답과 조회에서만 보인다)
// 고객에게는 캘린더 일정 내용(다른 고객 주소·연락처)을 절대 내려보내지 않는다. 날짜별 열린 시간대만.
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID
const crypto = require("crypto");
const Q = require("../../public/assets/quote.js");
const { makeSupa } = require("../lib/supa");
const { makeCalendar } = require("../lib/gcal");
const B = require("../lib/booking");

const MAX_PENDING = 30; // 동시에 입금 대기 중인 예약 상한 (날짜를 막아 두는 장난 방지)

const reply = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });
const ymd = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const text = (s, min, max) => (typeof s === "string" && s.trim().length >= min ? s.trim().replace(/\s+/g, " ").slice(0, max) : null);
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function phoneOf(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (!/^01[016789]\d{7,8}$/.test(d)) return null;
  return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}
function newCode(workDate) {
  const r = crypto.randomBytes(6);
  return workDate.slice(5).replace("-", "") + "-" + [...r].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
}

// 고객에게 보여 줄 예약 정보
function view(b, cfg) {
  const waiting = b.status === "pending" || b.status === "expired";
  return {
    code: b.code,
    status: b.status === "conflict" ? "checking" : b.status, // conflict는 대표가 확인 중
    work_date: b.work_date, ampm: b.ampm,
    region: b.region, address: b.address, area_py: b.area_py, building: b.building,
    rooms: b.rooms, baths: b.baths, verandas: b.verandas,
    customer_name: b.customer_name, depositor_name: b.depositor_name,
    lines: (b.quote && b.quote.lines) || [], total: b.total, deposit: b.deposit, balance: b.total - b.deposit,
    hold_until: b.hold_until, paid_at: b.paid_at || null,
    promo: b.promo || null,
    account: waiting ? cfg.account : null,
    contact_phone: cfg.contact_phone || null,
  };
}

function parseInput(b, cfg) {
  if (!b || typeof b !== "object") return { error: "형식 오류" };
  if (b.website) return { error: "형식 오류" }; // 사람에게 안 보이는 칸 (자동 입력 차단)
  if (b.agree !== true) return { error: "개인정보 수집·이용에 동의해 주세요" };
  if (!ymd(b.work_date)) return { error: "날짜를 골라 주세요" };
  if (b.ampm !== "오전" && b.ampm !== "오후") return { error: "오전/오후를 골라 주세요" };
  const name = text(b.name, 1, 20);
  if (!name) return { error: "이름을 입력해 주세요" };
  const depositor = text(b.depositor || b.name, 2, 20);
  if (!depositor) return { error: "입금자명을 2글자 이상 입력해 주세요" };
  const phone = phoneOf(b.phone);
  if (!phone) return { error: "휴대폰 번호를 확인해 주세요" };
  const address = text(b.address, 5, 200);
  if (!address) return { error: "주소를 입력해 주세요" };
  const input = { area_py: b.area_py, rooms: b.rooms, baths: b.baths, verandas: b.verandas, region: b.region, building: b.building };
  const q = Q.quote(input, cfg);
  if (!q.ok) return { error: q.reason };
  return {
    row: {
      work_date: b.work_date, ampm: b.ampm, customer_name: name, depositor_name: depositor, phone, address,
      region: b.region, building: b.building, area_py: b.area_py, rooms: b.rooms, baths: b.baths, verandas: b.verandas,
      memo: text(b.memo, 1, 300), quote: { lines: q.lines, per_py: cfg.per_py }, total: q.total, deposit: q.deposit,
    },
  };
}

function makeHandler({ env = process.env, fetchImpl = fetch, now = () => Date.now(), storeImpl, calendarImpl } = {}) {
  return async (event) => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.GOOGLE_SERVICE_ACCOUNT_JSON) return reply(503, { error: "예약 준비 중입니다" });
    const store = storeImpl || B.makeStore(makeSupa(env, fetchImpl));
    const cal = () => calendarImpl || makeCalendar(env, fetchImpl);
    const q = event.queryStringParameters || {};
    const t = now();
    let cfg;
    try { cfg = await store.getConfig(); } catch (e) { return reply(502, { error: "잠시 후 다시 시도해 주세요" }); }

    try {
      if (event.httpMethod === "GET" && q.r) {
        const b = typeof q.r === "string" && /^\d{4}-[A-Z0-9]{6}$/.test(q.r) ? await store.byCode(q.r) : null;
        if (!b || typeof q.t !== "string" || !sameHex(B.sha(q.t), b.token_sha256)) return reply(404, { error: "예약을 찾을 수 없습니다" });
        if (b.status === "pending" && Date.parse(b.hold_until) <= t) b.status = "expired";
        return reply(200, { booking: view(b, cfg) });
      }

      if (event.httpMethod === "GET") {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month || "")) return reply(400, { error: "month=YYYY-MM 필요" });
        const from = `${q.month}-01`;
        const to = B.addDays(B.addDays(from, 31).slice(0, 8) + "01", -1);
        const range = B.bookableRange(cfg, t);
        let days = {};
        if (to >= range.first && from <= range.last) {
          const a = from < range.first ? range.first : from, z = to > range.last ? range.last : to;
          await store.expireStale(new Date(t).toISOString());
          const [events, active] = await Promise.all([cal().eventsBetween(a, z), store.active(a, z)]);
          days = B.availability(cfg, events, active, a, z, t);
        }
        const promo = Q.promoState(cfg, range.today, cfg.promo.enabled && cfg.promo.limit ? await store.promoUsed() : 0);
        return reply(200, { config: Q.publicConfig(cfg), promo, today: range.today, first: range.first, last: range.last, days });
      }

      if (event.httpMethod !== "POST") return reply(405, { error: "지원하지 않는 요청" });
      let body;
      try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || ""); } catch (e) { body = null; }
      const p = parseInput(body, cfg);
      if (p.error) return reply(400, { error: p.error });
      const row = p.row;

      const range = B.bookableRange(cfg, t);
      if (row.work_date < range.first || row.work_date > range.last || cfg.closed_weekdays.includes(new Date(row.work_date + "T00:00:00Z").getUTCDay())) {
        return reply(409, { error: "예약할 수 없는 날짜입니다. 달력에서 다시 골라 주세요" });
      }
      if (!cfg.account.number) return reply(503, { error: "예약 준비 중입니다 (입금 계좌 미설정)" });

      const nowIso = new Date(t).toISOString();
      await store.expireStale(nowIso);
      const pending = await store.pending();
      if (pending.length >= MAX_PENDING) return reply(429, { error: "지금은 예약 신청이 많습니다. 잠시 후 다시 시도해 주세요" });
      if (pending.some((x) => x.phone === row.phone)) return reply(409, { error: "이 연락처로 입금을 기다리는 예약이 이미 있습니다. 그 예약에 입금하시거나 입금 시간이 지난 뒤 다시 신청해 주세요" });
      const dn = row.depositor_name.replace(/\s+/g, "");
      if (pending.some((x) => x.depositor_name.replace(/\s+/g, "") === dn && x.deposit === row.deposit)) {
        return reply(409, { error: `같은 입금자명으로 입금을 기다리는 예약이 있습니다. 입금자명 뒤에 숫자를 붙여 주세요 (예: ${row.depositor_name}${1 + (t % 9)})` });
      }

      row.slot = B.slotFor(cfg, row.ampm);
      const [events, active] = await Promise.all([cal().eventsOn(row.work_date), store.active(row.work_date, row.work_date)]);
      const busy = B.busyMap(events, active);
      if (!B.slotOpen(busy.get(row.work_date), row.slot)) return reply(409, { error: "방금 예약이 찬 날짜입니다. 다른 날짜를 골라 주세요" });

      // 혜택: 신청 순간에 적용되면 예약에 그대로 남긴다 (나중에 혜택을 바꿔도 이 예약은 유지)
      const ps = Q.promoState(cfg, range.today, cfg.promo.enabled && cfg.promo.limit ? await store.promoUsed() : 0);
      row.promo = ps.active ? { title: ps.title, items: ps.items } : null;

      const token = crypto.randomBytes(18).toString("base64url");
      let saved;
      try {
        saved = await store.insert({
          ...row, code: newCode(row.work_date), token_sha256: B.sha(token), status: "pending",
          hold_until: new Date(t + cfg.hold_minutes * 60e3).toISOString(), agreed_at: nowIso,
        });
      } catch (e) {
        if (e.status === 409) return reply(409, { error: "방금 예약이 찬 날짜입니다. 다른 날짜를 골라 주세요" });
        throw e;
      }
      return reply(201, { booking: view(saved, cfg), token });
    } catch (e) {
      return reply(502, { error: "잠시 후 다시 시도해 주세요" });
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.phoneOf = phoneOf;
