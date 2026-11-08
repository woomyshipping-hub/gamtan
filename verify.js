#!/usr/bin/env node
// 정산 계산·메모 파싱 자체 검증. 실패하면 종료코드 1.
//   node verify.js                  로컬 소스 검증 (fixtures.json 전부)
//   node verify.js --url <배포주소>  + 배포된 사이트가 같은 값을 내는지 확인
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "public/index.html"), "utf8");
const { helpers: H } = require(path.join(dir, "api/events.js"));
const FX = JSON.parse(fs.readFileSync(path.join(dir, "fixtures.json"), "utf8"));

// index.html 의 순수 함수(DEF, parse, isSolo, calc)를 문자열로 잘라 그대로 실행한다. (복제 로직 없음)
const cut = (a, b, from = 0) => { const i = html.indexOf(a, from); const j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error("marker not found: " + a); return html.slice(i, j); };
const defSrc = cut("const DEF = {", "};") + "};";
const parseSrc = cut("function parse(ev){", "\n  const isSolo");
const calcSrc = cut("const isSolo=", "\n  const isBig");
const lib = new Function(`const won=n=>(Math.round(n)||0).toLocaleString("ko-KR")+"원";
${defSrc}
let R=Object.assign({},DEF);
${parseSrc}
${calcSrc}
return {parse,calc,DEF};`)();

let fail = 0, pass = 0;
const bad = (m) => { fail++; console.log("FAIL", m); };
const ok = () => { pass++; };
const evOf = (f) => {
  const d = f.memo_lines.join("\n"), h = f.ampm === "오전" ? ["08", "13"] : ["14", "19"];
  return { id: f.id, summary: f.summary, start: { dateTime: `${f.date}T${h[0]}:00:00+09:00` }, end: { dateTime: `${f.date}T${h[1]}:00:00+09:00` },
    extraCal: H.extraOf(d), crewCal: H.crewOf(d), hanCal: H.hanOf(d), ...H.settleOf(d) };
};
const run = (ev) => { const j = lib.parse(ev); return { j, c: lib.calc(j, {}) }; };
const KEYS = ["recv", "han", "mine", "baseAmt", "exAmt", "parkAmt"];
const cmp = (id, c, e) => {
  let all = true;
  for (const k of KEYS) if (Math.round(c[k]) !== e[k]) { all = false; bad(`${id} ${k}: got ${Math.round(c[k])} want ${e[k]}`); }
  if (!!c.warn !== e.warn) { all = false; bad(`${id} warn: got ${!!c.warn} want ${e.warn}`); }
  if (all) ok();
};

for (const f of FX.fixtures) { const { c } = run(evOf(f)); cmp(f.id, c, f.expect); }

for (const w of FX.week_sums) {
  const s = { recv: 0, han: 0, mine: 0 };
  for (const f of FX.fixtures) if (!f.synthetic && f.date >= w.from && f.date <= w.to) { const { c } = run(evOf(f)); s.recv += c.recv; s.han += c.han; s.mine += c.mine; }
  for (const k of ["recv", "han", "mine"]) { if (Math.round(s[k]) !== w[k]) bad(`week ${w.from}..${w.to} ${k}: got ${Math.round(s[k])} want ${w[k]}`); else ok(); }
}

// 필수 화면 문구
for (const t of ["정산받을 총액", "킴 정산액", "김한준님 지급액", "홈클린마스터"]) html.includes(t) ? ok() : bad("index.html missing text: " + t);

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
console.log(`local: pass=${pass} fail=${fail}  index.html sha256=${sha(fs.readFileSync(path.join(dir, "public/index.html")))}`);

(async () => {
  const ui = process.argv.indexOf("--url");
  if (ui > 0) {
    const base = process.argv[ui + 1].replace(/\/$/, "");
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; };
    const page = await get("/");
    page.status === 200 ? ok() : bad("GET / " + page.status);
    // Netlify가 배포 HTML에 자동 삽입하는 부분만 제거 후 비교: (1) "This site is hosted on Netlify" 주석, (2) src가 /.netlify/scripts/ 로 시작하는 script 태그
    const stripNetlify = (h) => h
      .replace(/\n?<!--\s*This site is hosted on Netlify[\s\S]*?-->/g, "")
      .replace(/\n?<script\b[^>]*\ssrc=["']?\/\.netlify\/scripts\/[^>]*>\s*<\/script>/g, "");
    sha(stripNetlify(page.buf.toString("utf8"))) === sha(fs.readFileSync(path.join(dir, "public/index.html"), "utf8")) ? ok() : bad("deployed index.html differs from repo public/index.html");
    const st = await get("/api/state");
    st.status === 200 ? ok() : bad("GET /api/state " + st.status + " (REDIS_URL?)");
    const ev = await get("/api/events?start=2026-10-01&end=2026-10-31");
    if (ev.status !== 200) bad("GET /api/events " + ev.status + " (GOOGLE_* env / calendar share?)");
    else {
      ok();
      const events = JSON.parse(ev.buf.toString()).events;
      for (const f of FX.fixtures.filter((x) => !x.synthetic)) {
        const m = events.find((e) => e.summary === f.summary && (e.start.dateTime || e.start.date).slice(0, 10) === f.date);
        if (!m) { bad(`live ${f.id}: event not found in calendar`); continue; }
        const c = lib.calc(lib.parse(m), {});
        cmp("live:" + f.id, c, f.expect);
      }
    }
    console.log("note: live 비교는 일정별 직접입력(/api/state)을 적용하지 않은 순수 계산값이다.");
  }
  console.log(`TOTAL pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("ERROR", e.message); process.exit(1); });
