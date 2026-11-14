// 구글 캘린더 쓰기 (서비스 계정). 서비스 계정은 캘린더를 "일정 변경" 권한으로 공유받아야 한다.
// api/events.js(읽기 전용, sha256 고정)와 같은 환경변수: GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID
const { serviceToken } = require("./google");

const OWN_TAGS = ["[자체영업]", "[홈클린마스터]"];

// 정산 페이지와 같은 규칙: 제목에 (오전)/(오후)가 있으면 그것, 없으면 시작 시각 13시 전이면 오전
function ampmOf(ev) {
  const s = ev.summary || "";
  if (s.includes("(오전)")) return "오전";
  if (s.includes("(오후)")) return "오후";
  const t = ev.start && ev.start.dateTime;
  return t ? (+t.slice(11, 13) < 13 ? "오전" : "오후") : null;
}

// 메모의 "추가금: N원" 줄을 바꾸거나 맨 위에 넣는다 (정산 페이지 extraOf가 읽는 형식)
function withExtra(description, amount, note) {
  const line = `추가금: ${amount.toLocaleString("ko-KR")}원 (카톡 보고${note ? `: ${note}` : ""})`;
  const lines = (description || "").split("\n").filter((l) => !/^\s*추가금\s*[:：]/.test(l));
  return [line, ...lines].join("\n").replace(/\n+$/, "");
}

function makeCalendar(env, fetchImpl) {
  const key = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const cal = encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");
  const base = `https://www.googleapis.com/calendar/v3/calendars/${cal}/events`;
  let token = null;

  async function auth() {
    token = token || (await serviceToken(key, "https://www.googleapis.com/auth/calendar.events", fetchImpl));
    return token;
  }

  async function call(url, opt = {}) {
    const r = await fetchImpl(url, { ...opt, headers: { Authorization: `Bearer ${await auth()}`, "Content-Type": "application/json", ...(opt.headers || {}) } });
    if (!r.ok) throw new Error(`google calendar ${r.status}`);
    return r.json();
  }

  return {
    // 그날 자체영업/홈클린마스터 일정 (취소 제외)
    async ownEventsOn(date) {
      const q = new URLSearchParams({ timeMin: `${date}T00:00:00+09:00`, timeMax: `${date}T23:59:59+09:00`, singleEvents: "true", maxResults: "50", timeZone: "Asia/Seoul" });
      const j = await call(`${base}?${q}`);
      return (j.items || []).filter((e) => e.status !== "cancelled" && OWN_TAGS.some((t) => (e.summary || "").includes(t)));
    },
    insert: (event) => call(base, { method: "POST", body: JSON.stringify(event) }),
    patch: (id, body) => call(`${base}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
    // 그날 모든 일정 (취소 제외)
    async eventsOn(date) {
      const q = new URLSearchParams({ timeMin: `${date}T00:00:00+09:00`, timeMax: `${date}T23:59:59+09:00`, singleEvents: "true", maxResults: "100", timeZone: "Asia/Seoul" });
      return ((await call(`${base}?${q}`)).items || []).filter((e) => e.status !== "cancelled");
    },
    // 기간 안 모든 일정 (취소 제외). start·end는 YYYY-MM-DD, end 포함
    async eventsBetween(start, end) {
      const out = [];
      let pageToken = "";
      for (let i = 0; i < 5; i++) {
        const q = new URLSearchParams({ timeMin: `${start}T00:00:00+09:00`, timeMax: `${end}T23:59:59+09:00`, singleEvents: "true", maxResults: "250", timeZone: "Asia/Seoul" });
        if (pageToken) q.set("pageToken", pageToken);
        const j = await call(`${base}?${q}`);
        out.push(...(j.items || []).filter((e) => e.status !== "cancelled"));
        if (!(pageToken = j.nextPageToken)) break;
      }
      return out;
    },
    // 글자 검색 (주문번호 찾기): 지난 120일 ~ 앞으로 365일
    async search(text) {
      const now = Date.now();
      const q = new URLSearchParams({ q: text, timeMin: new Date(now - 120 * 864e5).toISOString(), timeMax: new Date(now + 365 * 864e5).toISOString(), singleEvents: "true", maxResults: "50" });
      return ((await call(`${base}?${q}`)).items || []).filter((e) => e.status !== "cancelled");
    },
    patchDescription: (id, description) => call(`${base}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ description }) }),
  };
}

module.exports = { makeCalendar, ampmOf, withExtra, OWN_TAGS };
