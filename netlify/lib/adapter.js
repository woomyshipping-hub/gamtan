// Netlify Functions(Lambda 형식) 이벤트를 Vercel 형식 (req, res)로 바꿔 api/*.js를 수정 없이 실행한다.
module.exports = (handler) => async (event) => {
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
  let body = event.body;
  if (body && event.isBase64Encoded) body = Buffer.from(body, "base64").toString("utf8");
  if (body && /application\/json/.test(headers["content-type"] || "")) {
    try { body = JSON.parse(body); } catch (e) { body = undefined; }
  }
  const req = { method: event.httpMethod, headers, query: event.queryStringParameters || {}, body };

  const out = { statusCode: 200, headers: {}, body: "" };
  const res = {
    setHeader(k, v) { out.headers[k] = v; return res; },
    status(c) { out.statusCode = c; return res; },
    json(o) { out.headers["Content-Type"] = "application/json; charset=utf-8"; out.body = JSON.stringify(o); return res; },
  };
  await handler(req, res);
  return out;
};
