// /api/marketing : 마케팅 기획 관리 (콘텐츠 달력 + 주별·채널별 광고비·문의·수주). 장부와 같은 비밀 키.
//   헤더 x-ledger-key: <키>  (access_keys name='ledger'의 sha256과 비교)
//   GET    ?month=YYYY-MM   → { month, channels, statuses, posts, stats }  (stats: 그 달 달력에 걸친 주들)
//   POST   {type:"post", id?, post_date, channel, title, status, url?, memo?} → { post }  (id 있으면 수정)
//   PUT    {type:"stat", week_start, channel, ad_spend, inquiries, orders} → { stat }
//   DELETE ?id=<post id>    → { ok }
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const crypto = require("crypto");
const { makeSupa } = require("../lib/supa");

const CHANNELS = ["네이버플레이스", "블로그", "인스타그램", "당근", "숨고", "미소", "카카오채널", "기타"];
const STATUSES = ["아이디어", "작성중", "예약", "게시"];
const POST_COLS = "id,post_date,channel,title,status,url,memo,updated_at";
const STAT_COLS = "week_start,channel,ad_spend,inquiries,orders";

const reply = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ymd = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const uuid = (s) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const text = (s, n) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null);
const count = (v) => Number.isInteger(v) && v >= 0 && v <= 1e9;
const isMonday = (s) => new Date(s + "T00:00:00Z").getUTCDay() === 1;

// 그 달 달력(월요일 시작)에 걸친 주의 첫 월요일과 마지막 월요일
function weekRange(month) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), last = new Date(Date.UTC(y, m, 0));
  const mon = (d) => new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400e3);
  return [mon(first).toISOString().slice(0, 10), mon(last).toISOString().slice(0, 10)];
}

function makeHandler({ env = process.env, fetchImpl = fetch } = {}) {
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

    const q = event.queryStringParameters || {};
    try {
      if (event.httpMethod === "GET") {
        const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q.month || "") ? q.month : null;
        if (!month) return reply(400, { error: "month=YYYY-MM 필요" });
        const [w0, w1] = weekRange(month);
        const [y, m] = month.split("-").map(Number);
        const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
        const [posts, stats] = await Promise.all([
          rest(`marketing_posts?post_date=gte.${w0}&post_date=lt.${next}-08&select=${POST_COLS}&order=post_date.asc,created_at.asc`),
          rest(`marketing_stats?week_start=gte.${w0}&week_start=lte.${w1}&select=${STAT_COLS}`),
        ]);
        return reply(200, { month, channels: CHANNELS, statuses: STATUSES, posts, stats });
      }

      if (event.httpMethod === "DELETE") {
        if (!uuid(q.id)) return reply(400, { error: "id 필요" });
        await rest(`marketing_posts?id=eq.${q.id}`, { method: "DELETE" });
        return reply(200, { ok: true });
      }

      let b;
      try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || ""); } catch (e) { b = null; }
      if (!b || typeof b !== "object") return reply(400, { error: "형식 오류" });

      if (event.httpMethod === "POST" && b.type === "post") {
        if (!ymd(b.post_date)) return reply(400, { error: "날짜 형식 오류" });
        if (!CHANNELS.includes(b.channel)) return reply(400, { error: "채널 오류" });
        const status = b.status || "아이디어";
        if (!STATUSES.includes(status)) return reply(400, { error: "상태 오류" });
        const title = text(b.title, 120);
        if (!title) return reply(400, { error: "제목 필요" });
        const url = text(b.url, 500);
        if (url && !/^https?:\/\//.test(url)) return reply(400, { error: "링크는 http(s)로 시작" });
        const row = { post_date: b.post_date, channel: b.channel, title, status, url, memo: text(b.memo, 500), updated_at: new Date().toISOString() };
        if (b.id !== undefined && b.id !== null) {
          if (!uuid(b.id)) return reply(400, { error: "id 오류" });
          const [post] = await rest(`marketing_posts?id=eq.${b.id}&select=${POST_COLS}`, { method: "PATCH", prefer: "return=representation", body: row });
          return post ? reply(200, { post }) : reply(404, { error: "없음" });
        }
        const [post] = await rest(`marketing_posts?select=${POST_COLS}`, { method: "POST", prefer: "return=representation", body: row });
        return reply(201, { post });
      }

      if (event.httpMethod === "PUT" && b.type === "stat") {
        if (!ymd(b.week_start) || !isMonday(b.week_start)) return reply(400, { error: "week_start는 월요일 날짜" });
        if (!CHANNELS.includes(b.channel)) return reply(400, { error: "채널 오류" });
        for (const k of ["ad_spend", "inquiries", "orders"]) if (!count(b[k])) return reply(400, { error: `${k}는 0 이상 정수` });
        const [stat] = await rest(`marketing_stats?on_conflict=week_start,channel&select=${STAT_COLS}`, {
          method: "POST",
          prefer: "resolution=merge-duplicates,return=representation",
          body: { week_start: b.week_start, channel: b.channel, ad_spend: b.ad_spend, inquiries: b.inquiries, orders: b.orders, updated_at: new Date().toISOString() },
        });
        return reply(200, { stat });
      }
      return reply(event.httpMethod === "GET" ? 400 : 405, { error: "지원하지 않는 요청" });
    } catch (e) {
      return reply(502, { error: "storage error" });
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.weekRange = weekRange;
