// 감탄 예약 견적 계산 (고객 예약 페이지 /reserve/ 와 서버 /api/booking 이 같은 코드를 쓴다. 금액 기준은 서버 계산).
// 단가·포함 개수·지역 출장비·예약금은 관리 화면(/bookings/)에서 바꾸며 Supabase app_settings 'booking_config'에 저장된다.
// 아래 DEFAULTS는 설정이 아직 없을 때 쓰는 값이다. 실제 요금은 대표가 관리 화면에서 확정한다.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.GamtanQuote = m;
})(typeof self !== "undefined" ? self : this, function () {
  const DEFAULTS = {
    per_py: 12000,            // 평당 요금 (PRD: 1만~1.3만 원 구간 테스트)
    min_total: 150000,        // 최소 금액 (작은 평수)
    min_py: 5,
    max_py: 60,               // 넘으면 온라인 예약 대신 상담
    included: { rooms: 3, baths: 2, verandas: 2 },     // 기본 요금에 포함된 개수
    extra: { rooms: 20000, baths: 30000, verandas: 20000 }, // 넘는 1개당 추가 요금
    regions: [
      { name: "부산", fee: 0 }, { name: "창원", fee: 0 }, { name: "김해", fee: 0 }, { name: "양산", fee: 0 },
      { name: "울산", fee: 0 }, { name: "거제", fee: 0 }, { name: "진주", fee: 0 }, { name: "밀양", fee: 0 },
      { name: "통영", fee: 0 }, { name: "함안", fee: 0 }, { name: "경남 기타", fee: 0 },
    ],
    buildings: ["아파트", "오피스텔", "빌라", "주택", "원룸"],
    round_to: 1000,
    deposit: 50000,           // 예약금 (총액보다 크면 총액)
    hold_minutes: 120,        // 입금 대기 시간. 지나면 날짜가 다시 열린다
    lead_days: 2,             // 오늘 + N일부터 예약 가능
    max_days: 60,             // 오늘부터 N일 뒤까지
    slot_mode: "day",         // "day": 일정이 있는 날은 하루 전체 마감 / "ampm": 오전·오후 따로
    closed_weekdays: [],      // 0=일 … 6=토
    notice: "",               // 예약 페이지 안내 문구 (환불 규정 등)
    contact_phone: "",        // 예약 페이지에 보일 전화번호 (실제 번호만)
    // 아래는 고객에게 설정으로 내려보내지 않는다. 계좌는 예약 신청 뒤에만 보여 준다.
    account: { bank: "", number: "", holder: "" },
    account_match: [],        // 입금 문자에 이 글자 중 하나가 있어야 인정 (예: 계좌 끝자리). 비우면 확인 안 함
  };
  const KEYS = [["rooms", "방"], ["baths", "화장실"], ["verandas", "베란다"]];
  const LIMITS = { rooms: [1, 10], baths: [1, 6], verandas: [0, 6] };

  const isInt = (v) => Number.isInteger(v);
  const roundUp = (n, unit) => (unit > 1 ? Math.ceil(n / unit) * unit : Math.round(n));

  // 설정 병합: 저장된 값 중 형식이 맞는 것만 base(기본 DEFAULTS) 위에 덮는다
  function merge(saved, base) {
    const s = saved && typeof saved === "object" ? saved : {};
    const out = JSON.parse(JSON.stringify(base || DEFAULTS));
    const num = (k, lo, hi) => { if (isInt(s[k]) && s[k] >= lo && s[k] <= hi) out[k] = s[k]; };
    num("per_py", 0, 1e6); num("min_total", 0, 1e8); num("min_py", 1, 200); num("max_py", 1, 200);
    num("round_to", 1, 1e5); num("deposit", 0, 1e8); num("hold_minutes", 10, 7 * 1440);
    num("lead_days", 0, 60); num("max_days", 1, 365);
    for (const [k] of KEYS) {
      if (s.included && isInt(s.included[k]) && s.included[k] >= 0 && s.included[k] <= 20) out.included[k] = s.included[k];
      if (s.extra && isInt(s.extra[k]) && s.extra[k] >= 0 && s.extra[k] <= 1e6) out.extra[k] = s.extra[k];
    }
    if (Array.isArray(s.regions)) {
      const r = s.regions.filter((x) => x && typeof x.name === "string" && x.name.trim() && isInt(x.fee) && x.fee >= 0 && x.fee <= 1e6)
        .map((x) => ({ name: x.name.trim().slice(0, 20), fee: x.fee }));
      if (r.length) out.regions = r.slice(0, 40);
    }
    if (Array.isArray(s.buildings)) {
      const b = s.buildings.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 10));
      if (b.length) out.buildings = b.slice(0, 12);
    }
    if (s.slot_mode === "day" || s.slot_mode === "ampm") out.slot_mode = s.slot_mode;
    if (Array.isArray(s.closed_weekdays)) out.closed_weekdays = [...new Set(s.closed_weekdays.filter((d) => isInt(d) && d >= 0 && d <= 6))];
    if (typeof s.notice === "string") out.notice = s.notice.slice(0, 1000);
    if (typeof s.contact_phone === "string") out.contact_phone = s.contact_phone.slice(0, 20);
    if (s.account && typeof s.account === "object") for (const k of ["bank", "number", "holder"]) if (typeof s.account[k] === "string") out.account[k] = s.account[k].trim().slice(0, 40);
    if (Array.isArray(s.account_match)) out.account_match = s.account_match.filter((x) => typeof x === "string" && x.trim().length >= 3).map((x) => x.trim().slice(0, 30)).slice(0, 5);
    if (out.min_py > out.max_py) out.min_py = DEFAULTS.min_py;
    return out;
  }

  // input: { area_py, rooms, baths, verandas, region, building }
  // → { ok, reason?, lines:[{label, amount}], total, deposit, balance }
  function quote(input, cfg) {
    const c = cfg || DEFAULTS;
    const fail = (reason) => ({ ok: false, reason, lines: [], total: 0, deposit: 0, balance: 0 });
    const py = Number(input && input.area_py);
    if (!isInt(py) || py < c.min_py) return fail(`평수는 ${c.min_py}평 이상 정수로 입력해 주세요`);
    if (py > c.max_py) return fail(`${c.max_py}평이 넘는 집은 전화로 견적을 안내해 드립니다`);
    const region = (c.regions || []).find((r) => r.name === (input && input.region));
    if (!region) return fail("지역을 골라 주세요");
    if (!(c.buildings || []).includes(input && input.building)) return fail("건물 유형을 골라 주세요");
    const lines = [{ label: `기본 ${py}평 × ${c.per_py.toLocaleString("ko-KR")}원`, amount: py * c.per_py }];
    for (const [k, name] of KEYS) {
      const n = Number(input[k]);
      const [lo, hi] = LIMITS[k];
      if (!isInt(n) || n < lo || n > hi) return fail(`${name} 개수를 확인해 주세요`);
      const over = n - c.included[k];
      if (over > 0 && c.extra[k] > 0) lines.push({ label: `${name} 추가 ${over}개 (기본 ${c.included[k]}개 포함)`, amount: over * c.extra[k] });
    }
    if (region.fee > 0) lines.push({ label: `출장비 (${region.name})`, amount: region.fee });
    let sum = lines.reduce((a, l) => a + l.amount, 0);
    if (sum < c.min_total) { lines.push({ label: "최소 금액 적용", amount: c.min_total - sum }); sum = c.min_total; }
    const total = roundUp(sum, c.round_to);
    if (total !== sum) lines.push({ label: "원 단위 올림", amount: total - sum });
    const deposit = Math.min(c.deposit, total);
    return { ok: true, lines, total, deposit, balance: total - deposit };
  }

  // 고객에게 보여 줄 설정 (계좌·대조용 값은 빼고)
  function publicConfig(c) {
    const { per_py, min_total, min_py, max_py, included, extra, regions, buildings, round_to, deposit, hold_minutes, lead_days, max_days, slot_mode, closed_weekdays, notice, contact_phone } = c;
    return { per_py, min_total, min_py, max_py, included, extra, regions, buildings, round_to, deposit, hold_minutes, lead_days, max_days, slot_mode, closed_weekdays, notice, contact_phone };
  }

  return { DEFAULTS, LIMITS, merge, quote, publicConfig };
});
