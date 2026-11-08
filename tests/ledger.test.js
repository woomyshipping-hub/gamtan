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
    const ok = (j, status = 200) => ({ ok: true, status, json: async () => j });
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
    if (opt.method === "DELETE") { const id = u.searchParams.get("id").slice(3); db.entries = db.entries.filter((e) => e.id !== id); return { ok: true, status: 204 }; }
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
