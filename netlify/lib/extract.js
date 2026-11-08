// 메시지 원문 → 일정 초안 추출 (Claude API, 저가 모델). PRD: 단순 작업(카톡 해석)은 저가 모델.
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-haiku-5-5";
const nullable = (t) => ({ anyOf: [{ type: t }, { type: "null" }] });

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
        required: ["index", "is_schedule", "work_date", "ampm", "address", "area_py", "options", "amount", "customer_phone", "notes"],
        properties: {
          index: { type: "integer" },
          is_schedule: { type: "boolean" },
          work_date: nullable("string"),
          ampm: { anyOf: [{ type: "string", enum: ["오전", "오후"] }, { type: "null" }] },
          address: nullable("string"),
          area_py: nullable("number"),
          options: { type: "array", items: { type: "string" } },
          amount: nullable("integer"),
          customer_phone: nullable("string"),
          notes: nullable("string"),
        },
      },
    },
  },
};

const SYSTEM = `너는 부산·경남 입주청소 업체 "감탄"의 일정 비서다.
팀장님이 카카오톡으로 보낸 메시지에서 청소 일정을 뽑아 일정 초안을 만든다. 대표가 확인한 뒤 등록하므로, 확실하지 않은 값은 지어내지 말고 null로 둔다.

각 메시지마다 items에 하나씩, 같은 index로 답한다.
- is_schedule: 새 청소 일정(또는 기존 일정의 날짜·주소·평수·금액 변경)을 알리는 메시지면 true. 인사, 잡담, 사진 설명, 확인 답장은 false.
- work_date: 작업 날짜 YYYY-MM-DD. "내일", "다음주 화요일", "11/20"처럼 상대적이거나 연도가 없으면 메시지 보낸 시각(한국 시간) 기준으로 계산한다.
- ampm: "오전" 또는 "오후". 시각만 있으면 13시 전은 오전, 이후는 오후.
- address: 메시지에 적힌 주소 그대로 (아파트명, 동·호수 포함).
- area_py: 평수 숫자. "34평", "34py" → 34. 제곱미터만 있으면 3.3으로 나눠 소수 첫째 자리까지.
- options: 추가 작업 (예: 베란다, 줄눈, 새집증후군, 곰팡이, 피톤치드, 확장형). 없으면 빈 배열.
- amount: 메시지에 적힌 금액(원 단위 정수). "35만" → 350000. 없으면 null.
- customer_phone: 고객 전화번호. 없으면 null.
- notes: 대표가 확인해야 할 애매한 점을 한국어 한 문장으로. 없으면 null.`;

const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);

// messages: [{ index, sender, sent_at, text }] → { items, usage }
async function extract(messages, { client, now = new Date() } = {}) {
  client = client || new Anthropic();
  const body = messages
    .map((m) => `[${m.index}] 보낸 시각(한국): ${m.sent_at ? kst(m.sent_at) : kst(now.toISOString())} / 보낸 사람: ${m.sender || "알 수 없음"}\n${m.text}`)
    .join("\n\n");
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `오늘(한국 시간): ${kst(now.toISOString()).slice(0, 10)}\n\n${body}` }],
  });
  if (res.stop_reason === "refusal") throw new Error("extract refused" + (res.stop_details?.category ? `: ${res.stop_details.category}` : ""));
  if (res.stop_reason === "max_tokens") throw new Error("extract truncated (max_tokens)");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = JSON.parse(text);
  return { items: out.items, usage: res.usage };
}

module.exports = { extract, MODEL, SCHEMA, SYSTEM };
