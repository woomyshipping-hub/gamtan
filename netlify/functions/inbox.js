// POST /api/inbox : 카톡 메시지 원문을 받아 저장 → AI로 일정/추가금 추출 → 구글 캘린더에 자동 반영.
// 보내는 쪽: 데스크톱 Claude가 PC 카카오톡 채팅방을 주기적으로 확인해 새 메시지를 보낸다.
//   Authorization: Bearer <INBOX_TOKEN>
//   { "source": "kakao", "chat": "채팅방 이름", "messages": [{ "sender": "...", "sent_at": "ISO 시각", "text": "..." }] }
// 처리:
//   새 일정  → 그날 같은 시간대에 [자체영업]/[홈클린마스터] 일정이 없으면 캘린더에 등록 (있으면 중복으로 건너뜀)
//   추가금   → 그날 해당 시간대 일정 메모에 "추가금: N원" 줄을 넣거나 바꿈
// 환경변수: INBOX_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID
const crypto = require("crypto");
const { extract } = require("../lib/extract");
const { makeCalendar, ampmOf, withExtra } = require("../lib/gcal");
const { supaHeaders } = require("../lib/supa");
const { extraOf } = require("../../api/events.js").helpers; // 정산 페이지와 같은 "추가금: N원" 해석

const MAX_MESSAGES = 5; // 함수 제한시간(10초) 안에 끝내기 위해 한 번에 5건까지
const BUDGET_MS = 8000; // 이 시간이 지나면 남은 메시지는 state=new로 두고 다음 호출에서 이어서 처리
const RETRY_AFTER_MS = 60000; // 다음 호출에서 이어 받을 미처리(new) 메시지의 최소 경과 시간
const SOURCES = ["kakao", "sms", "channel", "other"];
const TAG = "[자체영업]"; // 기존 캘린더에서 홈클린마스터(김동현 팀장님) 건을 쓰는 태그

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// 같은 메시지 판정: 보낸 날짜(한국)·보낸 사람·내용. 시각(분)은 넣지 않는다 —
// 데스크톱이 화면에서 읽을 때 묶음 메시지 시각을 추정하므로 확인할 때마다 몇 분씩 달라질 수 있다.
const kstDate = (iso) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10) : "");
const dedupeKey = (source, chat, sender, sentAt, text) =>
  crypto.createHash("sha256").update([source, chat, sender, kstDate(sentAt), text].join("\u0001")).digest("hex");

const kstText = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);

function parseBody(event) {
  let raw = event.body || "";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  const b = JSON.parse(raw);
  const source = SOURCES.includes(b.source) ? b.source : null;
  if (!source || !Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_MESSAGES) return null;
  const chat = typeof b.chat === "string" ? b.chat.slice(0, 100) : null;
  const messages = [];
  for (const m of b.messages) {
    if (!m || typeof m.text !== "string" || !m.text.trim() || m.text.length > 4000) return null;
    const sent = m.sent_at && !isNaN(Date.parse(m.sent_at)) ? new Date(m.sent_at).toISOString() : null;
    messages.push({ sender: typeof m.sender === "string" ? m.sender.slice(0, 100) : null, sent_at: sent, text: m.text.trim() });
  }
  return { source, chat, messages };
}

function supabase(env, fetchImpl) {
  const base = env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/inbox_messages";
  const headers = supaHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  return {
    // 중복(dedupe_key)은 무시하고 새로 들어간 행만 돌려받는다
    async insertNew(rows) {
      const r = await fetchImpl(`${base}?on_conflict=dedupe_key`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(rows),
      });
      if (!r.ok) throw new Error(`supabase insert ${r.status}`);
      return r.json();
    },
    // 이전 호출에서 시간이 모자라 처리하지 못한 메시지
    async pending(limit, before) {
      if (limit <= 0) return [];
      const q = new URLSearchParams({ state: "eq.new", created_at: `lt.${before}`, order: "created_at.asc", limit: String(limit), select: "*" });
      const r = await fetchImpl(`${base}?${q}`, { method: "GET", headers });
      if (!r.ok) throw new Error(`supabase select ${r.status}`);
      return r.json();
    },
    async update(id, patch) {
      const r = await fetchImpl(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify(patch) });
      if (!r.ok) throw new Error(`supabase update ${r.status}`);
    },
  };
}

const addHours = (date, hhmm, h) => {
  const t = new Date(`${date}T${hhmm}:00+09:00`).getTime() + h * 3600e3;
  return new Date(t + 9 * 3600e3).toISOString().slice(0, 19) + "+09:00";
};

// 정산 페이지가 읽는 형식: "[자체영업] 창원 마산합포구 33평 아파트 (오후)"
function scheduleEvent(p, row) {
  const ampm = p.ampm || (p.start_time ? (+p.start_time.slice(0, 2) < 13 ? "오전" : "오후") : null);
  const start = /^\d\d:\d\d$/.test(p.start_time || "") ? p.start_time : ampm === "오전" ? "09:00" : "14:00";
  const summary = [TAG, p.region || "지역확인", p.area_py ? `${p.area_py}평` : null, p.building || "아파트", `(${ampm})`].filter(Boolean).join(" ");
  const description = [
    p.address ? `주소: ${p.address}` : null,
    p.customer_phone ? `연락처: ${p.customer_phone}` : null,
    p.area_py ? null : "평수: 확인 필요",
    p.notes ? `참고: ${p.notes}` : null,
    "구분: 자체영업 (홈클린마스터)",
    `자동등록: 카톡 ${row.chat || ""} ${row.sent_at ? kstText(row.sent_at) : ""}`.trim(),
  ].filter(Boolean).join("\n");
  return {
    ampm,
    event: {
      summary,
      description,
      start: { dateTime: `${p.work_date}T${start}:00+09:00`, timeZone: "Asia/Seoul" },
      end: { dateTime: addHours(p.work_date, start, 4), timeZone: "Asia/Seoul" },
    },
  };
}

// 한 요청 안에서 같은 날짜 캘린더 조회는 한 번만 (등록한 일정은 캐시에 더한다)
function cachedCalendar(cal) {
  const days = new Map();
  return {
    async ownEventsOn(date) { if (!days.has(date)) days.set(date, await cal.ownEventsOn(date)); return days.get(date); },
    async insert(event) { const e = await cal.insert(event); const d = event.start.dateTime.slice(0, 10); if (days.has(d)) days.get(d).push({ ...event, ...e }); return e; },
    async patchDescription(id, description) {
      const e = await cal.patchDescription(id, description);
      for (const list of days.values()) for (const x of list) if (x.id === id) x.description = description;
      return e;
    },
  };
}

const squash = (t) => String(t || "").replace(/[\s,.\-()\[\]]/g, "");
function sameJob(ev, p) {
  const desc = squash(ev.description), sum = squash(ev.summary);
  const addr = squash(p.address);
  if (addr.length >= 8 && desc.includes(addr.slice(0, 12))) return true;              // 주소 앞부분이 같음
  if (p.region && p.area_py && sum.includes(squash(p.region)) && sum.includes(`${p.area_py}평`)) return true; // 제목의 지역·평수가 같음
  if (!p.region && !addr) return true;                                               // 정보가 없으면 보수적으로 같은 일로 본다
  return false;
}

async function applySchedule(cal, p, row) {
  if (!p.work_date) return { state: "unmatched", error: "날짜를 찾지 못함" };
  const { ampm, event } = scheduleEvent(p, row);
  if (!ampm) return { state: "unmatched", error: "오전/오후를 찾지 못함" };
  // 같은 날 같은 시간대에 일이 2건일 수 있다(2026-11-06 실제 사례). 같은 일인지는 주소나 지역+평수로 본다.
  const same = (await cal.ownEventsOn(p.work_date)).find((e) => ampmOf(e) === ampm && sameJob(e, p));
  if (same) return { state: "duplicate", gcal_event_id: same.id };
  const created = await cal.insert(event);
  return { state: "created", gcal_event_id: created.id };
}

async function applyExtra(cal, p) {
  if (!p.work_date || !Number.isInteger(p.extra_amount) || p.extra_amount < 0) return { state: "unmatched", error: "날짜 또는 금액을 찾지 못함" };
  const events = await cal.ownEventsOn(p.work_date);
  const hits = p.ampm ? events.filter((e) => ampmOf(e) === p.ampm) : events;
  if (hits.length !== 1) return { state: "unmatched", error: `해당 일정 ${hits.length}건 (${p.work_date} ${p.ampm || "시간대 없음"})` };
  // "추가 없습니다"(0원)는 미리 확정된 추가금(예: 팀장님 "추가3만원 확정")을 지우지 않는다
  if (p.extra_amount === 0 && extraOf(hits[0].description) > 0) return { state: "extra_applied", gcal_event_id: hits[0].id, error: "기존 추가금 유지 (0원 보고)" };
  await cal.patchDescription(hits[0].id, withExtra(hits[0].description, p.extra_amount, p.notes));
  return { state: "extra_applied", gcal_event_id: hits[0].id };
}

function makeHandler({ env = process.env, fetchImpl = fetch, extractImpl = extract, now = () => new Date(), calendarImpl, budgetMs = BUDGET_MS } = {}) {
  return async (event) => {
    if (event.httpMethod !== "POST") return reply(405, { error: "method not allowed" });
    for (const k of ["INBOX_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON"]) if (!env[k]) return reply(503, { error: "inbox not configured" });
    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
    if (!sameSecret(auth, `Bearer ${env.INBOX_TOKEN}`)) return reply(401, { error: "unauthorized" });

    let input;
    try { input = parseBody(event); } catch (e) { input = null; }
    if (!input) return reply(400, { error: "bad request" });

    const db = supabase(env, fetchImpl);
    const rows = input.messages.map((m) => ({
      source: input.source,
      chat: input.chat,
      sender: m.sender,
      sent_at: m.sent_at,
      text: m.text,
      dedupe_key: dedupeKey(input.source, input.chat, m.sender, m.sent_at, m.text),
    }));
    let inserted;
    try { inserted = await db.insertNew(rows); } catch (e) { return reply(502, { error: "storage error" }); }

    const started = Date.now();
    const result = { received: rows.length, new: inserted.length, skipped_duplicates: rows.length - inserted.length, resumed: 0, created: 0, duplicate: 0, extra_applied: 0, unmatched: 0, ignored: 0, error: 0, deferred: 0 };
    let leftovers = [];
    try { leftovers = await db.pending(MAX_MESSAGES - inserted.length, new Date(now().getTime() - RETRY_AFTER_MS).toISOString()); } catch (e) { leftovers = []; }
    leftovers = leftovers.filter((l) => !inserted.some((r) => r.id === l.id));
    result.resumed = leftovers.length;
    inserted = [...leftovers, ...inserted];
    if (inserted.length === 0) return reply(200, result);

    let items;
    try {
      ({ items } = await extractImpl(inserted.map((r, i) => ({ index: i, sender: r.sender, sent_at: r.sent_at, text: r.text })), { now: now() }));
    } catch (e) {
      await Promise.all(inserted.map((r) => db.update(r.id, { state: "error", error: String(e.message).slice(0, 500) }).catch(() => {})));
      result.error = inserted.length;
      return reply(200, result); // 원문은 저장됨. 나중에 다시 처리 가능
    }

    const cal = cachedCalendar(calendarImpl || makeCalendar(env, fetchImpl));
    const writes = [];
    for (const [i, row] of inserted.entries()) {
      if (Date.now() - started > budgetMs) { result.deferred++; continue; } // state=new 그대로 → 다음 호출에서 처리
      const p = items.find((x) => x.index === i);
      let out;
      try {
        if (!p) out = { state: "error", error: "추출 결과 없음" };
        else if (p.kind === "schedule") out = await applySchedule(cal, p, row);
        else if (p.kind === "extra") out = await applyExtra(cal, { ...p, work_date: p.work_date || kstDate(row.sent_at) || null }); // 날짜가 없으면 보낸 날
        else out = { state: "ignored" };
      } catch (e) {
        out = { state: "error", error: String(e.message).slice(0, 500) };
      }
      result[out.state]++;
      const parsed = p ? (({ index, ...rest }) => rest)(p) : null;
      writes.push(db.update(row.id, { ...out, parsed }).catch(() => {}));
    }
    await Promise.all(writes);
    return reply(200, result);
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.scheduleEvent = scheduleEvent;
exports.dedupeKey = dedupeKey;
