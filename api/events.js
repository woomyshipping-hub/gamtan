// Google Calendar 비공개 iCal 주소(ICAL_URL)를 읽어, 정산에 필요한 일정만 JSON으로 돌려준다.
const KST = 9 * 3600e3;
const TAGS = ["[크린토피아]", "[홈클린마스터]", "[자체영업]"];

const unfold = t => t.replace(/\r?\n[ \t]/g, "");
// 메모(DESCRIPTION)에는 연락처·출입 비밀번호가 있어 내려보내지 않고, "추가금: 150,000원"의 금액만 뽑는다.
const extraOf = d => { const m = (d || "").match(/추가금\s*[:：]\s*([\d,]+)/); return m ? +m[1].replace(/,/g, "") : 0; };
const crewOf = d => { const m = (d || "").match(/작업인원\s*[:：]\s*(\d)\s*명/); return m ? +m[1] : 0; };
// 메모의 "한준님 105,000원"(그 건에서 김한준님 기본 몫)만 숫자로 뽑는다.
const hanOf = d => { const m = (d || "").match(/한준님[^\n\d]{0,8}([\d]{1,3}(?:,\d{3})+|\d{5,})\s*원/); return m ? +m[1].replace(/,/g, "") : 0; };
// "정산: 200,000원 + 추가 202,500원"(대표 정산내역)에서 기본 정산액과 추가 정산액을 뽑는다.
const settleOf = d => {
  const m = (d || "").match(/정산[^\n:：]*[:：]\s*([\d,]+)\s*원(?:\s*\+\s*추가\s*([\d,]+)\s*원)?(?:\s*\+\s*주차\s*([\d,]+)\s*원)?/);
  const n = v => (v ? +v.replace(/,/g, "") : 0);
  return m ? { settleBase: n(m[1]), settleExtra: n(m[2]), settlePark: n(m[3]) } : { settleBase: 0, settleExtra: 0, settlePark: 0 };
};
const unesc = s => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

function when(params, val) {
  if (/VALUE=DATE(?!-)/.test(params) || /^\d{8}$/.test(val)) {
    return { date: `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}` };
  }
  const m = val.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return { dateTime: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) + KST).toISOString().slice(0, 19) + "+09:00" };
  return { dateTime: `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00` };
}

function parse(text) {
  const out = [];
  let cur = null;
  for (const line of unfold(text).split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur && cur.id && cur.start && !cur.cancelled) out.push({ ...cur, end: cur.end || cur.start });
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(";");
      const val = line.slice(i + 1);
      if (name === "UID") cur.id = val.replace(/@google\.com$/, "");
      else if (name === "SUMMARY") cur.summary = unesc(val);
      else if (name === "DESCRIPTION") { const t = unesc(val); cur.extraCal = extraOf(t); cur.crewCal = crewOf(t); cur.hanCal = hanOf(t); Object.assign(cur, settleOf(t)); }
      else if (name === "DTSTART") cur.start = when(params.join(";"), val);
      else if (name === "DTEND") cur.end = when(params.join(";"), val);
      else if (name === "STATUS" && val === "CANCELLED") cur.cancelled = true;
    }
  }
  return out;
}

// Google Calendar API(서비스 계정)로 바로 읽는다. 서비스 계정은 캘린더를 "보기" 권한으로 공유받아야 한다.
const crypto = require("crypto");
let tokenCache = { value: null, exp: 0 };

const b64 = v => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function accessToken(key) {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" });
  const claim = b64({ iss: key.client_email, scope: "https://www.googleapis.com/auth/calendar.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(key.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("token");
  tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return j.access_token;
}

async function fromApi(start, end) {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const cal = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || "primary");
  const q = new URLSearchParams({
    timeMin: `${start}T00:00:00+09:00`, timeMax: `${end}T23:59:59+09:00`,
    singleEvents: "true", orderBy: "startTime", maxResults: "250", timeZone: "Asia/Seoul"
  });
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events?${q}`, {
    headers: { Authorization: `Bearer ${await accessToken(key)}` }
  });
  if (!r.ok) throw new Error(String(r.status));
  const j = await r.json();
  return (j.items || []).filter(e => e.status !== "cancelled" && e.start).map(e => ({ id: e.id, summary: e.summary || "", start: e.start, end: e.end || e.start, extraCal: extraOf(e.description), crewCal: crewOf(e.description), hanCal: hanOf(e.description), ...settleOf(e.description) }));
}

async function fromIcal(start, end) {
  const r = await fetch(process.env.ICAL_URL);
  if (!r.ok) throw new Error(String(r.status));
  return parse(await r.text()).filter(e => {
    const d = (e.start.dateTime || e.start.date).slice(0, 10);
    return d >= start && d <= end;
  });
}

module.exports = async (req, res) => {
  const { start, end } = req.query || {};
  const ymd = /^\d{4}-\d\d-\d\d$/;
  if (!ymd.test(start) || !ymd.test(end)) return res.status(400).json({ error: "bad range" });
  const useApi = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!useApi && !process.env.ICAL_URL) return res.status(503).json({ error: "calendar not configured" });
  try {
    const all = useApi ? await fromApi(start, end) : await fromIcal(start, end);
    const events = all.filter(e => TAGS.some(t => (e.summary || "").includes(t)));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ events, source: useApi ? "api" : "ical" });
  } catch (e) {
    res.status(502).json({ error: "calendar fetch failed" });
  }
};
module.exports.parse = parse;
module.exports.helpers = { extraOf, crewOf, hanOf, settleOf };
