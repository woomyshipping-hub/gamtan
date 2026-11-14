// 고객 예약: 빈 날짜 계산, 예약 저장, 입금 대조 → 확정 → 정산 캘린더 등록.
// 날짜가 막히는 경우: 정산 캘린더의 [크린토피아]/[자체영업]/[홈클린마스터]/[감탄예약]/[휴무] 일정(제목에 '취소확인'이면 제외)
//                    + 입금을 기다리는(대기 시간 안) 예약 + 확정된 예약.
// 확정된 예약은 캘린더에 "[감탄예약] 지역 N평 건물 (오전|오후)"로 들어간다. 정산 페이지는 이 태그를 읽지 않는다(정산 규칙 미정).
const crypto = require("crypto");
const Q = require("../../public/assets/quote.js");
const { ampmOf } = require("./gcal");
const bank = require("./bank");

const TAG = "[감탄예약]";
const BUSY_TAGS = ["[크린토피아]", "[자체영업]", "[홈클린마스터]", TAG, "[휴무]"];
const DAY = 864e5;
const LATE_GRACE_MS = 24 * 3600e3; // 대기 시간이 지나고 24시간 안에 들어온 입금은 날짜가 비어 있으면 확정
const B_COLS = "*";

const kstDate = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const weekday = (ymd) => new Date(ymd + "T00:00:00Z").getUTCDay();
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const won = (n) => `${(n || 0).toLocaleString("ko-KR")}원`;
const kstText = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(5, 16).replace("-", "/").replace("T", " ");

// ---------- 빈 날짜 ----------

// 캘린더 일정 하나가 막는 날짜·시간대: [{date, slot}] (slot: 'day' | '오전' | '오후')
function eventSlots(ev) {
  const s = ev.summary || "";
  if (!BUSY_TAGS.some((t) => s.includes(t)) || s.includes("취소확인")) return [];
  if (ev.start && ev.start.date) {
    const out = [];
    const end = (ev.end && ev.end.date) || addDays(ev.start.date, 1);
    for (let d = ev.start.date; d < end && out.length < 62; d = addDays(d, 1)) out.push({ date: d, slot: "day" });
    return out;
  }
  const dt = ev.start && ev.start.dateTime;
  if (!dt || isNaN(Date.parse(dt))) return [];
  const date = kstDate(Date.parse(dt));
  if (s.includes("[휴무]")) return [{ date, slot: "day" }];
  const at = { ...ev, start: { dateTime: new Date(Date.parse(dt) + 9 * 3600e3).toISOString().slice(0, 19) + "+09:00" } };
  return [{ date, slot: ampmOf(at) }];
}

// 날짜 → 막힌 시간대 집합
function busyMap(events, bookings) {
  const m = new Map();
  const add = (date, slot) => { if (!m.has(date)) m.set(date, new Set()); m.get(date).add(slot); };
  for (const ev of events) for (const x of eventSlots(ev)) add(x.date, x.slot);
  for (const b of bookings) add(b.work_date, b.slot);
  return m;
}

// 예약이 차지하는 칸: 하루 단위 설정이면 'day', 아니면 오전/오후
const slotFor = (cfg, ampm) => (cfg.slot_mode === "ampm" ? ampm : "day");
// 이 칸이 비었나: 'day'는 그날 아무 일정도 없어야, 오전/오후는 같은 시간대와 하루 전체 일정이 없어야
function slotOpen(set, slot) {
  if (!set || !set.size) return true;
  if (slot === "day") return false;
  return !set.has("day") && !set.has(slot);
}

function bookableRange(cfg, nowMs) {
  const today = kstDate(nowMs);
  return { today, first: addDays(today, cfg.lead_days), last: addDays(today, cfg.max_days) };
}

// from~to 중 예약 가능한 날짜 → 열린 시간대 목록
function availability(cfg, events, bookings, from, to, nowMs) {
  const { first, last } = bookableRange(cfg, nowMs);
  const busy = busyMap(events, bookings);
  const days = {};
  for (let d = from < first ? first : from; d <= to && d <= last; d = addDays(d, 1)) {
    if (cfg.closed_weekdays.includes(weekday(d))) continue;
    const open = ["오전", "오후"].filter((a) => slotOpen(busy.get(d), slotFor(cfg, a)));
    if (open.length) days[d] = open;
  }
  return days;
}

// ---------- 저장소 (Supabase REST) ----------

function makeStore(rest) {
  return {
    async getConfig() {
      const r = await rest("app_settings?key=eq.booking_config&select=value");
      let saved = {};
      try { saved = r && r[0] ? JSON.parse(r[0].value) : {}; } catch (e) { saved = {}; }
      return Q.merge(saved);
    },
    saveConfig: (cfg) => rest("app_settings?on_conflict=key", {
      method: "POST", prefer: "resolution=merge-duplicates",
      body: { key: "booking_config", value: JSON.stringify(cfg), updated_at: new Date().toISOString() },
    }),
    // 대기 시간이 지난 예약은 expired로 (부분 유니크 인덱스에서 빠져 날짜가 다시 열린다)
    expireStale: (nowIso) => rest(`bookings?status=eq.pending&hold_until=lt.${nowIso}`, { method: "PATCH", body: { status: "expired", updated_at: nowIso } }),
    active: (from, to) => rest(`bookings?work_date=gte.${from}&work_date=lte.${to}&status=in.(pending,confirmed)&select=id,work_date,slot,status,hold_until`),
    pending: () => rest("bookings?status=eq.pending&select=id,phone,depositor_name,deposit,hold_until"),
    // 혜택(선착순)을 받은 입금 대기·확정 예약 수
    async promoUsed() { return (await rest("bookings?promo=not.is.null&status=in.(pending,confirmed)&select=id")).length; },
    async insert(row) { const r = await rest(`bookings?select=${B_COLS}`, { method: "POST", prefer: "return=representation", body: row }); return r[0]; },
    async byCode(code) { const r = await rest(`bookings?code=eq.${encodeURIComponent(code)}&select=${B_COLS}`); return r[0] || null; },
    async byId(id) { const r = await rest(`bookings?id=eq.${id}&select=${B_COLS}`); return r[0] || null; },
    // 입금 대조 후보: 입금 대기 + 대기 시간이 지난 지 24시간 안
    candidates: (sinceIso) => rest(`bookings?status=in.(pending,expired)&hold_until=gt.${sinceIso}&select=${B_COLS}`),
    async update(id, patch, fromStatuses) {
      const f = fromStatuses ? `&status=in.(${fromStatuses.join(",")})` : "";
      const r = await rest(`bookings?id=eq.${id}${f}&select=${B_COLS}`, { method: "PATCH", prefer: "return=representation", body: { ...patch, updated_at: new Date().toISOString() } });
      return r[0] || null;
    },
    async insertDeposit(row) {
      const r = await rest("bank_deposits?on_conflict=dedupe_key&select=*", { method: "POST", prefer: "resolution=ignore-duplicates,return=representation", body: [row] });
      return r[0] || null;
    },
    updateDeposit: (id, patch) => rest(`bank_deposits?id=eq.${id}`, { method: "PATCH", body: patch }),
    async depositById(id) { const r = await rest(`bank_deposits?id=eq.${id}&select=*`); return r[0] || null; },
    listBookings: (from) => rest(`bookings?work_date=gte.${from}&select=${B_COLS}&order=work_date.asc,created_at.asc&limit=300`),
    listDeposits: (sinceIso) => rest(`bank_deposits?created_at=gte.${sinceIso}&select=*&order=created_at.desc&limit=100`),
  };
}

// ---------- 캘린더 일정 ----------

function calendarEvent(b) {
  const start = b.ampm === "오전" ? "09:00" : "14:00";
  const t0 = Date.parse(`${b.work_date}T${start}:00+09:00`);
  const iso = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19) + "+09:00";
  const paid = b.paid_amount ? `예약금 ${won(b.paid_amount)} 입금${b.paid_at ? ` (${kstText(Date.parse(b.paid_at))})` : ""}` : "예약금 입금 전 (수동 확정)";
  return {
    summary: `${TAG} ${b.region} ${b.area_py}평 ${b.building} (${b.ampm})`,
    description: [
      `예약번호: ${b.code}`,
      `고객: ${b.customer_name} / ${b.phone}`,
      b.depositor_name !== b.customer_name ? `입금자: ${b.depositor_name}` : null,
      `주소: ${b.address}`,
      `조건: 방 ${b.rooms} · 화장실 ${b.baths} · 베란다 ${b.verandas}`,
      `견적: ${won(b.total)} — ${paid}, 잔금 ${won(Math.max(0, b.total - (b.paid_amount || 0)))}`,
      b.promo && b.promo.items && b.promo.items.length ? `혜택: ${b.promo.items.map((x) => x.name).join(", ")} (${b.promo.title})` : null,
      b.memo ? `요청: ${b.memo}` : null,
      "구분: 감탄 예약 페이지 (직접 영업)",
    ].filter(Boolean).join("\n"),
    start: { dateTime: iso(t0), timeZone: "Asia/Seoul" },
    end: { dateTime: iso(t0 + 4 * 3600e3), timeZone: "Asia/Seoul" },
  };
}

// 확정된 예약을 캘린더에 넣는다 (이미 있으면 그대로). 실패해도 예약은 확정 상태로 남고 관리 화면에서 다시 등록할 수 있다.
async function syncCalendar({ store, cal }, b) {
  if (b.gcal_event_id) return { booking: b };
  try {
    const ev = await cal.insert(calendarEvent(b));
    return { booking: (await store.update(b.id, { gcal_event_id: ev.id })) || { ...b, gcal_event_id: ev.id } };
  } catch (e) {
    return { booking: b, calendarError: String(e.message).slice(0, 200) };
  }
}

// 그 날짜·칸이 지금 비었나 (캘린더 + 다른 예약)
async function slotFreeNow({ store, cal }, b) {
  const [events, active] = await Promise.all([cal.eventsOn(b.work_date), store.active(b.work_date, b.work_date)]);
  const busy = busyMap(events, active.filter((x) => x.id !== b.id));
  return slotOpen(busy.get(b.work_date), b.slot);
}

// 예약 확정. pay: { by: 'deposit'|'manual', amount?, paidAt?, force? }
// → { state: 'confirmed' | 'conflict' | 'already', booking, calendarError? }
async function confirm(ctx, b, pay) {
  const late = b.status === "expired" || b.status === "conflict" || (b.status === "pending" && Date.parse(b.hold_until) <= ctx.now);
  const payPatch = pay.amount ? { paid_amount: pay.amount, paid_at: pay.paidAt || new Date(ctx.now).toISOString() } : {};
  if (late && !pay.force && !(await slotFreeNow(ctx, b))) {
    const row = await ctx.store.update(b.id, { status: "conflict", ...payPatch }, ["pending", "expired"]);
    return { state: "conflict", booking: row || b };
  }
  let row;
  try {
    row = await ctx.store.update(b.id, { status: "confirmed", confirmed_by: pay.by, ...payPatch }, pay.force ? ["pending", "expired", "conflict"] : ["pending", "expired"]);
  } catch (e) {
    if (e.status === 409) { // 같은 칸에 다른 예약이 먼저 확정됨 (부분 유니크 인덱스)
      const c = await ctx.store.update(b.id, { status: "conflict", ...payPatch }, ["pending", "expired"]);
      return { state: "conflict", booking: c || b };
    }
    throw e;
  }
  if (!row) return { state: "already", booking: b };
  return { state: "confirmed", ...(await syncCalendar(ctx, row)) };
}

// ---------- 입금 처리 ----------

// msg: { text, sent_at } → { state: 'matched'|'unmatched'|'ambiguous'|'conflict'|'ignored'|'duplicate'|'not_deposit', code? }
async function processDeposit(ctx, cfg, msg) {
  const text = String(msg.text || "").slice(0, 2000);
  const parsed = bank.parseDeposit(text);
  if (!parsed) return { state: "not_deposit" };
  const receivedMs = msg.sent_at && !isNaN(Date.parse(msg.sent_at)) ? Date.parse(msg.sent_at) : ctx.now;
  const dep = await ctx.store.insertDeposit({
    dedupe_key: sha(text.replace(/\s+/g, " ").trim()),
    received_at: new Date(receivedMs).toISOString(),
    text,
    amount: parsed.amount,
    state: "unmatched",
  });
  if (!dep) return { state: "duplicate" };
  const done = async (state, extra = {}) => { await ctx.store.updateDeposit(dep.id, { state, ...extra }); return { state, ...extra }; };

  if (!bank.accountOk(text, cfg.account_match)) return done("ignored", { note: "계좌 불일치" });
  const cands = await ctx.store.candidates(new Date(ctx.now - LATE_GRACE_MS).toISOString());
  const { booking, ambiguous, count } = bank.pick(text, parsed.amount, cands);
  if (ambiguous) return done("ambiguous", { note: `입금자·금액이 같은 예약 ${count}건` });
  if (!booking) return done("unmatched");
  const r = await confirm(ctx, booking, { by: "deposit", amount: parsed.amount, paidAt: new Date(receivedMs).toISOString() });
  if (r.state === "conflict") return done("conflict", { booking_id: booking.id, note: "입금 전에 날짜가 찼음 (환불 또는 날짜 변경 필요)" });
  if (r.state === "already") return done("unmatched", { note: "이미 처리된 예약" });
  return done("matched", { booking_id: booking.id, ...(r.calendarError ? { note: "캘린더 등록 실패: " + r.calendarError } : {}) });
}

// ---------- 취소 ----------

async function cancel(ctx, b) {
  const row = await ctx.store.update(b.id, { status: "cancelled" }, ["pending", "expired", "confirmed", "conflict"]);
  if (!row) return { state: "already" };
  // 정산 페이지·빈 날짜 계산과 같은 규칙: 제목에 '취소확인'
  if (row.gcal_event_id) {
    try { await ctx.cal.patch(row.gcal_event_id, { summary: `${calendarEvent(row).summary} 취소확인` }); }
    catch (e) { return { state: "cancelled", booking: row, calendarError: String(e.message).slice(0, 200) }; }
  }
  return { state: "cancelled", booking: row };
}

module.exports = {
  TAG, BUSY_TAGS, LATE_GRACE_MS,
  kstDate, addDays, sha,
  eventSlots, busyMap, slotFor, slotOpen, bookableRange, availability,
  makeStore, calendarEvent, syncCalendar, confirm, processDeposit, cancel,
};
