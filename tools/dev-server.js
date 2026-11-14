// 로컬 확인용 서버 (배포 없이 화면 확인): node tools/dev-server.js → http://localhost:8787
// 같은 와이파이의 휴대폰에서도 열린다: 시작할 때 찍히는 http://<이 컴퓨터 내부 IP>:8787 주소를 쓴다.
// public/ 정적 파일 + /api/booking, /api/booking-admin, /api/deposit 를 가짜 저장소·가짜 캘린더로 실행한다 (Supabase·구글·Netlify 안 씀).
//   /reserve/                고객 예약 페이지
//   /bookings/#k=kkkk…(40자)  관리 화면 (아래 DEV_KEY)
//   /__dev                   입금 문자 흉내 내기, 데이터 초기화
// 서버를 끄면 데이터는 사라진다.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const Q = require(ROOT + "/public/assets/quote.js");
const NOW = Date.now();
const PORT = +process.env.PORT || 8787;
const s = { bookings: [], deposits: [], config: { account: { bank: "테스트은행", number: "000-0000-0000", holder: "감탄" } } };
const act = (b) => b.status === "pending" || b.status === "confirmed";
const clash = (b, id) => act(b) && s.bookings.some((x) => x.id !== id && act(x) && x.work_date === b.work_date && x.slot === b.slot);
const store = {
  getConfig: async () => Q.merge(s.config), saveConfig: async (c) => { s.config = c; },
  expireStale: async (iso) => { for (const b of s.bookings) if (b.status === "pending" && b.hold_until < iso) b.status = "expired"; },
  active: async (f, t) => s.bookings.filter((b) => act(b) && b.work_date >= f && b.work_date <= t),
  pending: async () => s.bookings.filter((b) => b.status === "pending"),
  promoUsed: async () => s.bookings.filter((b) => b.promo && (b.status === "pending" || b.status === "confirmed")).length,
  insert: async (row) => { const b = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row }; if (clash(b)) throw Object.assign(new Error(), { status: 409 }); s.bookings.push(b); return { ...b }; },
  byCode: async (c) => s.bookings.find((x) => x.code === c) || null, byId: async (id) => s.bookings.find((x) => x.id === id) || null,
  candidates: async (since) => s.bookings.filter((b) => (b.status === "pending" || b.status === "expired") && b.hold_until > since),
  update: async (id, p, from) => { const b = s.bookings.find((x) => x.id === id); if (!b || (from && !from.includes(b.status))) return null; Object.assign(b, p); return { ...b }; },
  insertDeposit: async (row) => { if (s.deposits.some((d) => d.dedupe_key === row.dedupe_key)) return null; const d = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row }; s.deposits.push(d); return d; },
  updateDeposit: async (id, p) => Object.assign(s.deposits.find((d) => d.id === id), p),
  depositById: async (id) => s.deposits.find((d) => d.id === id) || null,
  listBookings: async () => [...s.bookings].sort((a, b) => a.work_date.localeCompare(b.work_date)), listDeposits: async () => [...s.deposits].reverse(),
};
const day = (n) => new Date(NOW + 9 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const events = [
  { summary: "[크린토피아] 북구 34평 아파트 (오후)", start: { dateTime: `${day(3)}T14:00:00+09:00` } },
  { summary: "[자체영업] 마산 33평 아파트 (오전)", start: { dateTime: `${day(5)}T09:00:00+09:00` } },
  { summary: "[크린토피아] 해운대 25평 (오전)", start: { dateTime: `${day(6)}T09:00:00+09:00` } },
  { summary: "[휴무]", start: { date: day(9) }, end: { date: day(10) } },
];
const BASE_EVENTS = events.length;
let n = 0;
const cal = {
  eventsOn: async (d) => events.filter((e) => (e.start.dateTime || e.start.date).startsWith(d)),
  eventsBetween: async (a, z) => events.filter((e) => { const d = (e.start.dateTime || e.start.date).slice(0, 10); return d >= a && d <= z; }),
  insert: async (ev) => { const e = { id: "ev" + ++n, ...ev }; events.push(e); return e; }, patch: async (id, b) => { const e = events.find((x) => x.id === id); if (e) Object.assign(e, b); return { id }; },
};
const env = { INBOX_TOKEN: "t0ken", SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", GOOGLE_SERVICE_ACCOUNT_JSON: "{}" };
const KEY = "k".repeat(40); // DEV_KEY
const fakeFetch = async () => ({ ok: true, text: async () => JSON.stringify([{ key_sha256: crypto.createHash("sha256").update(KEY).digest("hex") }]) });
const H = {
  "/api/booking": require(ROOT + "/netlify/functions/booking").makeHandler({ env, storeImpl: store, calendarImpl: cal }),
  "/api/deposit": require(ROOT + "/netlify/functions/deposit").makeHandler({ env, storeImpl: store, calendarImpl: cal }),
  "/api/booking-admin": require(ROOT + "/netlify/functions/booking-admin").makeHandler({ env, storeImpl: store, calendarImpl: cal, fetchImpl: fakeFetch }),
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (H[u.pathname]) {
    let body = ""; for await (const c of req) body += c;
    const out = await H[u.pathname]({ httpMethod: req.method, headers: req.headers, queryStringParameters: Object.fromEntries(u.searchParams), body });
    res.writeHead(out.statusCode, out.headers); return res.end(out.body);
  }
  if (u.pathname === "/__dev" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    const f = new URLSearchParams(body);
    if (f.get("reset")) { s.bookings.length = 0; s.deposits.length = 0; events.splice(BASE_EVENTS); }
    else await H["/api/deposit"]({ httpMethod: "POST", headers: { authorization: "Bearer t0ken" }, body: JSON.stringify({ messages: [{ text: f.get("text") || "" }] }) });
    res.writeHead(303, { Location: "/__dev" }); return res.end();
  }
  if (u.pathname === "/__dev") {
    const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const rows = s.bookings.map((b) => `<tr><td>${esc(b.code)}</td><td>${esc(b.work_date)} ${esc(b.ampm)}</td><td>${esc(b.depositor_name)}</td><td>${b.deposit.toLocaleString()}원</td><td>${esc(b.status)}</td></tr>`).join("");
    const deps = s.deposits.map((d) => `<li>${esc(d.state)} · ${d.amount?.toLocaleString()}원 · ${esc(d.note || "")}<br><small>${esc(d.text)}</small></li>`).join("");
    const first = s.bookings.find((b) => b.status === "pending");
    const sample = first ? `[KB]11/14 13:05\n123456**789\n${first.depositor_name}\n입금\n${first.deposit.toLocaleString()}\n잔액1,284,567` : "[KB]11/14 13:05\n123456**789\n홍길동\n입금\n50,000\n잔액1,284,567";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>감탄 개발용</title><link rel="stylesheet" href="/assets/theme.css"><style>body{padding:20px;max-width:720px;margin:auto}textarea{width:100%;height:130px;font:inherit}button{font:inherit;padding:8px 16px;margin-top:8px}td{padding:4px 8px;border-bottom:1px solid #ddd}</style>
<h1>개발용 (로컬 전용)</h1><p><a href="/reserve/">고객 예약 페이지</a> · <a href="/bookings/#k=${KEY}">관리 화면</a></p>
<h2>입금 문자 흉내</h2><p>은행 문자 원문을 넣고 보내면 실제 /api/deposit 과 같은 처리가 됩니다. (입금 대기 예약이 있으면 그 이름·금액으로 채워 둠)</p>
<form method="post"><textarea name="text">${sample.replace(/\\n/g, "\n")}</textarea><br><button>입금 문자 보내기</button></form>
<h2>예약</h2><table>${rows || "<tr><td>없음</td></tr>"}</table><h2>입금 알림</h2><ul>${deps || "<li>없음</li>"}</ul>
<form method="post"><input type="hidden" name="reset" value="1"><button>데이터 초기화</button></form>
<h2>가짜 캘린더 일정 (이 날짜들은 마감)</h2><ul>${events.map((e) => `<li>${esc((e.start.dateTime || e.start.date).slice(0, 10))} ${esc(e.summary)}</li>`).join("")}</ul>`);
  }
  if (u.pathname === "/__state") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ s, events })); }
  let p = path.join(ROOT, "public", u.pathname); if (p.endsWith("/")) p += "index.html";
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" }); res.end(d); });
}).listen(PORT, "0.0.0.0", () => {
  // 같은 와이파이의 휴대폰·다른 컴퓨터에서 열 주소 (이 컴퓨터의 내부 IP)
  const lan = Object.values(require("os").networkInterfaces()).flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
  const show = (host) => [
    `  고객 예약   http://${host}:${PORT}/reserve/`,
    `  관리 화면   http://${host}:${PORT}/bookings/#k=${KEY}`,
    `  입금 흉내   http://${host}:${PORT}/__dev`,
  ].join("\n");
  console.log(`\n감탄 로컬 서버 (가짜 데이터, 끄려면 Ctrl+C)\n\n이 컴퓨터에서:\n${show("localhost")}`);
  for (const ip of lan) console.log(`\n같은 와이파이의 휴대폰에서 (${ip}):\n${show(ip)}`);
  if (!lan.length) console.log("\n(와이파이 주소를 찾지 못했습니다. 네트워크 연결을 확인하세요)");
  console.log("\n휴대폰에서 안 열리면: 맥 시스템 설정 → 네트워크 → 방화벽에서 node 연결 허용, 휴대폰이 같은 와이파이인지 확인\n");
});
