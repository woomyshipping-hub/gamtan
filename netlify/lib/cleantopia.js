// 크린토피아 문자(아이폰 자동화 → endrmsakdmf 메일 → Apps Script → /api/inbox) → 정산 캘린더.
// 문자 형식이 정해져 있어 AI 없이 규칙으로 읽는다. 형식 예 (2026-10 캘린더에 남은 원문 기준):
//   [크린토피아 주문 배정] / [크린토피아 주문 변경] / [크린토피아 청소 2일전] / (취소) …
//   ○주문번호: 2026092600026  ●연락처: 01073890055  ●일시: 2026-10-17 / 오후
//   ●주소: 부산 북구 …  ●종류: 리모델링 청소, 34평, 아파트, …  ●포함옵션: …  ●특이사항: …
const TAG = "[크린토피아]";

const one = (text, re) => { const m = text.match(re); return m ? m[1].trim() : null; };
// "●포함옵션:\n, 피톤치드\n●특이사항:" 처럼 여러 줄 값
const block = (text, name) => {
  const m = text.match(new RegExp(`[○●]?\\s*${name}\\s*[:：]([\\s\\S]*?)(?=\\n\\s*[○●]|\\n-{3,}|\\n<|$)`));
  if (!m) return null;
  const v = m[1].split("\n").map((l) => l.replace(/^[\s,]+|[\s,]+$/g, "")).filter(Boolean).join(" / ");
  return v || null;
};

function typeOf(text) {
  if (/크린토피아[^\]\n]*취소/.test(text) || /주문(이)?\s*취소/.test(text)) return "cancel";
  if (/크린토피아[^\]\n]*변경/.test(text)) return "change";
  if (/크린토피아[^\]\n]*2일\s*전/.test(text)) return "remind";
  if (/크린토피아[^\]\n]*배정/.test(text)) return "assign";
  return null;
}

// "부산 동래구 낙민동…" → "동래구", "경남 창원시 진해구…" → "창원 진해구", "경남 양산시…" → "양산", "울산 울주군…" → "울주군"
function regionOf(address) {
  const w = String(address || "").trim().split(/\s+/);
  if (!w.length || !w[0]) return null;
  const metro = /^(부산|울산|대구|서울|인천|광주|대전)/.test(w[0]);
  if (metro) return w[1] && /(구|군)$/.test(w[1]) ? w[1] : w[0];
  const si = w.find((x) => /시$/.test(x));
  if (si) {
    const i = w.indexOf(si), gu = w[i + 1] && /구$/.test(w[i + 1]) ? w[i + 1] : null;
    return [si.replace(/시$/, ""), gu].filter(Boolean).join(" ");
  }
  const gun = w.find((x) => /군$/.test(x));
  return gun || w[1] || w[0];
}

function parseCrin(text) {
  const t = String(text || "").replace(/\r/g, "");
  const type = typeOf(t);
  if (!type) return null;
  const d = t.match(/일시\s*[:：]\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})\s*\/?\s*(오전|오후)?/);
  const kind = one(t, /종류\s*[:：]\s*([^\n]+)/);
  const py = kind ? +(kind.match(/(\d+)\s*평/) || [])[1] || null : null;
  const building = kind ? ((kind.match(/아파트|오피스텔|빌라|주택|원룸|상가|사무실/) || [])[0] || null) : null;
  const phone = one(t, /연락처\s*[:：]\s*([\d-]{9,})/);
  return {
    type,
    order: one(t, /주문번호\s*[:：]\s*(\d{8,})/),
    phone: phone ? phone.replace(/-/g, "") : null,
    date: d ? `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}` : null,
    ampm: d && d[4] ? d[4] : null,
    address: one(t, /주소\s*[:：]\s*([^\n]+)/),
    kind,
    py,
    building,
    options: block(t, "포함옵션"),
    notes: block(t, "특이사항"),
    raw: t.trim(),
  };
}

const kstDay = (iso) => new Date(new Date(iso || Date.now()).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const md = (ymd) => `${+ymd.slice(5, 7)}/${+ymd.slice(8, 10)}`;
// 기존 크린토피아 일정과 같은 시간: 오전 08–13시, 오후 14–19시
const slot = (date, ampm) => ampm === "오전"
  ? { start: { dateTime: `${date}T08:00:00+09:00`, timeZone: "Asia/Seoul" }, end: { dateTime: `${date}T13:00:00+09:00`, timeZone: "Asia/Seoul" } }
  : { start: { dateTime: `${date}T14:00:00+09:00`, timeZone: "Asia/Seoul" }, end: { dateTime: `${date}T19:00:00+09:00`, timeZone: "Asia/Seoul" } };
const titleOf = (p) => [TAG, regionOf(p.address) || "지역확인", p.py ? `${p.py}평` : null, p.building || "아파트", `(${p.ampm})`].filter(Boolean).join(" ");

function crinEvent(p, row) {
  const desc = [
    p.phone ? `연락처: ${p.phone}` : null,
    p.kind ? `종류: ${p.kind}` : null,
    p.options ? `포함옵션: ${p.options}` : null,
    p.notes ? `특이사항: ${p.notes}` : null,
    p.py ? null : "평수: 확인 필요",
    `주문번호: ${p.order}`,
    "---",
    `[자동 등록] 원문 (${md(kstDay(row.sent_at))} 주문 배정 문자):`,
    p.raw,
  ].filter((x) => x !== null).join("\n");
  return { summary: titleOf(p), description: desc, location: p.address || undefined, colorId: "5", ...slot(p.date, p.ampm) };
}

// 메모에서 "이름: 값" 줄을 바꾸거나(없으면 위쪽 묶음 끝에) 넣는다
function setLine(desc, name, value) {
  const lines = String(desc || "").split("\n");
  const i = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*[:：]`).test(l));
  if (i >= 0) lines[i] = `${name}: ${value}`;
  else { const sep = lines.indexOf("---"); lines.splice(sep >= 0 ? sep : lines.length, 0, `${name}: ${value}`); }
  return lines.join("\n");
}

async function findByOrder(cal, order) {
  if (!order) return null;
  const list = await cal.search(order);
  return list.find((e) => (e.summary || "").includes(TAG) && (e.description || "").includes(order)) || null;
}

// 결과: { state, error?, gcal_event_id? } — inbox_messages.state 값
async function applyCrin(cal, p, row) {
  if (p.type === "assign") {
    if (!p.order || !p.date || !p.ampm) return { state: "unmatched", error: "주문번호·일시를 찾지 못함" };
    const ex = await findByOrder(cal, p.order);
    if (ex) return { state: "duplicate", gcal_event_id: ex.id };
    const created = await cal.insert(crinEvent(p, row));
    return { state: "created", gcal_event_id: created.id };
  }

  if (p.type === "change") {
    const ex = await findByOrder(cal, p.order);
    if (!ex) {
      if (!p.order || !p.date || !p.ampm) return { state: "unmatched", error: "변경할 주문을 찾지 못함" };
      const created = await cal.insert(crinEvent(p, row)); // 배정 문자를 놓친 경우: 변경 문자로 새로 만든다
      return { state: "created", gcal_event_id: created.id };
    }
    const oldDate = (ex.start.dateTime || ex.start.date || "").slice(0, 10);
    const oldAmpm = (ex.summary || "").includes("(오전)") ? "오전" : "오후";
    const date = p.date || oldDate, ampm = p.ampm || oldAmpm;
    let desc = ex.description || "";
    if (p.phone) desc = setLine(desc, "연락처", p.phone);
    if (p.kind) desc = setLine(desc, "종류", p.kind);
    if (p.options) desc = setLine(desc, "포함옵션", p.options);
    if (p.notes) desc = setLine(desc, "특이사항", p.notes);
    const moved = date !== oldDate || ampm !== oldAmpm;
    desc = desc.replace(/\n---\n|$/, `\n변경 이력: ${moved ? `${oldDate} ${oldAmpm} → ${date} ${ampm}` : `일시 동일 (${date} ${ampm})`} (${md(kstDay(row.sent_at))} 변경 문자)$&`);
    desc += `\n---\n[변경 문자 원문 ${md(kstDay(row.sent_at))}]:\n${p.raw}`;
    const patch = { description: desc, ...(moved ? slot(date, ampm) : {}) };
    patch.summary = titleOf({ ...p, ampm, address: p.address || ex.location, py: p.py || +((ex.summary || "").match(/(\d+)\s*평/) || [])[1] || null, building: p.building || ((ex.summary || "").match(/아파트|오피스텔|빌라|주택|원룸|상가|사무실/) || [])[0] });
    if ((ex.summary || "").includes("취소확인")) patch.summary += " 취소확인";
    if (p.address) patch.location = p.address;
    await cal.patch(ex.id, patch);
    return { state: "updated", gcal_event_id: ex.id };
  }

  if (p.type === "cancel") {
    const ex = await findByOrder(cal, p.order);
    if (!ex) return { state: "unmatched", error: "취소할 주문을 찾지 못함" };
    if (!(ex.summary || "").includes("취소확인")) await cal.patch(ex.id, { summary: `${ex.summary} 취소확인`, description: `${ex.description || ""}\n---\n[취소 문자 원문 ${md(kstDay(row.sent_at))}]:\n${p.raw}` });
    return { state: "updated", gcal_event_id: ex.id };
  }

  // 2일전 알림: 받은 날 20:00 "☎️ 고객 연락" 일정 (정산에는 안 잡힘). 본 일정 메모에 수신 표시.
  if (p.type === "remind") {
    let ex = await findByOrder(cal, p.order);
    if (!ex && p.date) {
      const day = await cal.eventsOn(p.date);
      const addr = String(p.address || "").replace(/\s/g, "").slice(0, 12);
      ex = day.find((e) => (e.summary || "").includes(TAG) && (!p.ampm || (e.summary || "").includes(`(${p.ampm})`)) && (!addr || String(e.location || e.description || "").replace(/\s/g, "").includes(addr))) || null;
    }
    const got = kstDay(row.sent_at);
    const label = ex ? (ex.summary || "").replace(TAG, "").replace(/\((오전|오후)\)/, "").trim() : (regionOf(p.address) || "고객");
    const when = p.date ? `${md(p.date)} ${p.ampm || ""}`.trim() : "";
    const remindTitle = `☎️ 크린토피아 고객 연락 – ${label}${when ? ` (${when})` : ""}`;
    const existing = (await cal.eventsOn(got)).find((e) => (e.summary || "") === remindTitle);
    if (!existing) {
      await cal.insert({
        summary: remindTitle, colorId: "5",
        description: [p.phone ? `연락처: ${p.phone}` : null, "", "고객 연락 시 확인사항", "1) \"크린토피아 청소팀장 입니다~\" 인사로 시작", "2) 출입방법 체크", "3) 취소/변경 위약금 안내(서비스 전날 30%, 당일 50%)", p.order ? `\n주문번호: ${p.order}` : null].filter((x) => x !== null).join("\n"),
        start: { dateTime: `${got}T20:00:00+09:00`, timeZone: "Asia/Seoul" }, end: { dateTime: `${got}T20:15:00+09:00`, timeZone: "Asia/Seoul" },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
      });
    }
    if (ex && !(ex.description || "").includes(`2일전 알림 수신(${md(got)})`)) {
      const lines = String(ex.description || "").split("\n"), sep = lines.indexOf("---");
      lines.splice(sep >= 0 ? sep : lines.length, 0, `☎️ 2일전 알림 수신(${md(got)}) – 고객 연락 필요`);
      await cal.patch(ex.id, { description: lines.join("\n") });
    }
    return { state: ex ? "updated" : "unmatched", gcal_event_id: ex ? ex.id : undefined, error: ex ? undefined : "본 일정을 찾지 못함 (연락 알림만 등록)" };
  }
  return { state: "ignored" };
}

module.exports = { parseCrin, applyCrin, regionOf, crinEvent, TAG };
