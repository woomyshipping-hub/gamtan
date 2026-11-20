// /api/assistant: 키 확인, 할 일 추가·수정·완료·삭제, 자동 할 일(정산·카톡), 브리핑·대화·도움 (가짜 Supabase, 가짜 AI)
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { makeHandler, kakaoAutos } = require("../netlify/functions/assistant");
const { taskLines } = require("../netlify/lib/assistant-ai");

const KEY = "k".repeat(40);
const ENV = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" };
const NOW = () => new Date("2026-11-20T01:00:00Z"); // 11/20 10:00 KST

function fakeSupa(inbox = []) {
  const db = { tasks: [], briefs: {} };
  const res = (j) => ({ ok: true, status: 200, text: async () => (j === null ? "" : JSON.stringify(j)) });
  const fetchImpl = async (url, opt) => {
    const u = new URL(url), table = u.pathname.split("/").pop(), body = opt.body ? JSON.parse(opt.body) : null;
    if (table === "access_keys") return res([{ key_sha256: crypto.createHash("sha256").update(KEY).digest("hex") }]);
    if (table === "inbox_messages") return res(inbox);
    if (table === "assistant_briefs") {
      if (opt.method === "GET") { const d = u.searchParams.get("brief_date").slice(3); return res(db.briefs[d] ? [{ body: db.briefs[d] }] : []); }
      db.briefs[body.brief_date] = body.body; return res(null);
    }
    if (table === "assistant_tasks") {
      const live = db.tasks.filter((t) => !t.deleted_at);
      if (opt.method === "GET") return res(live.filter((t) => !t.done_at || t.done_at >= "2026-11-19"));
      if (opt.method === "POST") {
        const rows = Array.isArray(body) ? body : [body], out = [];
        for (const r of rows) {
          const old = r.auto_key && db.tasks.find((t) => t.auto_key === r.auto_key);
          if (old) { Object.assign(old, r); out.push(old); continue; }
          const t = { id: crypto.randomUUID(), parent_id: null, notes: null, due_date: null, done_at: null, sort: 0, created_at: new Date().toISOString(), source: "manual", ...r };
          db.tasks.push(t); out.push(t);
        }
        return res(out);
      }
      if (opt.method === "PATCH") {
        const or = u.searchParams.get("or"), id = u.searchParams.get("id");
        const hit = or ? live.filter((t) => or.includes(t.id) || or.includes(`parent_id.eq.${t.parent_id}`) && t.parent_id) : live.filter((t) => `eq.${t.id}` === id);
        for (const t of hit) Object.assign(t, body);
        return res(hit);
      }
    }
    throw new Error("unexpected " + opt.method + " " + url);
  };
  return { db, fetchImpl };
}
const req = (method, { qs, body, key = KEY } = {}) => ({ httpMethod: method, headers: key ? { "x-ledger-key": key } : {}, queryStringParameters: qs || {}, body: body ? JSON.stringify(body) : undefined });
const J = (r) => JSON.parse(r.body);
const noAi = async () => { throw new Error("AI가 불리면 안 됨"); };

test("키 없거나 틀리면 401", async () => {
  const h = makeHandler({ env: ENV, fetchImpl: fakeSupa().fetchImpl, aiImpl: noAi, now: NOW });
  assert.equal((await h(req("GET", { key: "" }))).statusCode, 401);
  assert.equal((await h(req("GET", { key: "x" }))).statusCode, 401);
});

test("할 일: 추가 → 수정 → 완료 → 삭제(하위 단계 포함), 입력 검증", async () => {
  const s = fakeSupa();
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl, aiImpl: noAi, now: NOW });
  const a = J(await h(req("POST", { body: { type: "task", scope: "personal", title: "  건강검진 병원 고르기 ", due_date: "2026-11-21" } }))).task;
  assert.equal(a.title, "건강검진 병원 고르기");
  assert.equal(a.scope, "personal");
  const sub = J(await h(req("POST", { body: { type: "task", parent_id: a.id, title: "병원 3곳 비교" } }))).task;
  assert.equal(sub.scope, "personal", "하위 단계는 상위 구분을 따른다");
  const e = J(await h(req("POST", { body: { type: "task", id: a.id, title: "건강검진 예약", scope: "gamtan", due_date: null } }))).task;
  assert.equal(e.title, "건강검진 예약");
  assert.equal(e.due_date, null);
  const d = J(await h(req("POST", { body: { type: "task", id: a.id, done: true } }))).task;
  assert.ok(d.done_at);
  assert.equal((await h(req("DELETE", { qs: { id: a.id } }))).statusCode, 200);
  assert.ok(s.db.tasks.every((t) => t.deleted_at), "상위·하위 모두 숨김");
  for (const bad of [{ type: "task", title: "" }, { type: "task", title: "x", scope: "etc" }, { type: "task", title: "x", due_date: "11/21" }, { type: "nope" }]) {
    assert.equal((await h(req("POST", { body: bad }))).statusCode, 400, JSON.stringify(bad));
  }
});

test("정산 자동 할 일: 같은 키는 한 번만, 다시 보내도 완료 표시 유지", async () => {
  const s = fakeSupa();
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl, aiImpl: noAi, now: NOW });
  const items = [{ auto_key: "settle-in:2026-11-09", title: "정산 입금 확인 (11/9–11/15 주)", notes: "정산받을 총액 1,270,000원", due_date: "2026-11-19" }];
  assert.equal((await h(req("POST", { body: { type: "auto", items } }))).statusCode, 200);
  const t = s.db.tasks[0];
  assert.equal(t.scope, "gamtan");
  assert.equal(t.source, "auto");
  await h(req("POST", { body: { type: "task", id: t.id, done: true } }));
  await h(req("POST", { body: { type: "auto", items: [{ ...items[0], notes: "정산받을 총액 1,300,000원" }] } }));
  assert.equal(s.db.tasks.length, 1);
  assert.ok(s.db.tasks[0].done_at, "완료 유지");
  assert.equal(s.db.tasks[0].notes, "정산받을 총액 1,300,000원");
  assert.equal((await h(req("POST", { body: { type: "auto", items: [{ auto_key: "kakao:x", title: "x" }] } }))).statusCode, 400, "정산 키만 받는다");
});

test("카톡 자동 할 일: 매칭 실패는 1건씩(연락처 가림), 읽기 실패는 날짜별 묶음", () => {
  const out = kakaoAutos([
    { id: "a1", state: "unmatched", sent_at: "2026-11-12T09:32:00Z", text: "[나에게 답장] 크린토피아 2일전 --- 010-1234-5678 곰팡이 4만원", error: "본 일정을 찾지 못함" },
    { id: "a2", state: "error", sent_at: "2026-11-13T11:33:00Z", text: "네" },
    { id: "a3", state: "error", sent_at: "2026-11-13T11:35:00Z", text: "[사진]" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].auto_key, "kakao:a1");
  assert.match(out[0].title, /^카톡 확인: 11\/12 /);
  assert.ok(!/1234/.test(out[0].title), "연락처는 가린다");
  assert.equal(out[1].auto_key, "kakao-error:2026-11-13");
  assert.equal(out[1].title, "카톡 2건 읽기 실패 (11/13)");
});

test("GET: 카톡 자동 할 일을 만들고 목록·브리핑을 준다 (AI 안 씀)", async () => {
  const s = fakeSupa([{ id: "a1", state: "unmatched", sent_at: "2026-11-18T09:00:00Z", text: "추가 없습니다", error: "해당 일정 2건" }]);
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl, aiImpl: noAi, now: NOW });
  const r = J(await h(req("GET", { qs: { date: "2026-11-20" } })));
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].auto_key, "kakao:a1");
  assert.equal(r.brief, null);
});

test("브리핑: 열린 할 일만 고르고, 하루 한 번 저장 (force면 다시)", async () => {
  const s = fakeSupa();
  let calls = 0, seen = null;
  const aiImpl = async (kind, ctx) => { calls++; seen = ctx; return { summary: "오늘 꼭 할 일은 1개입니다.", picks: [{ id: ctx.tasks[0].id, why: "정산일 지남", minutes: 5 }, { id: "없는-id", why: "x", minutes: 1 }] }; };
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl, aiImpl, now: NOW });
  await h(req("POST", { body: { type: "task", title: "정산 입금 확인", due_date: "2026-11-19" } }));
  const done = J(await h(req("POST", { body: { type: "task", title: "끝난 일" } }))).task;
  await h(req("POST", { body: { type: "task", id: done.id, done: true } }));
  const b = J(await h(req("POST", { body: { type: "brief", date: "2026-11-20" } }))).brief;
  assert.equal(b.picks.length, 1, "목록에 없는 id는 버린다");
  assert.equal(seen.tasks.length, 1, "끝난 일은 AI에 안 보낸다");
  await h(req("POST", { body: { type: "brief", date: "2026-11-20" } }));
  assert.equal(calls, 1, "같은 날은 저장된 브리핑");
  await h(req("POST", { body: { type: "brief", date: "2026-11-20", force: true } }));
  assert.equal(calls, 2);
});

test("대화: 형식 검증, 계획 단계 정리, 추가할 곳 전달", async () => {
  const s = fakeSupa();
  let got = null;
  const aiImpl = async (kind, ctx) => { got = ctx; return { reply: "4단계로 나눴어요.", plan: [{ title: "견적 문의 페이지 열기", due_date: "2026-11-22", scope: "gamtan" }, { title: "", due_date: null, scope: "gamtan" }, { title: "건강검진", due_date: "다음주", scope: "x" }] }; };
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl, aiImpl, now: NOW });
  assert.equal((await h(req("POST", { body: { type: "chat", messages: [] } }))).statusCode, 400);
  assert.equal((await h(req("POST", { body: { type: "chat", messages: [{ role: "assistant", content: "x" }] } }))).statusCode, 400);
  const r = J(await h(req("POST", { body: { type: "chat", scope: "personal", messages: [{ role: "user", content: "12월에 문의 10건" }] } })));
  assert.equal(r.plan.length, 2);
  assert.deepEqual(r.plan[1], { title: "건강검진", due_date: null, scope: "personal" });
  assert.match(got.messages[0].content, /추가할 곳: 개인/);
});

test("도움: 하위 단계를 만들고 초안을 돌려준다", async () => {
  const s = fakeSupa();
  const aiImpl = async () => ({ intro: "세 단계면 됩니다.", steps: [{ title: "사진 고르기", due_date: null }, { title: "자막 정하기", due_date: "2026-11-21" }], draft: "팀장님, 사진 부탁드립니다." });
  const h = makeHandler({ env: ENV, fetchImpl: s.fetchImpl, aiImpl, now: NOW });
  const t = J(await h(req("POST", { body: { type: "task", title: "인스타 릴스 첫 편", scope: "gamtan" } }))).task;
  const r = J(await h(req("POST", { body: { type: "help", id: t.id } })));
  assert.equal(r.steps.length, 2);
  assert.ok(r.steps.every((x) => x.parent_id === t.id && x.source === "ai" && x.scope === "gamtan"));
  assert.equal(r.draft, "팀장님, 사진 부탁드립니다.");
  assert.equal((await h(req("POST", { body: { type: "help", id: crypto.randomUUID() } }))).statusCode, 404);
});

test("AI에 보내는 할 일 목록 형식", () => {
  assert.equal(taskLines([]), "(열린 할 일 없음)");
  assert.equal(taskLines([{ id: "1", scope: "personal", title: "치과", due_date: null, notes: null }]), "- [1] (개인) 치과 · 기한 없음");
});
