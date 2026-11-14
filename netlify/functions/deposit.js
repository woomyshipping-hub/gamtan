// POST /api/deposit : 은행 입금 알림(문자·푸시) → 예약 자동 확정.
// 보내는 쪽: 아이폰 단축어 자동화(입금 문자 수신 → 바로 POST) 또는 Gmail Apps Script(tools/gmail-bank.gs).
//   Authorization: Bearer <INBOX_TOKEN>   (카톡·크린토피아 /api/inbox와 같은 토큰)
//   { "messages": [{ "sent_at": "ISO 시각(없어도 됨)", "text": "입금 알림 원문" }] }   (한 번에 10건까지)
// 처리: 금액(입금 옆 숫자) + 입금자명(예약 때 받은 이름이 문자에 있는지) + 계좌(설정한 끝자리가 문자에 있는지) 대조
//   → 맞는 예약 1건이면 확정 + 정산 캘린더에 [감탄예약] 일정 등록. 결과는 bank_deposits에 남는다.
// 같은 문자를 여러 번 보내도 1번만 처리한다.
// 환경변수: INBOX_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID
const crypto = require("crypto");
const { makeSupa } = require("../lib/supa");
const { makeCalendar } = require("../lib/gcal");
const B = require("../lib/booking");

const MAX = 10;
const reply = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });
const sameSecret = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function parseBody(event) {
  let raw = event.body || "";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  let b;
  try { b = JSON.parse(raw); } catch (e) {
    // 단축어에서 본문을 그냥 텍스트로 보낸 경우
    return raw.trim() ? [{ text: raw.trim().slice(0, 2000), sent_at: null }] : null;
  }
  const list = Array.isArray(b && b.messages) ? b.messages : b && typeof b.text === "string" ? [b] : null;
  if (!list || !list.length || list.length > MAX) return null;
  const out = [];
  for (const m of list) {
    if (!m || typeof m.text !== "string" || !m.text.trim()) return null;
    out.push({ text: m.text.trim().slice(0, 2000), sent_at: m.sent_at && !isNaN(Date.parse(m.sent_at)) ? m.sent_at : null });
  }
  return out;
}

function makeHandler({ env = process.env, fetchImpl = fetch, now = () => Date.now(), storeImpl, calendarImpl } = {}) {
  return async (event) => {
    if (event.httpMethod !== "POST") return reply(405, { error: "method not allowed" });
    for (const k of ["INBOX_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON"]) if (!env[k]) return reply(503, { error: "deposit not configured" });
    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
    if (!sameSecret(auth, `Bearer ${env.INBOX_TOKEN}`)) return reply(401, { error: "unauthorized" });
    const msgs = parseBody(event);
    if (!msgs) return reply(400, { error: "bad request" });

    const store = storeImpl || B.makeStore(makeSupa(env, fetchImpl));
    const ctx = { store, cal: calendarImpl || makeCalendar(env, fetchImpl), now: now() };
    let cfg;
    try { cfg = await store.getConfig(); } catch (e) { return reply(502, { error: "storage error" }); }

    const result = { received: msgs.length, matched: 0, unmatched: 0, ambiguous: 0, conflict: 0, ignored: 0, duplicate: 0, not_deposit: 0, error: 0 };
    for (const m of msgs) {
      try { result[(await B.processDeposit(ctx, cfg, m)).state]++; }
      catch (e) { result.error++; }
    }
    return reply(200, result);
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
