// /api/assistant : AI 비서 (할 일 감탄 업무 / 개인 + 오늘 브리핑 + 같이 기획하기). 장부와 같은 비밀 키.
//   헤더 x-ledger-key: <키>  (access_keys name='ledger'의 sha256과 비교)
//   GET    ?date=YYYY-MM-DD → { date, tasks, brief }   (카톡 확인 필요 자동 할 일을 먼저 갱신)
//   POST   {type:"task", id?, scope, title, notes?, due_date?, parent_id?, done?} → { task }  (id 있으면 수정)
//   POST   {type:"auto", items:[{auto_key, title, notes?, due_date?}]} → { ok }  (정산 입금 확인·김한준님 지급)
//   POST   {type:"brief", date, force?} → { brief }
//   POST   {type:"chat", messages:[{role, content}], scope} → { reply, plan }
//   POST   {type:"help", id} → { intro, draft, steps:[task] }
//   DELETE ?id=<task id> → { ok }  (하위 단계까지 숨김)
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
const crypto = require("crypto");
const { makeSupa } = require("../lib/supa");
const ai = require("../lib/assistant-ai");

const COLS = "id,scope,title,notes,due_date,parent_id,source,auto_key,done_at,sort,created_at";
const SCOPES = ["gamtan", "personal"];
const AUTO_KEY = /^settle-(in|han):\d{4}-\d\d-\d\d$/;

const reply = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ymd = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const uuid = (s) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const text = (s, n) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null);
const kstDate = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const md = (s) => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
const addDay = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
const maskPhone = (s) => s.replace(/01[0-9][ -]?\d{3,4}[ -]?\d{4}/g, "010-****-****");

// 카톡 처리 결과 중 사람이 봐야 할 것 → 감탄 자동 할 일 (매칭 실패 1건씩, 처리 실패는 날짜별로 묶음)
function kakaoAutos(rows) {
  const out = [], errs = {};
  for (const r of rows) {
    const day = kstDate(new Date(r.sent_at || r.created_at));
    if (r.state === "unmatched") {
      const snip = maskPhone(String(r.text || "").replace(/^\[[^\]]*답장\]\s*/, "").replace(/\s+/g, " ")).slice(0, 34);
      out.push({ auto_key: `kakao:${r.id}`, title: `카톡 확인: ${md(day)} ${snip}`.slice(0, 200), notes: `일정에 연결하지 못한 보고입니다. 정산 화면에서 추가금·인원을 직접 확인하세요.${r.error ? ` (사유: ${r.error})` : ""}`, due_date: day });
    } else if (r.state === "error") {
      (errs[day] = errs[day] || []).push(r);
    }
  }
  for (const [day, list] of Object.entries(errs)) {
    out.push({ auto_key: `kakao-error:${day}`, title: `카톡 ${list.length}건 읽기 실패 (${md(day)})`, notes: "서버가 읽지 못한 메시지입니다. 그날 일정·추가금 보고가 있었는지 카톡에서 확인하세요.", due_date: day });
  }
  return out;
}

function makeHandler({ env = process.env, fetchImpl = fetch, aiImpl = ai.call, now = () => new Date() } = {}) {
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

    const today = kstDate(now());
    const upsertAuto = (items) => items.length
      ? rest("assistant_tasks?on_conflict=auto_key", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: items.map((i) => ({ scope: "gamtan", source: "auto", notes: null, due_date: null, ...i })) })
      : null;
    // 열린 할 일 + 어제·오늘 끝낸 할 일 (지운 것 제외)
    const listTasks = () => rest(`assistant_tasks?deleted_at=is.null&or=(done_at.is.null,done_at.gte.${addDay(today, -1)}T00:00:00%2B09:00)&select=${COLS}&order=due_date.asc.nullslast,sort.asc,created_at.asc&limit=500`);
    const openTop = (tasks) => tasks.filter((t) => !t.done_at && !t.parent_id);

    const q = event.queryStringParameters || {};
    try {
      if (event.httpMethod === "GET") {
        const date = ymd(q.date) ? q.date : today;
        try {
          const since = new Date(now().getTime() - 7 * 86400e3).toISOString();
          const rows = await rest(`inbox_messages?state=in.(unmatched,error)&sent_at=gte.${encodeURIComponent(since)}&select=id,state,sent_at,created_at,text,error&order=sent_at.asc&limit=50`);
          await upsertAuto(kakaoAutos(rows));
        } catch (e) { /* 카톡 자동 할 일은 실패해도 화면은 연다 */ }
        const [tasks, briefs] = await Promise.all([listTasks(), rest(`assistant_briefs?brief_date=eq.${date}&select=body`)]);
        return reply(200, { date, tasks, brief: briefs[0] ? briefs[0].body : null });
      }

      if (event.httpMethod === "DELETE") {
        if (!uuid(q.id)) return reply(400, { error: "id 필요" });
        const at = new Date().toISOString();
        await rest(`assistant_tasks?or=(id.eq.${q.id},parent_id.eq.${q.id})`, { method: "PATCH", body: { deleted_at: at, updated_at: at } });
        return reply(200, { ok: true });
      }

      let b;
      try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || ""); } catch (e) { b = null; }
      if (event.httpMethod !== "POST" || !b || typeof b !== "object") return reply(400, { error: "형식 오류" });

      if (b.type === "task") {
        const row = { updated_at: new Date().toISOString() };
        if (b.title !== undefined) { row.title = text(b.title, 200); if (!row.title) return reply(400, { error: "할 일 이름 필요" }); }
        if (b.scope !== undefined) { if (!SCOPES.includes(b.scope)) return reply(400, { error: "구분 오류" }); row.scope = b.scope; }
        if (b.notes !== undefined) row.notes = text(b.notes, 4000);
        if (b.due_date !== undefined) { if (b.due_date !== null && !ymd(b.due_date)) return reply(400, { error: "날짜 형식 오류" }); row.due_date = b.due_date; }
        if (b.done !== undefined) row.done_at = b.done ? new Date().toISOString() : null;
        if (b.id !== undefined && b.id !== null) {
          if (!uuid(b.id)) return reply(400, { error: "id 오류" });
          const out = await rest(`assistant_tasks?id=eq.${b.id}&deleted_at=is.null&select=${COLS}`, { method: "PATCH", prefer: "return=representation", body: row });
          if (!out.length) return reply(404, { error: "없는 할 일" });
          return reply(200, { task: out[0] });
        }
        if (!row.title) return reply(400, { error: "할 일 이름 필요" });
        if (b.parent_id !== undefined && b.parent_id !== null) {
          if (!uuid(b.parent_id)) return reply(400, { error: "상위 할 일 오류" });
          const p = await rest(`assistant_tasks?id=eq.${b.parent_id}&deleted_at=is.null&select=scope`);
          if (!p.length) return reply(404, { error: "없는 상위 할 일" });
          row.parent_id = b.parent_id; row.scope = p[0].scope;
        }
        if (!row.scope) row.scope = "gamtan";
        row.source = b.source === "ai" ? "ai" : "manual";
        const out = await rest(`assistant_tasks?select=${COLS}`, { method: "POST", prefer: "return=representation", body: row });
        return reply(200, { task: out[0] });
      }

      if (b.type === "auto") {
        if (!Array.isArray(b.items) || b.items.length > 20) return reply(400, { error: "형식 오류" });
        const items = [];
        for (const i of b.items) {
          if (!i || !AUTO_KEY.test(i.auto_key || "") || !text(i.title, 200) || (i.due_date != null && !ymd(i.due_date))) return reply(400, { error: "자동 할 일 형식 오류" });
          items.push({ auto_key: i.auto_key, title: text(i.title, 200), notes: text(i.notes, 500), due_date: i.due_date || null });
        }
        await upsertAuto(items);
        return reply(200, { ok: true });
      }

      if (b.type === "brief") {
        const date = ymd(b.date) ? b.date : today;
        if (!b.force) {
          const have = await rest(`assistant_briefs?brief_date=eq.${date}&select=body`);
          if (have.length) return reply(200, { brief: have[0].body });
        }
        const open = openTop(await listTasks());
        const r = await aiImpl("brief", { today: date, tasks: open, user: "오늘 브리핑을 만들어 주세요." });
        const ids = new Set(open.map((t) => t.id));
        const brief = { summary: String(r.summary || "").slice(0, 600), picks: (r.picks || []).filter((p) => ids.has(p.id)).slice(0, 3).map((p) => ({ id: p.id, why: String(p.why || "").slice(0, 120), minutes: Math.max(1, Math.min(600, p.minutes | 0)) })), at: new Date().toISOString() };
        await rest("assistant_briefs?on_conflict=brief_date", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: { brief_date: date, body: brief } });
        return reply(200, { brief });
      }

      if (b.type === "chat") {
        const msgs = Array.isArray(b.messages) ? b.messages.slice(-20) : [];
        const clean = msgs.filter((m) => m && (m.role === "user" || m.role === "assistant") && text(m.content, 4000)).map((m) => ({ role: m.role, content: text(m.content, 4000) }));
        if (!clean.length || clean[clean.length - 1].role !== "user" || clean[0].role !== "user") return reply(400, { error: "대화 형식 오류" });
        const hint = SCOPES.includes(b.scope) ? b.scope : "gamtan";
        clean[clean.length - 1] = { role: "user", content: `${clean[clean.length - 1].content}\n\n(추가할 곳: ${hint === "personal" ? "개인" : "감탄"})` };
        const r = await aiImpl("chat", { today, tasks: openTop(await listTasks()), messages: clean });
        const plan = (r.plan || []).slice(0, 8).map((p) => ({ title: String(p.title || "").slice(0, 200), due_date: ymd(p.due_date) ? p.due_date : null, scope: SCOPES.includes(p.scope) ? p.scope : hint })).filter((p) => p.title);
        return reply(200, { reply: String(r.reply || "").slice(0, 3000), plan });
      }

      if (b.type === "help") {
        if (!uuid(b.id)) return reply(400, { error: "id 필요" });
        const all = await listTasks();
        const task = all.find((t) => t.id === b.id);
        if (!task) return reply(404, { error: "없는 할 일" });
        const subs = all.filter((t) => t.parent_id === task.id);
        const user = `도와줄 할 일: (${task.scope === "personal" ? "개인" : "감탄"}) ${task.title} · 기한 ${task.due_date || "없음"}${task.notes ? `\n메모: ${task.notes}` : ""}\n이미 있는 하위 단계: ${subs.length ? subs.map((s) => s.title).join(" / ") : "없음"}`;
        const r = await aiImpl("help", { today, tasks: openTop(all), user });
        const steps = (r.steps || []).slice(0, 5).map((s, i) => ({ title: text(s.title, 200), due_date: ymd(s.due_date) ? s.due_date : null, parent_id: task.id, scope: task.scope, source: "ai", sort: subs.length + i + 1 })).filter((s) => s.title);
        const made = steps.length ? await rest(`assistant_tasks?select=${COLS}`, { method: "POST", prefer: "return=representation", body: steps }) : [];
        const draft = text(r.draft, 3000);
        return reply(200, { intro: String(r.intro || "").slice(0, 600), draft, steps: made });
      }

      return reply(400, { error: "알 수 없는 요청" });
    } catch (e) {
      console.error("assistant", e.message);
      return reply(e.status ? 502 : 500, { error: e.status ? "storage error" : "처리 실패" });
    }
  };
}

const handler = makeHandler();
module.exports = { handler, makeHandler, kakaoAutos };
