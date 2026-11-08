// /api/ledger : 기본 장부 (수입·지출, 일용직 지급). 로그인 없이 비밀 키로 연다.
//   헤더 x-ledger-key: <키>  (키 원문은 저장하지 않고 access_keys.key_sha256과 비교)
//   GET    ?month=YYYY-MM                      → { month, entries, workers }
//   POST   {type:"entry", entry_date, kind, category, amount, memo?, worker_id?} → { entry }
//   POST   {type:"worker", name, phone?, rrn?} → { worker }   (주민번호는 응답·목록에서 가린 값만)
//   DELETE ?id=<entry id>                      → { ok }
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const crypto = require("crypto");
const { makeSupa } = require("../lib/supa");

const CATEGORIES = { income: ["매출"], expense: ["인건비", "차량", "장비", "세제", "통신비", "기타"] };
const ENTRY_COLS = "id,entry_date,kind,category,amount,memo,worker_id,created_at";
const WORKER_COLS = "id,name,phone,rrn_masked,created_at";

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ymd = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const uuid = (s) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const text = (s, n) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null);

function nextMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// "900101-1234567", "9001011234567" → "900101-1234567". 형식이 아니면 null
function normRrn(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 13 ? `${d.slice(0, 6)}-${d.slice(6)}` : null;
}

function makeHandler({ env = process.env, fetchImpl = fetch } = {}) {
  return async (event) => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return reply(503, { error: "ledger not configured" });
    const rest = makeSupa(env, fetchImpl);
    const h = event.headers || {};
    const key = h["x-ledger-key"] || h["X-Ledger-Key"] || "";
    if (!key) return reply(401, { error: "unauthorized" });
    try {
      const rows = await rest("access_keys?name=eq.ledger&select=key_sha256");
      if (!rows.length || !sameHex(sha(key), rows[0].key_sha256)) return reply(401, { error: "unauthorized" });
    } catch (e) {
      return reply(502, { error: "storage error" });
    }

    const q = event.queryStringParameters || {};
    try {
      if (event.httpMethod === "GET") {
        const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q.month || "") ? q.month : null;
        if (!month) return reply(400, { error: "month=YYYY-MM 필요" });
        const range = `entry_date=gte.${month}-01&entry_date=lt.${nextMonth(month)}-01`;
        const [entries, workers] = await Promise.all([
          rest(`ledger_entries?${range}&select=${ENTRY_COLS}&order=entry_date.asc,created_at.asc`),
          rest(`day_workers_masked?select=${WORKER_COLS}&order=name.asc`),
        ]);
        return reply(200, { month, entries, workers });
      }

      if (event.httpMethod === "DELETE") {
        if (!uuid(q.id)) return reply(400, { error: "id 필요" });
        await rest(`ledger_entries?id=eq.${q.id}`, { method: "DELETE" });
        return reply(200, { ok: true });
      }

      if (event.httpMethod === "POST") {
        let b;
        try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || ""); } catch (e) { b = null; }
        if (!b || typeof b !== "object") return reply(400, { error: "형식 오류" });

        if (b.type === "entry") {
          const kind = b.kind;
          if (!CATEGORIES[kind]) return reply(400, { error: "구분은 수입 또는 지출" });
          if (!CATEGORIES[kind].includes(b.category)) return reply(400, { error: "분류가 구분과 맞지 않음" });
          if (!ymd(b.entry_date)) return reply(400, { error: "날짜 형식 오류" });
          if (!Number.isInteger(b.amount) || b.amount <= 0 || b.amount > 1e9) return reply(400, { error: "금액은 1원 이상 정수" });
          const worker_id = b.worker_id ? (uuid(b.worker_id) ? b.worker_id : undefined) : null;
          if (worker_id === undefined) return reply(400, { error: "일용직 선택 오류" });
          if (worker_id && b.category !== "인건비") return reply(400, { error: "일용직 지급은 인건비만" });
          const [entry] = await rest(`ledger_entries?select=${ENTRY_COLS}`, {
            method: "POST",
            prefer: "return=representation",
            body: { entry_date: b.entry_date, kind, category: b.category, amount: b.amount, memo: text(b.memo, 200), worker_id },
          });
          return reply(201, { entry });
        }

        if (b.type === "worker") {
          const name = text(b.name, 40);
          if (!name) return reply(400, { error: "이름 필요" });
          const rrn = b.rrn ? normRrn(b.rrn) : null;
          if (b.rrn && !rrn) return reply(400, { error: "주민번호는 13자리" });
          const [w] = await rest("day_workers?select=id", { method: "POST", prefer: "return=representation", body: { name, phone: text(b.phone, 20), rrn } });
          const [worker] = await rest(`day_workers_masked?id=eq.${w.id}&select=${WORKER_COLS}`);
          return reply(201, { worker });
        }
        return reply(400, { error: "type은 entry 또는 worker" });
      }
      return reply(405, { error: "method not allowed" });
    } catch (e) {
      return reply(502, { error: "storage error" });
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.normRrn = normRrn;
