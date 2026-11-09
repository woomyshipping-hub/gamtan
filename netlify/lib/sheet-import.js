// 개인 가계부(구글 시트) "YYYY년 M월 상세" 탭 → 감탄 장부 기록 후보.
// 탭 구조 (2026-11-09 확인): 4행 머리글, 5행부터 데이터
//   B 날짜 | C 금액 | D 설명 | E 카테고리   ← 지출
//   G 날짜 | H 금액 | I 설명 | J 카테고리   ← 수입
//   날짜가 빈 줄은 같은 쪽 윗줄 날짜를 따른다. 금액은 "₩150,150" 형식.
// 어떤 카테고리를 감탄 장부의 어느 분류로 옮길지는 app_settings.ledger_sheet_map(JSON)이 정한다.
//   { "expense": { "변동비_업무_소모품": "세제" }, "income": { "홈크린마스터": "매출" } }
// 매핑에 없는 카테고리는 가져오지 않는다 (개인 지출이 섞이지 않게).
const crypto = require("crypto");

const RANGE_FROM_ROW = 5;
const tabName = (month) => { const [y, m] = month.split("-").map(Number); return `${y}년 ${m}월 상세`; };
const rangeOf = (month) => `'${tabName(month)}'!B${RANGE_FROM_ROW}:J`;

// "2026년  10월 1일", "2026. 10. 1", "2026-10-01" → "2026-10-01"
function parseDate(s) {
  const m = String(s || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}
// "₩150,150", "150,150", "-₩2,000" → 150150 (부호는 무시: 쪽(지출/수입)으로 구분)
function parseAmount(s) {
  const d = String(s || "").replace(/[^\d]/g, "");
  return d ? parseInt(d, 10) : null;
}

// rows: 시트 B5:J 값 → [{ side, date, amount, desc, category }]
function parseRows(rows, month) {
  const out = [];
  const last = { expense: null, income: null };
  for (const r of rows) {
    for (const [side, c] of [["expense", 0], ["income", 5]]) {
      const amount = parseAmount(r[c + 1]);
      const category = String(r[c + 3] || "").trim();
      const d = parseDate(r[c]);
      if (d) last[side] = d;
      if (!amount || !category) continue;
      const date = d || last[side];
      if (!date || date.slice(0, 7) !== month) continue;
      out.push({ side, date, amount, desc: String(r[c + 2] || "").trim().slice(0, 150), category });
    }
  }
  return out;
}

// 같은 날·같은 금액·같은 설명이 여러 줄이어도 각각 다른 키가 되도록 순번을 붙인다
function withKeys(items, month) {
  const seen = new Map();
  return items.map((it) => {
    const base = [month, it.side, it.date, it.amount, it.desc, it.category].join("|");
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...it, import_key: crypto.createHash("sha256").update(base + "|" + n).digest("hex") };
  });
}

function plan(rows, month, map) {
  const items = withKeys(parseRows(rows, month), month);
  const cats = new Map();
  const entries = [];
  for (const it of items) {
    const mapped = (map[it.side] || {})[it.category] || null;
    const k = it.side + "|" + it.category;
    const c = cats.get(k) || { side: it.side, category: it.category, count: 0, sum: 0, mapped_to: mapped };
    c.count++; c.sum += it.amount; cats.set(k, c);
    if (mapped) entries.push({ entry_date: it.date, kind: it.side, category: mapped, amount: it.amount, memo: `${it.desc || it.category} (가계부)`, source: "sheet", import_key: it.import_key });
  }
  const categories = [...cats.values()].sort((a, b) => (a.side === b.side ? b.sum - a.sum : a.side === "income" ? -1 : 1));
  return { entries, categories };
}

module.exports = { tabName, rangeOf, parseDate, parseAmount, parseRows, plan };
