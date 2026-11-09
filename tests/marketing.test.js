// /api/marketing: 키 확인, 글 추가·수정·삭제, 주별 성과 저장 검증 (가짜 Supabase)
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { makeHandler, weekRange } = require("../netlify/functions/marketing");

const KEY = "k".repeat(40);
const ENV = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" };

function fakeSupa() {
  const db = { posts: [], stats: [] };
  const calls = [];
  const res = (j, status = 200) => ({ ok: true, status, text: async () => (j === null ? "" : JSON.stringify(j)) });
  const fetchImpl = async (url, opt) => {
    const u = new URL(url), table = u.pathname.split("/").pop();
    calls.push({ method: opt.method, table, search: decodeURIComponent(u.search) });
    if (table === "access_keys") return res([{ key_sha256: crypto.createHash("sha256").update(KEY).digest("hex") }]);
    if (table === "marketing_posts") {
      if (opt.method === "GET") return res(db.posts);
      if (opt.method === "POST") { const p = { id: crypto.randomUUID(), ...JSON.parse(opt.body) }; db.posts.push(p); return res([p], 201); }
      if (opt.method === "PATCH") { const id = u.searchParams.get("id").slice(3); const p = db.posts.find((x) => x.id === id); if (p) Object.assign(p, JSON.parse(opt.body)); return res(p ? [p] : []); }
      if (opt.method === "DELETE") { const id = u.searchParams.get("id").slice(3); db.posts = db.posts.filter((x) => x.id !== id); return res(null, 204); }
    }
    if (table === "marketing_stats") {
      if (opt.method === "GET") return res(db.stats);
      if (opt.method === "POST") {
        const s = JSON.parse(opt.body);
        const i = db.stats.findIndex((x) => x.week_start === s.week_start && x.channel === s.channel);
        if (i >= 0) db.stats[i] = s; else db.stats.push(s);
        return res([s]);
      }
    }
    throw new Error("unexpected " + opt.method + " " + url);
  };
  return { db, calls, fetchImpl };
}
const req = (method, { qs, body, key = KEY } = {}) => ({ httpMethod: method, headers: key ? { "x-ledger-key": key } : {}, queryStringParameters: qs || {}, body: body ? JSON.stringify(body) : undefined });
const J = (r) => JSON.parse(r.body);

test("키 없거나 틀리면 401", async () => {
  const h = makeHandler({ env: ENV, fetchImpl: fakeSupa().fetchImpl });
  assert.equal((await h(req("GET", { qs: { month: "2026-11" }, key: "" }))).statusCode, 401);
  assert.equal((await h(req("GET", { qs: { month: "2026-11" }, key: "x" }))).statusCode, 401);
});

test("weekRange: 그 달 달력에 걸친 첫·마지막 월요일", () => {
  assert.deepEqual(weekRange("2026-11"), ["2026-10-26", "2026-11-30"]);
  assert.deepEqual(weekRange("2026-12"), ["2026-11-30", "2026-12-28"]);
});

test("글: 추가·수정·삭제, 입력 검증", async () => {
  const s = fakeSupa();
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl });
  const a = await h(req("POST", { body: { type: "post", post_date: "2026-11-12", channel: "블로그", title: "창원 33평 입주청소 후기", status: "작성중" } }));
  assert.equal(a.statusCode, 201);
  const id = J(a).post.id;
  const e = await h(req("POST", { body: { type: "post", id, post_date: "2026-11-13", channel: "블로그", title: "창원 33평 입주청소 후기", status: "게시", url: "https://blog.naver.com/x" } }));
  assert.equal(J(e).post.status, "게시");
  assert.equal(s.db.posts.length, 1);
  for (const bad of [
    { type: "post", post_date: "11/12", channel: "블로그", title: "x" },
    { type: "post", post_date: "2026-11-12", channel: "틱톡", title: "x" },
    { type: "post", post_date: "2026-11-12", channel: "블로그", title: " " },
    { type: "post", post_date: "2026-11-12", channel: "블로그", title: "x", status: "완료" },
    { type: "post", post_date: "2026-11-12", channel: "블로그", title: "x", url: "javascript:alert(1)" },
  ]) assert.equal((await h(req("POST", { body: bad }))).statusCode, 400, JSON.stringify(bad));
  assert.equal((await h(req("DELETE", { qs: { id } }))).statusCode, 200);
  assert.equal(s.db.posts.length, 0);
});

test("성과: 월요일 주만, 0 이상 정수, 같은 주·채널은 덮어쓰기", async () => {
  const s = fakeSupa();
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl });
  const ok = { type: "stat", week_start: "2026-11-09", channel: "당근", ad_spend: 30000, inquiries: 5, orders: 2 };
  assert.equal((await h(req("PUT", { body: ok }))).statusCode, 200);
  assert.equal((await h(req("PUT", { body: { ...ok, orders: 3 } }))).statusCode, 200);
  assert.equal(s.db.stats.length, 1);
  assert.equal(s.db.stats[0].orders, 3);
  assert.equal((await h(req("PUT", { body: { ...ok, week_start: "2026-11-10" } }))).statusCode, 400);
  assert.equal((await h(req("PUT", { body: { ...ok, ad_spend: -1 } }))).statusCode, 400);
  assert.equal((await h(req("PUT", { body: { ...ok, inquiries: 1.5 } }))).statusCode, 400);
  const g = J(await h(req("GET", { qs: { month: "2026-11" } })));
  assert.equal(g.stats.length, 1);
  assert.ok(g.channels.includes("네이버플레이스"));
  assert.ok(s.calls.some((c) => c.table === "marketing_stats" && c.search.includes("week_start=gte.2026-10-26") && c.search.includes("week_start=lte.2026-11-30")));
});
