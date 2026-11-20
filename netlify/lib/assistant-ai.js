// AI 비서: 오늘 브리핑 / 같이 기획하기(대화) / 할 일 쪼개기·초안. Claude API 저가 모델, JSON 형식 출력.
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-haiku-5-5";
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const date = { type: "string", format: "date" };
const SCOPE = { type: "string", enum: ["gamtan", "personal"] };

const SCHEMAS = {
  brief: {
    type: "object", additionalProperties: false, required: ["summary", "picks"],
    properties: {
      summary: { type: "string" },
      picks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "why", "minutes"], properties: { id: { type: "string" }, why: { type: "string" }, minutes: { type: "integer" } } } },
    },
  },
  chat: {
    type: "object", additionalProperties: false, required: ["reply", "plan"],
    properties: {
      reply: { type: "string" },
      plan: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "due_date", "scope"], properties: { title: { type: "string" }, due_date: nullable(date), scope: SCOPE } } },
    },
  },
  help: {
    type: "object", additionalProperties: false, required: ["intro", "steps", "draft"],
    properties: {
      intro: { type: "string" },
      steps: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "due_date"], properties: { title: { type: "string" }, due_date: nullable(date) } } },
      draft: nullable({ type: "string" }),
    },
  },
};

const BASE = `너는 "감탄" 대표(킴)의 AI 비서다.
감탄은 부산·경남 입주청소 업체다. 크린토피아·홈클린마스터(김동현 팀장) 일을 받아 하고, 자체영업으로 직접 고객을 늘리려 한다. 함께 일하는 사람은 김한준님.
대표는 정산·일정·장부·마케팅을 혼자 관리한다. 이 운영 시스템에는 정산(구글 캘린더 기준), 장부, 마케팅(콘텐츠·광고비·문의·수주), AI 비서 화면이 있다.
할 일은 감탄 업무(gamtan)와 개인(personal) 두 가지로 나뉜다.
규칙:
- 한국어, 짧고 구체적으로. 존댓말. 군더더기 인사말 없이 바로 본론.
- 전화번호·가격·고객 정보·실적 같은 사실은 지어내지 않는다. 모르면 대표에게 묻는다.
- 날짜는 한국 시간 기준 YYYY-MM-DD. "다음 주 화요일"처럼 말하면 오늘 날짜로 계산한다.
- 할 일 제목은 동사로 끝나는 한 줄(30자 안팎). 예: "견적 문의 페이지 문구 정하기".`;

const MODE = {
  brief: `지금은 "오늘 브리핑"을 만든다. 아래 열린 할 일 목록에서 오늘 할 일을 최대 3개 골라 순서대로 picks에 넣는다.
- 기한이 지났거나 오늘인 일, 돈이 오가는 일(정산 입금·지급), 남을 기다리게 하는 일을 먼저.
- id는 목록의 [ ] 안 값을 그대로. 목록에 없는 일은 넣지 않는다.
- why: 왜 지금 하는지 한 줄 (예: "정산일 11/19 지남"). minutes: 예상 소요 분.
- summary: 두 문장 이내. 첫 문장은 "오늘 꼭 할 일은 N개입니다." 형식, 둘째 문장은 가장 먼저 할 일과 이유.
- 열린 할 일이 없으면 picks는 빈 배열, summary는 "오늘 정해진 할 일이 없습니다."로 시작해 할 만한 일 하나를 제안한다.`,
  chat: `지금은 "같이 기획하기" 대화다. 대표가 하려는 일·목표·고민을 같이 정리한다.
- reply: 대표에게 할 말. 3~6문장. 계획을 냈으면 이번 주에 할 것이 무엇인지 짚고, 정하기에 꼭 필요한 정보가 비면 질문 하나로 끝낸다.
- plan: 실제 할 일로 옮길 단계가 있을 때만 2~6개. 단순한 질문·잡담이면 빈 배열.
- 각 단계 scope는 내용으로 정한다(감탄 사업이면 gamtan, 개인 생활이면 personal). 애매하면 대표가 고른 "추가할 곳"을 따른다.
- 이미 있는 할 일과 겹치는 단계는 다시 만들지 않는다.`,
  help: `지금은 대표가 할 일 하나에 "도와줘"를 눌렀다. 그 일을 끝내도록 돕는다.
- steps: 바로 실행할 수 있는 단계 2~5개. 이미 있는 하위 단계와 겹치지 않게. 기한은 원래 할 일 기한 안에서 정하고, 모르면 null.
- draft: 문자·카톡·메일·글처럼 써 줄 수 있는 결과물이 있으면 그대로 붙여 쓸 수 있는 초안. 없으면 null.
- intro: 한두 문장으로 어떻게 하면 되는지.`,
};

const label = (s) => (s === "personal" ? "개인" : "감탄");
function taskLines(tasks) {
  if (!tasks.length) return "(열린 할 일 없음)";
  return tasks.slice(0, 60).map((t) => `- [${t.id}] (${label(t.scope)}) ${t.title} · 기한 ${t.due_date || "없음"}${t.notes ? ` · 메모: ${t.notes.replace(/\s+/g, " ").slice(0, 80)}` : ""}`).join("\n");
}

async function call(kind, { client, today, tasks, user, messages }) {
  client = client || new Anthropic();
  const system = `${BASE}\n\n${MODE[kind]}\n\n오늘(한국 시간): ${today}\n열린 할 일:\n${taskLines(tasks)}`;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMAS[kind] } },
    messages: messages || [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal") throw new Error("assistant refused");
  if (res.stop_reason === "max_tokens") throw new Error("assistant truncated");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

module.exports = { call, MODEL, SCHEMAS, BASE, MODE, taskLines };
