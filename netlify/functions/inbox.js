// POST /api/inbox : 메시지 원문을 받아 저장 → AI로 일정 초안 추출 → 일정이면 텔레그램 알림.
// 보내는 쪽: 데스크톱 Claude(카카오톡 PC 확인), 이후 공기계·카카오톡 채널도 같은 형식.
//   Authorization: Bearer <INBOX_TOKEN>
//   { "source": "kakao", "chat": "채팅방 이름", "messages": [{ "sender": "...", "sent_at": "ISO 시각", "text": "..." }] }
// 응답: { received, new, drafts, skipped_duplicates }
// 환경변수: INBOX_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, (선택) TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
const crypto = require("crypto");
const { extract } = require("../lib/extract");

const MAX_MESSAGES = 20;
const SOURCES = ["kakao", "sms", "channel", "other"];

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

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
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  // 새 비밀 키(sb_secret_…)는 apikey 헤더만. 예전 service_role 키(JWT, eyJ…)는 Authorization도 같이 보낸다.
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
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
    async update(id, patch) {
      const r = await fetchImpl(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify(patch) });
      if (!r.ok) throw new Error(`supabase update ${r.status}`);
    },
  };
}

function draftText(row, p) {
  const lines = [
    "📥 새 일정 초안",
    `${p.work_date || "날짜 ?"} ${p.ampm || ""}`.trim(),
    p.address || "주소 ?",
    [p.area_py ? `${p.area_py}평` : null, p.amount ? `${p.amount.toLocaleString("ko-KR")}원` : null].filter(Boolean).join(" · "),
    p.options && p.options.length ? `옵션: ${p.options.join(", ")}` : null,
    p.notes ? `확인: ${p.notes}` : null,
    `— ${row.chat || row.source} / ${row.sender || ""}`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function telegram(env, fetchImpl, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const r = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
  return r.ok;
}

function makeHandler({ env = process.env, fetchImpl = fetch, extractImpl = extract, now = () => new Date() } = {}) {
  return async (event) => {
    if (event.httpMethod !== "POST") return reply(405, { error: "method not allowed" });
    for (const k of ["INBOX_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!env[k]) return reply(503, { error: "inbox not configured" });
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
      dedupe_key: crypto.createHash("sha256").update([input.source, input.chat, m.sender, m.sent_at, m.text].join("\u0001")).digest("hex"),
    }));
    let inserted;
    try { inserted = await db.insertNew(rows); } catch (e) { return reply(502, { error: "storage error" }); }

    const result = { received: rows.length, new: inserted.length, drafts: 0, skipped_duplicates: rows.length - inserted.length };
    if (inserted.length === 0) return reply(200, result);

    let items;
    try {
      ({ items } = await extractImpl(inserted.map((r, i) => ({ index: i, sender: r.sender, sent_at: r.sent_at, text: r.text })), { now: now() }));
    } catch (e) {
      await Promise.all(inserted.map((r) => db.update(r.id, { state: "error", error: String(e.message).slice(0, 500) }).catch(() => {})));
      return reply(200, { ...result, error: "extract failed" }); // 원문은 저장됨. 나중에 다시 처리 가능
    }

    for (const [i, row] of inserted.entries()) {
      const p = items.find((x) => x.index === i);
      if (!p) { await db.update(row.id, { state: "error", error: "no extract result" }).catch(() => {}); continue; }
      const { index, ...parsed } = p;
      await db.update(row.id, { state: p.is_schedule ? "draft" : "not_schedule", parsed }).catch(() => {});
      if (p.is_schedule) {
        result.drafts++;
        await telegram(env, fetchImpl, draftText(row, parsed)).catch(() => false);
      }
    }
    return reply(200, result);
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
