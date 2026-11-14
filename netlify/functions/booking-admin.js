// /api/booking-admin : 예약 관리 (대표용). 장부와 같은 비밀 키.
//   헤더 x-ledger-key: <키>  (access_keys name='ledger'의 sha256과 비교)
//   GET                                   → { config, bookings, deposits }  (지난 30일 이후 예약, 최근 14일 입금 알림)
//   POST { action:"confirm", id }         → 입금 확인 없이 확정 (계좌 이체 외 입금, 문자 누락 등) + 캘린더 등록
//   POST { action:"link", id, deposit_id } → 들어온 입금 알림을 이 예약에 연결해 확정
//   POST { action:"cancel", id }          → 취소 (캘린더 일정 제목에 '취소확인')
//   POST { action:"sync", id }            → 확정됐는데 캘린더 등록이 실패한 예약을 다시 등록
//   PUT  { type:"config", data }          → 견적·예약 설정 저장 (형식이 맞는 값만 저장되고, 저장된 결과를 돌려준다)
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID
const crypto = require("crypto");
const Q = require("../../public/assets/quote.js");
const { makeSupa } = require("../lib/supa");
const { makeCalendar } = require("../lib/gcal");
const B = require("../lib/booking");

const reply = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const uuid = (s) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const strip = ({ token_sha256, ...b }) => b;

function makeHandler({ env = process.env, fetchImpl = fetch, now = () => Date.now(), storeImpl, calendarImpl } = {}) {
  return async (event) => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return reply(503, { error: "not configured" });
    const rest = makeSupa(env, fetchImpl);
    const h = event.headers || {};
    const key = h["x-ledger-key"] || h["X-Ledger-Key"] || "";
    if (!key) return reply(401, { error: "unauthorized" });
    try {
      const rows = await rest("access_keys?name=eq.ledger&select=key_sha256");
      if (!rows.length || !sameHex(sha(key), rows[0].key_sha256)) return reply(401, { error: "unauthorized" });
    } catch (e) { return reply(502, { error: "storage error" }); }

    const store = storeImpl || B.makeStore(rest);
    const t = now();
    const ctx = { store, cal: calendarImpl || (env.GOOGLE_SERVICE_ACCOUNT_JSON ? makeCalendar(env, fetchImpl) : null), now: t };

    try {
      if (event.httpMethod === "GET") {
        await store.expireStale(new Date(t).toISOString());
        const [config, bookings, deposits, used] = await Promise.all([
          store.getConfig(),
          store.listBookings(B.addDays(B.kstDate(t), -30)),
          store.listDeposits(new Date(t - 14 * 864e5).toISOString()),
          store.promoUsed(),
        ]);
        return reply(200, { config, promo: Q.promoState(config, B.kstDate(t), used), bookings: bookings.map(strip), deposits });
      }

      let b;
      try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || ""); } catch (e) { b = null; }
      if (!b || typeof b !== "object") return reply(400, { error: "형식 오류" });

      if (event.httpMethod === "PUT" && b.type === "config") {
        if (!b.data || typeof b.data !== "object") return reply(400, { error: "설정 형식 오류" });
        // 빈 칸·형식이 틀린 값은 지금 저장된 값을 유지한다
        const config = Q.merge(b.data, await store.getConfig());
        await store.saveConfig(config);
        return reply(200, { config });
      }

      if (event.httpMethod !== "POST") return reply(405, { error: "지원하지 않는 요청" });
      if (!uuid(b.id)) return reply(400, { error: "id 필요" });
      if (!ctx.cal) return reply(503, { error: "캘린더 미설정" });
      const bk = await store.byId(b.id);
      if (!bk) return reply(404, { error: "예약 없음" });

      if (b.action === "confirm") {
        const r = await B.confirm(ctx, bk, { by: "manual", force: true });
        if (r.state === "already") return reply(409, { error: "이미 처리된 예약" });
        return reply(200, { booking: strip(r.booking), calendarError: r.calendarError || null });
      }
      if (b.action === "link") {
        if (!uuid(b.deposit_id)) return reply(400, { error: "deposit_id 필요" });
        const dep = await store.depositById(b.deposit_id);
        if (!dep) return reply(404, { error: "입금 알림 없음" });
        if (dep.state === "matched") return reply(409, { error: "이미 다른 예약에 연결된 입금" });
        const r = await B.confirm(ctx, bk, { by: "deposit", amount: dep.amount, paidAt: dep.received_at, force: true });
        if (r.state === "already") return reply(409, { error: "이미 처리된 예약" });
        await store.updateDeposit(dep.id, { state: "matched", booking_id: bk.id, note: "관리 화면에서 연결" });
        return reply(200, { booking: strip(r.booking), calendarError: r.calendarError || null });
      }
      if (b.action === "cancel") {
        const r = await B.cancel(ctx, bk);
        if (r.state === "already") return reply(409, { error: "이미 처리된 예약" });
        return reply(200, { booking: strip(r.booking), calendarError: r.calendarError || null });
      }
      if (b.action === "sync") {
        if (bk.status !== "confirmed") return reply(409, { error: "확정된 예약만 등록" });
        const r = await B.syncCalendar(ctx, bk);
        return reply(r.calendarError ? 502 : 200, { booking: strip(r.booking), calendarError: r.calendarError || null });
      }
      return reply(400, { error: "지원하지 않는 작업" });
    } catch (e) {
      return reply(502, { error: "storage error" });
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
