// 카톡 메시지 원문 → 일정/추가금 추출 (Claude API, 저가 모델). PRD: 단순 작업(카톡 해석)은 저가 모델.
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-haiku-5-5";
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const str = { type: "string" };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "kind", "work_date", "ampm", "start_time", "address", "region", "area_py", "building", "customer_phone", "notes", "extra_amount"],
        properties: {
          index: { type: "integer" },
          kind: { type: "string", enum: ["schedule", "extra", "other"] },
          work_date: nullable({ type: "string", format: "date" }),
          ampm: nullable({ type: "string", enum: ["오전", "오후"] }),
          start_time: nullable(str),
          address: nullable(str),
          region: nullable(str),
          area_py: nullable({ type: "number" }),
          building: nullable({ type: "string", enum: ["아파트", "오피스텔", "원룸", "빌라", "주택", "상가", "사무실"] }),
          customer_phone: nullable(str),
          notes: nullable(str),
          extra_amount: nullable({ type: "integer" }),
        },
      },
    },
  },
};

const SYSTEM = `너는 부산·경남 입주청소 업체 "감탄"의 일정 비서다.
원청 팀장님과 대표가 주고받는 카카오톡 메시지를 하나씩 읽고 분류한다. 메시지마다 items에 같은 index로 하나씩 답한다.

kind 분류:
- "schedule": 팀장님이 보낸 새 청소 일정. 보통 주소·연락처·날짜·시간 항목이 있고 "6일건", "내일 월요일건" 같은 머리말이 붙는다.
- "extra": 작업을 마친 뒤 보내는 추가금 보고. 예: "오전 추가 없습니다", "오후 추가 7만원있습니다".
- "other": 그 밖의 모든 것 (가능 날짜 묻기, 인사, 잡담, 확인 답장, 사진 설명).

schedule일 때:
- work_date: YYYY-MM-DD. "11월 6일", "11.09", "내일", "6일건"처럼 연도가 없거나 상대적이면 메시지 보낸 시각(한국 시간) 기준으로 계산한다. 이미 지난 날짜가 되면 다음 달/다음 해로 본다.
- ampm: "오전"/"오후". 시각만 있으면 13시 전은 오전, 13시부터 오후.
- start_time: 시작 시각을 "HH:MM" 24시간제로. "오후 1시 또는 1시 반"처럼 여러 개면 가장 이른 시각(13:00). 시각이 없으면 null.
- address: 주소 그대로 (동·호수·아파트명 포함).
- region: 일정 제목에 쓸 짧은 지역. 시 이름에서 "시"를 빼고 구/군 또는 동까지. 예: "창원시 마산합포구 현동" → "창원 마산합포구", "창원시 회원동"(구 없음) → "창원 회원동", "부산 해운대구 우동" → "해운대구", "김해시 장유동" → "김해 장유동".
- area_py: 평수 숫자. 없으면 null (추측하지 않는다).
- building: 아파트·오피스텔·원룸·빌라·주택·상가·사무실 중 하나. 아파트명(○○아파트, 이편한세상, 푸르지오, 자이 등)이면 "아파트". 모르면 null.
- customer_phone: 고객 연락처 "010-1234-5678" 형식으로.
- notes: 참고사항·특이사항(출입 방법, 이사 시간, 상태 등)을 한 줄로. 없으면 null.
- extra_amount: null.

extra일 때:
- work_date: 메시지 보낸 날짜(한국 시간). 다른 날짜를 말하면 그 날짜.
- ampm: 메시지에 오전/오후가 있으면 그 값, 없으면 null.
- extra_amount: 원 단위 정수. "7만원" → 70000, "추가 없습니다" → 0.
- notes: 함께 적힌 특이사항이 있으면 한 줄로, 없으면 null.
- 나머지 필드는 null.

other일 때: kind 외 모든 필드는 null.
확실하지 않은 값은 지어내지 말고 null로 둔다.`;

const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);

// messages: [{ index, sender, sent_at, text }] → { items, usage }
async function extract(messages, { client, now = new Date() } = {}) {
  client = client || new Anthropic();
  const body = messages
    .map((m) => `[${m.index}] 보낸 시각(한국): ${kst(m.sent_at || now.toISOString())} / 보낸 사람: ${m.sender || "알 수 없음"}\n${m.text}`)
    .join("\n\n");
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `오늘(한국 시간): ${kst(now.toISOString()).slice(0, 10)}\n\n${body}` }],
  });
  if (res.stop_reason === "refusal") throw new Error("extract refused" + (res.stop_details?.category ? `: ${res.stop_details.category}` : ""));
  if (res.stop_reason === "max_tokens") throw new Error("extract truncated (max_tokens)");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { items: JSON.parse(text).items, usage: res.usage };
}

module.exports = { extract, MODEL, SCHEMA, SYSTEM };
