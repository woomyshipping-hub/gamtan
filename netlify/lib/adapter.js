// Netlify Functions(Lambda 형식) 이벤트를 Vercel 형식 (req, res)로 바꿔 api/*.js를 수정 없이 실행한다.
// opts.timeoutMs: 이 시간 안에 핸들러가 끝나지 않으면 opts.timeoutStatus / opts.timeoutBody 로 바로 응답한다.
//   (api/state.js는 Redis 접속 실패 시 node-redis가 재연결을 무한 반복해 함수 제한시간까지 멈춘다.
//    api/*.js는 handoff.json의 sha256 고정이라 여기서 막는다.)
module.exports = (handler, opts = {}) => async (event) => {
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
  let body = event.body;
  if (body && event.isBase64Encoded) body = Buffer.from(body, "base64").toString("utf8");
  if (body && /application\/json/.test(headers["content-type"] || "")) {
    try { body = JSON.parse(body); } catch (e) { body = undefined; }
  }
  const req = { method: event.httpMethod, headers, query: event.queryStringParameters || {}, body };

  const out = { statusCode: 200, headers: {}, body: "" };
  let done = false; // 시간 초과 응답 후 늦게 도착한 쓰기는 무시
  const res = {
    setHeader(k, v) { if (!done) out.headers[k] = v; return res; },
    status(c) { if (!done) out.statusCode = c; return res; },
    json(o) { if (!done) { out.headers["Content-Type"] = "application/json; charset=utf-8"; out.body = JSON.stringify(o); } return res; },
  };

  if (!opts.timeoutMs) { await handler(req, res); return out; }

  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(true), opts.timeoutMs); });
  const late = await Promise.race([Promise.resolve(handler(req, res)).then(() => false), timedOut]);
  clearTimeout(timer);
  done = true;
  if (!late) return out;
  return {
    statusCode: opts.timeoutStatus || 504,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(opts.timeoutBody || { error: "timeout" }),
  };
};
