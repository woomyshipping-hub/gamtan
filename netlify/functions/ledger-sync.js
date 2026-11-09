// 매일 06:00(KST) 개인 가계부 시트 → 감탄 장부 자동 가져오기. 이번 달과 지난달(가져오기 시작 달 이후만).
// 일정: netlify.toml [functions."ledger-sync"] schedule. 수동 실행은 장부 화면의 "가계부 가져오기" 버튼.
const { makeSupa } = require("../lib/supa");
const { importMonth } = require("./ledger");

function months(now) {
  const k = new Date(now.getTime() + 9 * 3600e3);
  const cur = k.toISOString().slice(0, 7);
  const p = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  return [p, cur];
}

function makeHandler({ env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  return async () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { statusCode: 503 };
    const rest = makeSupa(env, fetchImpl);
    const results = [];
    for (const month of months(now())) {
      try { results.push(await importMonth({ env, fetchImpl, rest, month, apply: true })); } catch (e) { results.push({ month, error: String(e.message) }); }
    }
    console.log(JSON.stringify(results.map((r) => ({ month: r.month, new: r.new, error: r.error, skipped: r.before_start || (r.missing_tab ? "no tab" : undefined) }))));
    return { statusCode: 200 };
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.months = months;
