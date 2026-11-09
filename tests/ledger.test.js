// /api/ledger: 비밀 키 확인, 입력 검증, 주민번호 가림 (가짜 Supabase)
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { makeHandler, normRrn } = require("../netlify/functions/ledger");

const KEY = "k".repeat(40);
const ENV = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" };

function fakeSupa() {
  const db = { entries: [], workers: [] };
  const calls = [];
  let n = 0;
  const mask = (w) => ({ id: w.id, name: w.name, phone: w.phone, rrn_masked: w.rrn ? w.rrn.slice(0, 8) + "******" : null, created_at: "t" });
  const fetchImpl = async (url, opt) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    calls.push({ method: opt.method, table, search: u.search, headers: opt.headers });
    const ok = (j, status = 200) => ({ ok: true, status, json: async () => j, text: async () => JSON.stringify(j) });
    if (table === "access_keys") return ok([{ key_sha256: crypto.createHash("sha256").update(KEY).digest("hex") }]);
    if (opt.method === "GET" && table === "ledger_entries") {
      const p = u.searchParams.getAll("entry_date");
      return ok(db.entries.filter((e) => e.entry_date >= p[0].replace("gte.", "") && e.entry_date < p[1].replace("lt.", "")));
    }
    if (opt.method === "GET" && table === "day_workers_masked") {
      const id = u.searchParams.get("id");
      return ok(db.workers.filter((w) => !id || "eq." + w.id === id).map(mask));
    }
    if (opt.method === "POST" && table === "ledger_entries") { const e = { id: crypto.randomUUID(), created_at: "t", ...JSON.parse(opt.body) }; db.entries.push(e); return ok([e], 201); }
    if (opt.method === "POST" && table === "day_workers") { const w = { id: crypto.randomUUID(), ...JSON.parse(opt.body) }; db.workers.push(w); return ok([{ id: w.id }], 201); }
    if (opt.method === "DELETE") { const id = u.searchParams.get("id").slice(3); db.entries = db.entries.filter((e) => e.id !== id); return { ok: true, status: 204, text: async () => "" }; }
    throw new Error("unexpected " + opt.method + " " + url);
  };
  return { db, calls, fetchImpl };
}

const req = (method, { qs, body, key = KEY } = {}) => ({ httpMethod: method, headers: key ? { "x-ledger-key": key } : {}, queryStringParameters: qs || {}, body: body ? JSON.stringify(body) : undefined });
const J = (r) => JSON.parse(r.body);

test("키 없거나 틀리면 401, 설정 없으면 503", async () => {
  const s = fakeSupa();
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl });
  assert.equal((await h(req("GET", { qs: { month: "2026-11" }, key: "" }))).statusCode, 401);
  assert.equal((await h(req("GET", { qs: { month: "2026-11" }, key: "wrong" }))).statusCode, 401);
  assert.equal((await makeHandler({ env: {}, fetchImpl: s.fetchImpl })(req("GET"))).statusCode, 503);
});

test("기록 추가·월 조회·삭제", async () => {
  const s = fakeSupa();
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl });
  const a = await h(req("POST", { body: { type: "entry", entry_date: "2026-11-06", kind: "income", category: "매출", amount: 350000, memo: "마산 33평" } }));
  assert.equal(a.statusCode, 201);
  await h(req("POST", { body: { type: "entry", entry_date: "2026-12-01", kind: "expense", category: "차량", amount: 50000 } }));
  const g = J(await h(req("GET", { qs: { month: "2026-11" } })));
  assert.equal(g.entries.length, 1);
  assert.equal(g.entries[0].amount, 350000);
  const d = await h(req("DELETE", { qs: { id: J(a).entry.id } }));
  assert.equal(d.statusCode, 200);
  assert.equal(J(await h(req("GET", { qs: { month: "2026-11" } }))).entries.length, 0);
  assert.equal(J(await h(req("GET", { qs: { month: "2026-12" } }))).entries.length, 1); // 12월 범위
});

test("입력 검증: 구분·분류 짝, 금액, 날짜, 일용직은 인건비만", async () => {
  const s = fakeSupa();
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl });
  const bad = [
    { type: "entry", entry_date: "2026-11-06", kind: "expense", category: "매출", amount: 1 },
    { type: "entry", entry_date: "2026-11-06", kind: "income", category: "차량", amount: 1 },
    { type: "entry", entry_date: "2026-11-06", kind: "expense", category: "차량", amount: 0 },
    { type: "entry", entry_date: "2026-11-06", kind: "expense", category: "차량", amount: 1.5 },
    { type: "entry", entry_date: "11/06", kind: "expense", category: "차량", amount: 1 },
    { type: "entry", entry_date: "2026-11-06", kind: "expense", category: "차량", amount: 1, worker_id: crypto.randomUUID() },
    { type: "entry", entry_date: "2026-11-06", kind: "expense", category: "인건비", amount: 1, worker_id: "x" },
    { type: "nope" },
  ];
  for (const b of bad) assert.equal((await h(req("POST", { body: b }))).statusCode, 400, JSON.stringify(b));
  assert.equal((await h(req("GET", { qs: { month: "2026-13" } }))).statusCode, 400);
  assert.equal((await h(req("DELETE", { qs: { id: "1 or 1=1" } }))).statusCode, 400);
  assert.equal(s.db.entries.length, 0);
});

test("일용직: 주민번호는 저장만 하고 응답·목록은 가린 값", async () => {
  const s = fakeSupa();
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl });
  const r = await h(req("POST", { body: { type: "worker", name: "홍길동", phone: "010-0000-0000", rrn: "9001011234567" } }));
  assert.equal(r.statusCode, 201);
  assert.equal(s.db.workers[0].rrn, "900101-1234567");
  assert.equal(J(r).worker.rrn_masked, "900101-1******");
  assert.ok(!r.body.includes("234567"));
  const g = await h(req("GET", { qs: { month: "2026-11" } }));
  assert.ok(!g.body.includes("234567"));
  assert.equal((await h(req("POST", { body: { type: "worker", name: "x", rrn: "123" } }))).statusCode, 400);
  assert.equal((await h(req("POST", { body: { type: "worker", name: " " } }))).statusCode, 400);
  // 응답에 rrn 원문 컬럼을 요청하지 않는다
  assert.ok(s.calls.every((c) => !(c.method === "GET" && c.table === "day_workers")));
});

test("normRrn", () => {
  assert.equal(normRrn("900101 1234567"), "900101-1234567");
  assert.equal(normRrn("90010-11234567"), "900101-1234567");
  assert.equal(normRrn("12345"), null);
});

// ---- 가계부 시트 가져오기 ----
const { parseRows, plan, parseDate, parseAmount } = require("../netlify/lib/sheet-import");
const SHEET_ROWS = [
  ["2026년  10월 1일", "₩2,000", "씨유광안세종점", "변동비_개인_식비", "", "2026년  10월 3일", "₩365,000", "입주청소", "홈크린마스터"],
  ["", "₩150,150", "한맥기업", "변동비_업무_소모품", "", "2026년  10월 5일", "₩230,000", "입주청소", "홈크린마스터"],
  ["2026년  10월 4일", "₩55,000", "SK주유소", "변동비_업무_차량", "", "", "₩230,000", "입주청소", "홈크린마스터"],
  ["", "₩55,000", "SK주유소", "변동비_업무_차량", "", "2026년  10월 9일", "₩355,800", "KB손보", "실비 청구"],
  ["2026년  9월 30일", "₩9,000", "이월", "변동비_업무_차량"],
  [],
];
const MAP = { expense: { "변동비_업무_소모품": "세제", "변동비_업무_차량": "차량" }, income: { "홈크린마스터": "매출" } };

test("가계부 파싱: 빈 날짜는 윗줄, 금액 ₩ 제거, 다른 달 제외", () => {
  assert.equal(parseDate("2026년  10월 1일"), "2026-10-01");
  assert.equal(parseAmount("₩150,150"), 150150);
  const items = parseRows(SHEET_ROWS, "2026-10");
  assert.equal(items.length, 8);
  assert.equal(items.find((i) => i.desc === "한맥기업").date, "2026-10-01");
  assert.equal(items.filter((i) => i.side === "income" && i.amount === 230000).map((i) => i.date).join(), "2026-10-05,2026-10-05");
});

test("가계부 계획: 매핑된 카테고리만, 같은 줄 두 번은 다른 키, 개인 지출 제외", () => {
  const { entries, categories } = plan(SHEET_ROWS, "2026-10", MAP);
  assert.equal(entries.length, 6); // 소모품 1 + 차량 2 + 홈크린마스터 3
  assert.equal(new Set(entries.map((e) => e.import_key)).size, 6);
  assert.ok(!entries.some((e) => /씨유|KB손보/.test(e.memo)));
  const food = categories.find((c) => c.category === "변동비_개인_식비");
  assert.equal(food.mapped_to, null);
  assert.equal(entries.find((e) => e.memo.startsWith("한맥기업")).category, "세제");
});

test("가져오기 API: 미리보기는 저장 안 함, 적용은 새 줄만, 두 번 적용해도 중복 없음", async () => {
  const s = fakeSupa();
  const settings = [{ key: "ledger_sheet_id", value: "SHEET" }, { key: "ledger_sheet_map", value: JSON.stringify(MAP) }];
  const base = s.fetchImpl;
  const fetchImpl = async (url, opt = {}) => {
    if (url.startsWith("https://oauth2.googleapis.com/")) return { ok: true, json: async () => ({ access_token: "AT" }) };
    if (url.startsWith("https://sheets.googleapis.com/")) {
      assert.match(decodeURIComponent(url), /'2026년 10월 상세'!B5:J/);
      return { ok: true, json: async () => ({ values: SHEET_ROWS }) };
    }
    const u = new URL(url);
    if (u.pathname.endsWith("/app_settings")) return { ok: true, status: 200, text: async () => JSON.stringify(settings) };
    if (u.pathname.endsWith("/ledger_entries") && opt.method === "GET" && u.searchParams.get("source")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(s.db.entries.filter((e) => e.source === "sheet").map((e) => ({ import_key: e.import_key }))) };
    }
    if (u.pathname.endsWith("/ledger_entries") && opt.method === "POST" && u.searchParams.get("on_conflict")) {
      for (const e of JSON.parse(opt.body)) if (!s.db.entries.some((x) => x.import_key === e.import_key)) s.db.entries.push({ id: crypto.randomUUID(), ...e });
      return { ok: true, status: 201, text: async () => "" };
    }
    return base(url, opt);
  };
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const env = { ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sa@x", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }) };
  const h = makeHandler({ env, fetchImpl });
  const dry = J(await h(req("POST", { body: { type: "import", month: "2026-10" } })));
  assert.equal(dry.new, 6);
  assert.equal(dry.applied, false);
  assert.equal(s.db.entries.length, 0);
  const a1 = J(await h(req("POST", { body: { type: "import", month: "2026-10", apply: true } })));
  assert.equal(a1.applied, true);
  assert.equal(s.db.entries.length, 6);
  assert.equal(a1.new_sum, 365000 + 230000 * 2 - 150150 - 55000 * 2);
  const a2 = J(await h(req("POST", { body: { type: "import", month: "2026-10", apply: true } })));
  assert.equal(a2.new, 0);
  assert.equal(a2.already, 6);
  assert.equal(s.db.entries.length, 6);
});
