// node --test tests/  (네트워크·API 키 없이 가짜 DB/AI/텔레그램으로 /api/inbox 흐름 검증)
const test = require("node:test");
const assert = require("node:assert");
const { makeHandler } = require("../netlify/functions/inbox");
const { extract, SCHEMA } = require("../netlify/lib/extract");

const ENV = { INBOX_TOKEN: "t0ken", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srk", TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "1" };

function fakeWorld() {
  const rows = new Map(); // dedupe_key -> row
  const sent = [];
  let n = 0;
  const fetchImpl = async (url, opt) => {
    if (url.startsWith("https://api.telegram.org/")) { sent.push(JSON.parse(opt.body).text); return { ok: true }; }
    if (opt.method === "POST") {
      const out = [];
      for (const r of JSON.parse(opt.body)) if (!rows.has(r.dedupe_key)) { const row = { id: `id${++n}`, state: "new", ...r }; rows.set(r.dedupe_key, row); out.push(row); }
      return { ok: true, json: async () => out };
    }
    if (opt.method === "PATCH") {
      const id = decodeURIComponent(url.split("id=eq.")[1]);
      for (const r of rows.values()) if (r.id === id) Object.assign(r, JSON.parse(opt.body));
      return { ok: true };
    }
    throw new Error("unexpected " + url);
  };
  return { rows, sent, fetchImpl };
}

const ev = (body, token = "t0ken") => ({ httpMethod: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const MSGS = {
  source: "kakao",
  chat: "김동현 홈클린마스터",
  messages: [
    { sender: "김동현", sent_at: "2026-11-08T10:00:00+09:00", text: "11/20 오전 해운대 OO아파트 101동 1001호 34평 베란다확장 35만" },
    { sender: "김동현", sent_at: "2026-11-08T10:01:00+09:00", text: "수고하세요~" },
  ],
};
const fakeExtract = async (msgs) => ({
  items: msgs.map((m) => m.text.includes("34평")
    ? { index: m.index, is_schedule: true, work_date: "2026-11-20", ampm: "오전", address: "해운대 OO아파트 101동 1001호", area_py: 34, options: ["베란다 확장"], amount: 350000, customer_phone: null, notes: null }
    : { index: m.index, is_schedule: false, work_date: null, ampm: null, address: null, area_py: null, options: [], amount: null, customer_phone: null, notes: null }),
});

test("인증 없으면 401, 설정 없으면 503, 잘못된 본문 400, GET 405", async () => {
  const w = fakeWorld();
  const h = makeHandler({ env: ENV, fetchImpl: w.fetchImpl, extractImpl: fakeExtract });
  assert.equal((await h(ev(MSGS, "wrong"))).statusCode, 401);
  assert.equal((await h({ ...ev(MSGS), headers: {} })).statusCode, 401);
  assert.equal((await makeHandler({ env: {}, fetchImpl: w.fetchImpl })(ev(MSGS))).statusCode, 503);
  assert.equal((await h(ev({ source: "kakao", messages: [] }))).statusCode, 400);
  assert.equal((await h(ev({ source: "x", messages: MSGS.messages }))).statusCode, 400);
  assert.equal((await h({ ...ev(MSGS), body: "{not json" })).statusCode, 400);
  assert.equal((await h({ httpMethod: "GET", headers: {} })).statusCode, 405);
  assert.equal(w.rows.size, 0);
});

test("일정 메시지는 초안 + 텔레그램, 잡담은 not_schedule, 재전송은 중복 무시", async () => {
  const w = fakeWorld();
  const h = makeHandler({ env: ENV, fetchImpl: w.fetchImpl, extractImpl: fakeExtract });
  const r1 = JSON.parse((await h(ev(MSGS))).body);
  assert.deepEqual(r1, { received: 2, new: 2, drafts: 1, skipped_duplicates: 0 });
  const states = [...w.rows.values()].map((r) => r.state).sort();
  assert.deepEqual(states, ["draft", "not_schedule"]);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0], /2026-11-20 오전/);
  assert.match(w.sent[0], /34평 · 350,000원/);

  const r2 = JSON.parse((await h(ev(MSGS))).body);
  assert.deepEqual(r2, { received: 2, new: 0, drafts: 0, skipped_duplicates: 2 });
  assert.equal(w.sent.length, 1);
});

test("AI 추출 실패 시 원문은 남기고 state=error, 200", async () => {
  const w = fakeWorld();
  const h = makeHandler({ env: ENV, fetchImpl: w.fetchImpl, extractImpl: async () => { throw new Error("boom"); } });
  const r = JSON.parse((await h(ev(MSGS))).body);
  assert.equal(r.error, "extract failed");
  assert.deepEqual([...w.rows.values()].map((x) => x.state), ["error", "error"]);
  assert.equal(w.sent.length, 0);
});

test("텔레그램 설정이 없어도 초안은 저장", async () => {
  const w = fakeWorld();
  const env = { ...ENV, TELEGRAM_BOT_TOKEN: "" };
  const r = JSON.parse((await makeHandler({ env, fetchImpl: w.fetchImpl, extractImpl: fakeExtract })(ev(MSGS))).body);
  assert.equal(r.drafts, 1);
  assert.equal(w.sent.length, 0);
});

test("extract: 요청 형식과 refusal 처리", async () => {
  let req;
  const client = { messages: { create: async (r) => { req = r; return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ items: [] }) }], usage: {} }; } } };
  await extract([{ index: 0, sender: "a", sent_at: "2026-11-08T01:00:00Z", text: "내일 오후 30평" }], { client, now: new Date("2026-11-08T01:00:00Z") });
  assert.equal(req.model, "claude-haiku-5-5");
  assert.deepEqual(req.output_config.format, { type: "json_schema", schema: SCHEMA });
  assert.match(req.messages[0].content, /오늘\(한국 시간\): 2026-11-08/);
  assert.match(req.messages[0].content, /2026-11-08 10:00/);
  const refuse = { messages: { create: async () => ({ stop_reason: "refusal", stop_details: null, content: [] }) } };
  await assert.rejects(extract([{ index: 0, text: "x" }], { client: refuse }), /refused/);
});
