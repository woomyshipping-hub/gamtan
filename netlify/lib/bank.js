// 은행 입금 알림 문자/푸시 → { amount, names } 해석과 예약 대조.
// 은행마다 형식이 달라 금액은 "입금" 옆 숫자로, 입금자는 문자 안의 낱말과 예약의 입금자명을 그대로 비교한다
// (이름을 따로 뽑아내지 않는다 → 은행 형식이 바뀌어도 이름이 문자에 들어 있기만 하면 된다).
// 예 (실제 형식을 따르되 값은 지어낸 것):
//   [KB]11/14 13:05\n123456**789\n홍길동\n입금\n50,000\n잔액1,234,567
//   신한 11/14 13:05 110-***-123456 입금 50,000 잔액 1,234,567 홍길동
//   홍길동님이 50,000원을 입금했어요
//   농협 입금50,000원 11/14 13:05 302-****-1234-11 홍길동 잔액1,234,567원

const num = (s) => +String(s).replace(/,/g, "");
const AMOUNT = "(\\d{1,3}(?:,\\d{3})+|\\d{4,9})";

function parseDeposit(text) {
  const t = String(text || "");
  if (!/입금/.test(t) || /출금|입금\s*취소|이체\s*취소|입금\s*예정|입금\s*요청/.test(t)) return null;
  // 잔액 숫자는 지운 뒤 찾는다
  const s = t.replace(new RegExp(`잔액\\s*[:：]?\\s*${AMOUNT}\\s*원?`, "g"), " ");
  const pats = [
    new RegExp(`입금(?:액|금액)?\\s*[:：]?\\s*${AMOUNT}\\s*원?`),       // 입금 50,000원 / 입금\n50,000
    new RegExp(`${AMOUNT}\\s*원\\s*(?:이|을|를)?\\s*입금`),             // 50,000원을 입금했어요
    new RegExp(`${AMOUNT}\\s*원[^\\n]{0,20}\\n?[^\\n]{0,10}입금`),      // 50,000원 … 입금
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) {
      const amount = num(m[1]);
      if (amount >= 1000 && amount <= 1e8) return { amount };
    }
  }
  return null;
}

// 문자 안의 낱말 (이름 비교용): 공백·기호로 자르고 "님이/님께서/님" 같은 꼬리를 뗀다
function tokens(text) {
  return String(text || "")
    .split(/[\s,./:：|()\[\]<>{}→←\-*~!?'"·]+/)
    .map((w) => w.replace(/(님께서|님이|님으로부터|님|씨)$/, ""))
    .filter((w) => w && !/^\d+$/.test(w));
}
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

// 입금자명이 문자에 있는가: 낱말이 정확히 같거나, 은행이 앞부분만 보여 준 경우(4자 이상 잘림)
function nameIn(text, name) {
  const n = norm(name);
  if (n.length < 2) return false;
  return tokens(text).some((w) => { const x = norm(w); return x === n || (x.length >= 4 && n.length > x.length && n.startsWith(x)); });
}

// 계좌 확인: 설정한 글자(계좌 끝자리 등) 중 하나가 문자에 있어야 한다. 설정이 없으면 통과
function accountOk(text, matchList) {
  if (!Array.isArray(matchList) || !matchList.length) return true;
  const t = norm(text);
  return matchList.some((m) => t.includes(norm(m)));
}

// 후보 예약 중에서 고른다: 입금자명이 있고, 금액이 예약금 이상·총액 이하.
// 둘 이상이면 금액이 예약금과 정확히 같은 쪽, 그래도 둘 이상이면 판단하지 않는다(ambiguous).
function pick(text, amount, candidates) {
  const hits = candidates.filter((b) => nameIn(text, b.depositor_name) && amount >= b.deposit && amount <= Math.max(b.total, b.deposit));
  if (hits.length <= 1) return { booking: hits[0] || null, ambiguous: false };
  const exact = hits.filter((b) => b.deposit === amount);
  if (exact.length === 1) return { booking: exact[0], ambiguous: false };
  return { booking: null, ambiguous: true, count: hits.length };
}

module.exports = { parseDeposit, tokens, nameIn, accountOk, pick, norm };
