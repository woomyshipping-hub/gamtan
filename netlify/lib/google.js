// 구글 서비스 계정 토큰 (JWT RS256 → OAuth 액세스 토큰). 범위별로 요청한다.
// 환경변수 GOOGLE_SERVICE_ACCOUNT_JSON (api/events.js와 같은 키)
const crypto = require("crypto");

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function serviceToken(key, scope, fetchImpl) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" });
  const claim = b64({ iss: key.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(key.private_key).toString("base64url");
  const r = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("google token " + r.status);
  return j.access_token;
}

// 시트 읽기 전용
function makeSheets(env, fetchImpl) {
  const key = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  let token = null;
  const call = async (url) => {
    token = token || (await serviceToken(key, "https://www.googleapis.com/auth/spreadsheets.readonly", fetchImpl));
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      let reason = "";
      try { reason = (await r.json()).error.message.slice(0, 200); } catch (e) {}
      const err = new Error(`google sheets ${r.status}${reason ? ": " + reason : ""}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  };
  const base = (id) => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;
  return {
    tabs: async (id) => (await call(`${base(id)}?fields=properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`)),
    values: async (id, range) => (await call(`${base(id)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`)).values || [],
  };
}

module.exports = { serviceToken, makeSheets };
